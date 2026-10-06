package core

import (
	"encoding/json"

	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

type StoreInfo struct {
	Path        string `json:"path"`
	SizeBytes   int64  `json:"sizeBytes"`
	RemoteCount int    `json:"remoteCount"`
}

type StoreRemote struct {
	Key    string `json:"key"`
	Remote string `json:"remote"`
}

type StoreFetchResult struct {
	Fetched int                      `json:"fetched"`
	Failed  int                      `json:"failed"`
	Remotes []StoreFetchRemoteResult `json:"remotes"`
}

type StoreFetchRemoteResult struct {
	Key string `json:"key"`
	// Status is "fetched" or "failed".
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	// Detail is the full underlying error for diagnostic output.
	Detail string `json:"detail,omitempty"`
}

type GCResult struct {
	Compacted bool `json:"compacted"`
}

type PruneResult struct {
	ReclaimedBytes int64 `json:"reclaimedBytes"`
}

type DoctorCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type DoctorResult struct {
	// Empty is true when no object pool exists yet; the pool check is then omitted.
	Empty  bool          `json:"empty"`
	Checks []DoctorCheck `json:"checks"`
}

func (c *Client) StoreInfo() StoreInfo {
	path := c.StorePath()
	count := 0
	for _, name := range readDirNames(filepath.Join(path, "remotes")) {
		if strings.HasSuffix(name, ".json") {
			count++
		}
	}
	return StoreInfo{Path: path, SizeBytes: directorySize(path), RemoteCount: count}
}

func (c *Client) ListRemotes() ([]StoreRemote, error) {
	directory := filepath.Join(c.StorePath(), "remotes")
	entries, err := os.ReadDir(directory)
	// Windows reports a file in a directory's place as a missing path; only a truly missing one is empty.
	if err != nil && (!isNotExist(err) || isPresent(directory)) {
		return nil, err
	}
	remotes := []StoreRemote{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		text, err := readText(filepath.Join(directory, name))
		if err != nil {
			return nil, err
		}
		var value map[string]any
		_ = json.Unmarshal([]byte(text), &value)
		key, keyOK := value["key"].(string)
		remote, remoteOK := value["remote"].(string)
		if !keyOK || !remoteOK || remoteID(key)+".json" != name {
			return nil, errorf("Invalid git-dedup remote registration: %s", name)
		}
		remotes = append(remotes, StoreRemote{Key: key, Remote: redactRemote(remote, "***")})
	}
	slices.SortFunc(remotes, func(a, b StoreRemote) int { return strings.Compare(a.Key, b.Key) })
	return remotes, nil
}

var fatalLine = regexp.MustCompile(`fatal: ([^\n\r\x{2028}\x{2029}]+)`)

// Fetch refreshes every registered remote into the pool.
func (c *Client) Fetch() (*StoreFetchResult, error) {
	root := c.StorePath()
	remotes := []StoreFetchRemoteResult{}
	err := c.withLock(root, func() error {
		fetched := false
		for _, name := range readDirNames(filepath.Join(root, "remotes")) {
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			text, err := readText(filepath.Join(root, "remotes", name))
			if err != nil {
				return err
			}
			var value remoteRegistration
			if err := json.Unmarshal([]byte(text), &value); err != nil {
				return errorf("Invalid git-dedup remote registration: %s", name)
			}
			if _, err := c.fetchRemote(root, value.Remote, value.Key, false, false); err != nil {
				reason := "remote fetch failed"
				if m := fatalLine.FindStringSubmatch(err.Error()); m != nil {
					reason = m[1]
				}
				remotes = append(remotes, StoreFetchRemoteResult{Key: value.Key, Status: "failed", Reason: reason, Detail: err.Error()})
				continue
			}
			fetched = true
			remotes = append(remotes, StoreFetchRemoteResult{Key: value.Key, Status: "fetched"})
		}
		if fetched {
			_, err := c.checked([]string{"-C", poolPath(root), "repack", "-d", "--geometric=2"}, "")
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	result := &StoreFetchResult{Remotes: remotes}
	for _, remote := range remotes {
		if remote.Status == "fetched" {
			result.Fetched++
		}
	}
	result.Failed = len(remotes) - result.Fetched
	return result, nil
}

// GC compacts the pool without pruning objects.
func (c *Client) GC() (GCResult, error) {
	root := c.StorePath()
	if !isPresent(poolPath(root)) {
		return GCResult{}, nil
	}
	err := c.withLock(root, func() error {
		_, err := c.checked([]string{"-C", poolPath(root), "gc", "--prune=never"}, "")
		return err
	})
	return GCResult{Compacted: err == nil}, err
}

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// liveTips lists every object a consumer may borrow from the pool without a pin.
func (c *Client) liveTips(commonGitdir string) ([]string, error) {
	refStorage, err := c.git([]string{"--git-dir", commonGitdir, "config", "--get", "extensions.refStorage"}, commonGitdir, captured, nil)
	if err != nil {
		return nil, err
	}
	if trim(refStorage.stdout) != "" {
		return nil, errorf("Refusing to prune: %s uses a ref storage format that git-dedup cannot inspect", commonGitdir)
	}
	tips := map[string]bool{}
	var extra []string
	extraSeen := map[string]bool{}
	gitdirs := []string{commonGitdir}
	for _, name := range readDirNames(filepath.Join(commonGitdir, "worktrees")) {
		gitdirs = append(gitdirs, filepath.Join(commonGitdir, "worktrees", name))
	}
	for _, gitdir := range gitdirs {
		// Per-worktree refs and HEAD, then the index: git add skips blobs the pool already has.
		refs, err := c.checked([]string{"--git-dir", gitdir, "for-each-ref", "--format=%(objectname)"}, gitdir)
		if err != nil {
			return nil, err
		}
		for _, oid := range nonEmpty(splitLines(refs)) {
			tips[oid] = true
		}
		head, err := c.git([]string{"--git-dir", gitdir, "rev-parse", "--verify", "-q", "HEAD"}, gitdir, captured, nil)
		if err != nil {
			return nil, err
		}
		if head.code == 0 {
			tips[trim(head.stdout)] = true
		}
		if isPresent(filepath.Join(gitdir, "index")) {
			tree, err := c.git([]string{"--git-dir", gitdir, "write-tree"}, gitdir, captured, nil)
			if err != nil {
				return nil, err
			}
			if tree.code != 0 {
				return nil, errorf("Refusing to prune: cannot record the index of %s: %s", gitdir, trim(tree.stderr))
			}
			// Git always has the empty tree, so it needs no pin.
			if oid := trim(tree.stdout); oid != emptyTree {
				tips[oid] = true
			}
		}
		for _, oid := range stateOids(gitdir) {
			if !tips[oid] && !extraSeen[oid] {
				extraSeen[oid] = true
				extra = append(extra, oid)
			}
		}
	}
	// rev-list peels annotated tags to commits, so pin state-file tags (and other non-commits) directly.
	if len(extra) > 0 {
		input := strings.Join(extra, "\n") + "\n"
		output, err := c.checkedWith([]string{"--git-dir", commonGitdir, "cat-file", "--batch-check=%(objectname) %(objecttype)"}, commonGitdir, false, &input)
		if err != nil {
			return nil, err
		}
		for _, line := range splitLines(output) {
			oid, kind, _ := strings.Cut(line, " ")
			if kind != "" && kind != "commit" && kind != "missing" {
				tips[oid] = true
			}
		}
	}
	// Commits held only by reflogs or state files; pin the tips of each abandoned history.
	args := append(append([]string{"--git-dir", commonGitdir, "rev-list", "--parents", "--ignore-missing", "--reflog"}, extra...), "--not", "--all")
	abandoned, err := c.checked(args, commonGitdir)
	if err != nil {
		return nil, err
	}
	var commits []string
	parents := map[string]bool{}
	for _, line := range nonEmpty(splitLines(abandoned)) {
		fields := strings.Split(line, " ")
		commits = append(commits, fields[0])
		for _, parent := range fields[1:] {
			parents[parent] = true
		}
	}
	for _, commit := range commits {
		if !parents[commit] {
			tips[commit] = true
		}
	}
	sorted := make([]string, 0, len(tips))
	for oid := range tips {
		sorted = append(sorted, oid)
	}
	slices.Sort(sorted)
	return sorted, nil
}

// Prune reclaims pool objects that no registered checkout uses.
func (c *Client) Prune() (PruneResult, error) {
	root := c.StorePath()
	pool := poolPath(root)
	if !isPresent(pool) {
		return PruneResult{}, nil
	}
	var result PruneResult
	err := c.withLock(root, func() error {
		registry, err := registeredConsumers(root)
		if err != nil {
			return err
		}
		registered := map[string]bool{}
		for _, entry := range registry {
			registered[entry.id] = true
		}
		// A clone between its pool fetch and its pin borrows objects that nothing pins yet.
		for _, name := range readDirNames(filepath.Join(root, "clones")) {
			text, err := readText(filepath.Join(root, "clones", name))
			if err != nil {
				return err
			}
			var marker cloneMarker
			if err := json.Unmarshal([]byte(text), &marker); err != nil {
				return errorf("Invalid git-dedup clone marker: %s", name)
			}
			if processExists(marker.Pid) {
				return errorf("Refusing to prune: a clone into %s is in progress; retry when it finishes.", marker.Destination)
			}
			id := trim(readTextOr(filepath.Join(marker.Destination, ".git", "gitx-consumer-id"), ""))
			if isPresent(filepath.Join(marker.Destination, ".git")) && !registered[id] {
				return errorf("Refusing to prune: the clone into %s was never registered. Run git-dedup store add %s, or delete that checkout, then retry.", marker.Destination, marker.Destination)
			}
			if err := os.Remove(filepath.Join(root, "clones", name)); err != nil {
				return err
			}
		}
		refs, err := c.checked([]string{"-C", pool, "for-each-ref", "--format=%(refname)", "refs/gitx/consumers"}, "")
		if err != nil {
			return err
		}
		unregistered := 0
		counted := map[string]bool{}
		for _, ref := range nonEmpty(splitLines(refs)) {
			parts := strings.Split(ref, "/")
			if len(parts) > 3 && !registered[parts[3]] && !counted[parts[3]] {
				counted[parts[3]] = true
				unregistered++
			}
		}
		if unregistered > 0 {
			return errorf("Refusing to prune: the pool holds objects for %d unregistered checkout(s). Run git-dedup store add for every checkout that uses this store (for example git-dedup store add --all <directory>), then retry.", unregistered)
		}
		// A moved checkout still borrows through its absolute alternate path, including
		// objects fetched after its last pin. Only the user can say it was deleted.
		var missing []string
		for _, entry := range registry {
			carries, err := carriesConsumerID(entry.gitdir, entry.id)
			if err != nil {
				return err
			}
			if !carries {
				missing = append(missing, entry.gitdir)
			}
		}
		if len(missing) > 0 {
			var list strings.Builder
			for _, gitdir := range missing {
				list.WriteString("  " + checkoutPath(gitdir) + "\n")
			}
			return errorf("Refusing to prune: %d registered checkout(s) cannot be found:\n%sIf this checkout was moved, run git-dedup store add <new path>. If it was deleted, run git-dedup store remove --forget <old path>.", len(missing), list.String())
		}
		for _, entry := range registry {
			tips, err := c.liveTips(entry.gitdir)
			if err != nil {
				return err
			}
			if err := c.pinConsumer(pool, entry.gitdir, entry.gitdir, tips); err != nil {
				return err
			}
		}
		before := directorySize(pool)
		// Explicit expiry: the pool never prunes automatically.
		if _, err := c.checked([]string{"-C", pool, "gc", "--prune=now"}, ""); err != nil {
			return err
		}
		result.ReclaimedBytes = max(0, before-directorySize(pool))
		return nil
	})
	return result, err
}

// Forget releases a registered checkout that no longer exists and returns the Git directories forgotten.
func (c *Client) Forget(path string) ([]string, error) {
	root := c.StorePath()
	target := resolvePath(c.cwd, path)
	var candidates []string
	for _, base := range []string{target, canonicalPath(target)} {
		candidates = append(candidates, base, filepath.Join(base, ".git"))
	}
	forgotten := []string{}
	if !isPresent(root) {
		return forgotten, nil
	}
	err := c.lockDirectory(storeLock(root), func() error {
		registry, err := registeredConsumers(root)
		if err != nil {
			return err
		}
		present := false
		for _, entry := range registry {
			if !slices.ContainsFunc(candidates, func(candidate string) bool { return samePath(candidate, entry.gitdir) }) {
				continue
			}
			// A new checkout at a deleted checkout's path is live; forget only the old registration.
			carries, err := carriesConsumerID(entry.gitdir, entry.id)
			if err != nil {
				return err
			}
			if carries {
				present = true
				continue
			}
			if isPresent(poolPath(root)) {
				if err := c.deletePins(poolPath(root), entry.id); err != nil {
					return err
				}
			}
			if err := os.Remove(filepath.Join(root, "consumers", entry.id+".json")); err != nil {
				return err
			}
			forgotten = append(forgotten, entry.gitdir)
		}
		if len(forgotten) == 0 && present {
			return errorf("%s still exists; run git-dedup store remove without --forget to detach it", path)
		}
		return nil
	})
	return forgotten, err
}

// Doctor checks the pool and the Git executable.
func (c *Client) Doctor() DoctorResult {
	root := c.StorePath()
	pool := poolPath(root)
	result := DoctorResult{Empty: !isPresent(pool), Checks: []DoctorCheck{}}
	if !result.Empty {
		check := DoctorCheck{Name: "pool"}
		format, err := c.checked([]string{"-C", pool, "rev-parse", "--show-object-format"}, "")
		var bare string
		if err == nil {
			bare, err = c.checked([]string{"-C", pool, "rev-parse", "--is-bare-repository"}, "")
		}
		if err != nil {
			check.Detail = pool + ": " + err.Error()
		} else {
			name := strings.ToUpper(format)
			if format == "sha1" {
				name = "SHA-1"
			}
			kind := "non-bare"
			if bare == "true" {
				kind = "bare"
			}
			check.OK = format == "sha1" && bare == "true"
			check.Detail = fmt.Sprintf("%s: %s %s object database", pool, name, kind)
		}
		result.Checks = append(result.Checks, check)
	}
	binary, err := c.GitPath()
	var version string
	if err == nil {
		version, err = c.checked([]string{"--version"}, "")
	}
	if err != nil {
		result.Checks = append(result.Checks, DoctorCheck{Name: "git", Detail: err.Error()})
	} else {
		result.Checks = append(result.Checks, DoctorCheck{Name: "git", OK: true, Detail: binary + ": " + version})
	}
	return result
}
