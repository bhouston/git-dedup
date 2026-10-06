package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type StoreRemoveResult struct {
	Removed      int                           `json:"removed"`
	Skipped      int                           `json:"skipped"`
	Failed       int                           `json:"failed"`
	Repositories []StoreRemoveRepositoryResult `json:"repositories"`
}

type StoreRemoveRepositoryResult struct {
	Path string `json:"path"`
	// Status is "removed", "skipped", or "failed".
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	// Detail is the full underlying error for diagnostic output.
	Detail string `json:"detail,omitempty"`
	// ObjectBytes is the size of the checkout's own object directory after removal.
	ObjectBytes *int64 `json:"objectBytes,omitempty"`
}

var fullObjectID = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Remove detaches a checkout and its submodules from the store, copying the objects they borrow.
func (c *Client) Remove(path string) (*StoreRemoveResult, error) {
	result := &StoreRemoveResult{Repositories: []StoreRemoveRepositoryResult{}}
	visited := map[string]bool{}
	root := c.StorePath()
	pool := poolPath(root)
	poolObjects := filepath.Join(pool, "objects")
	record := func(entry StoreRemoveRepositoryResult) {
		switch entry.Status {
		case "removed":
			result.Removed++
		case "skipped":
			result.Skipped++
		default:
			result.Failed++
		}
		result.Repositories = append(result.Repositories, entry)
	}
	var detach func(repo string)
	detach = func(repo string) {
		commonGitdir, err := c.repoCommonGitdir(repo)
		if err != nil {
			entry := StoreRemoveRepositoryResult{Path: repo, Status: "skipped", Reason: "not a Git repository or path is unavailable", Detail: err.Error()}
			if !isPresent(repo) {
				entry.Status = "failed"
				entry.Reason = "path not found; if this checkout was deleted, run git-dedup store remove --forget " + repo
			}
			record(entry)
			return
		}
		// Linked worktrees share one object database, so detach it once.
		if visited[commonGitdir] {
			return
		}
		visited[commonGitdir] = true
		gitdirs := []string{commonGitdir}
		for _, name := range readDirNames(filepath.Join(commonGitdir, "worktrees")) {
			gitdirs = append(gitdirs, filepath.Join(commonGitdir, "worktrees", name))
		}
		defer func() {
			for _, gitdir := range gitdirs {
				c.visitModules(filepath.Join(gitdir, "modules"), detach)
			}
		}()
		alternate := filepath.Join(commonGitdir, "objects", "info", "alternates")
		original := readTextOr(alternate, "")
		lines := alternateLines(original)
		if !hasAlternate(lines, poolObjects) {
			record(StoreRemoveRepositoryResult{Path: repo, Status: "skipped", Reason: "not linked to the store"})
			return
		}
		err = c.detach(repo, root, pool, commonGitdir, gitdirs, alternate, original, lines)
		if err != nil {
			record(StoreRemoveRepositoryResult{Path: repo, Status: "failed", Reason: "could not detach from the store", Detail: err.Error()})
			return
		}
		size := directorySize(filepath.Join(commonGitdir, "objects"))
		record(StoreRemoveRepositoryResult{Path: repo, Status: "removed", ObjectBytes: &size})
	}
	detach(resolvePath(c.cwd, path))
	return result, nil
}

func (c *Client) detach(repo, root, pool, commonGitdir string, gitdirs []string, alternate, original string, lines []string) error {
	if !isPresent(pool) {
		return errorf("Object pool is missing: %s", pool)
	}
	poolObjects := filepath.Join(pool, "objects")
	// Lock without initializing: removal must never create a store.
	return c.lockDirectory(storeLock(root), func() error {
		c.warn("git-dedup: removing " + repo + ": copying shared objects\n")
		// Repack and fsck ignore in-progress merge, cherry-pick, and rebase state, so pin the
		// objects it names with temporary refs. Names that are already missing stay missing.
		var named []string
		seen := map[string]bool{}
		for _, gitdir := range gitdirs {
			for _, oid := range stateOids(gitdir) {
				if !seen[oid] {
					seen[oid] = true
					named = append(named, oid)
				}
			}
		}
		var present []string
		if len(named) > 0 {
			input := strings.Join(named, "\n") + "\n"
			output, err := c.checkedWith([]string{"cat-file", "--batch-check=%(objectname)"}, repo, false, &input)
			if err != nil {
				return err
			}
			for _, line := range splitLines(output) {
				if fullObjectID.MatchString(line) {
					present = append(present, line)
				}
			}
		}
		updateRefs := func(verb string) error {
			if len(present) == 0 {
				return nil
			}
			var input strings.Builder
			for _, oid := range present {
				if verb == "update" {
					input.WriteString("update refs/gitx-detach/" + oid + " " + oid + "\n")
				} else {
					input.WriteString("delete refs/gitx-detach/" + oid + "\n")
				}
			}
			text := input.String()
			_, err := c.checkedWith([]string{"update-ref", "--stdin"}, repo, false, &text)
			return err
		}
		err := func() (err error) {
			if err := updateRefs("update"); err != nil {
				return err
			}
			defer func() {
				if cleanup := updateRefs("delete"); err == nil {
					err = cleanup
				}
			}()
			// Without -l, repack copies every object reachable from refs, reflogs, and
			// the indexes of all worktrees, including objects read through the pool.
			if _, err := c.checked([]string{"-c", "repack.writeBitmaps=false", "repack", "-a", "-d", "--pack-kept-objects"}, repo); err != nil {
				return err
			}
			var remaining []string
			for _, line := range lines {
				if !samePath(line, poolObjects) {
					remaining = append(remaining, line)
				}
			}
			if len(remaining) > 0 {
				err = writeText(alternate, strings.Join(remaining, "\n")+"\n")
			} else {
				err = os.Remove(alternate)
			}
			if err != nil {
				return err
			}
			if _, err := c.checked([]string{"fsck", "--connectivity-only"}, repo); err != nil {
				_ = writeText(alternate, original)
				return err
			}
			return nil
		}()
		if err != nil {
			return err
		}
		id := trim(readTextOr(filepath.Join(commonGitdir, "gitx-consumer-id"), ""))
		// A copy carrying another live checkout's ID detaches without releasing that checkout's pins.
		if consumerIDPattern.MatchString(id) {
			elsewhere, err := ownedElsewhere(root, id, commonGitdir)
			if err != nil {
				return err
			}
			if !elsewhere {
				if err := c.deletePins(pool, id); err != nil {
					return err
				}
				removeAll(filepath.Join(root, "consumers", id+".json"))
			}
		}
		removeAll(filepath.Join(commonGitdir, "gitx-consumer-id"))
		for _, gitdir := range gitdirs {
			removeAll(filepath.Join(gitdir, "gitx-cache.json"))
		}
		return nil
	})
}

func (c *Client) deletePins(pool, id string) error {
	pins, err := c.checked([]string{"-C", pool, "for-each-ref", "--format=delete %(refname)", "refs/gitx/consumers/" + id}, "")
	if err != nil || pins == "" {
		return err
	}
	input := pins + "\n"
	_, err = c.checkedWith([]string{"-C", pool, "update-ref", "--stdin"}, "", false, &input)
	return err
}
