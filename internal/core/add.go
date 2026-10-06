package core

import (
	"path/filepath"
	"slices"
	"strings"
)

type StoreAddResult struct {
	Added        int                        `json:"added"`
	Skipped      int                        `json:"skipped"`
	Failed       int                        `json:"failed"`
	Repositories []StoreAddRepositoryResult `json:"repositories"`
}

type StoreAddRepositoryResult struct {
	Path string `json:"path"`
	// Status is "added", "skipped", or "failed".
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	// Detail is the full underlying error for diagnostic output.
	Detail string `json:"detail,omitempty"`
}

type adoptionState struct {
	Version int      `json:"version"`
	Pool    string   `json:"pool"`
	Remote  string   `json:"remote"`
	Key     string   `json:"key"`
	Tips    []string `json:"tips"`
}

// Add adopts a checkout and its initialized submodules into the store. An empty path uses the working directory.
func (c *Client) Add(path string, quiet bool) (*StoreAddResult, error) {
	result := &StoreAddResult{Repositories: []StoreAddRepositoryResult{}}
	visited := map[string]bool{}
	record := func(repo, status, reason, detail string) {
		switch status {
		case "added":
			result.Added++
		case "skipped":
			result.Skipped++
		default:
			result.Failed++
		}
		result.Repositories = append(result.Repositories, StoreAddRepositoryResult{Path: repo, Status: status, Reason: reason, Detail: detail})
	}
	progress := func(repo, step string) {
		if !quiet {
			c.warn("git-dedup: adding " + repo + ": " + step + "\n")
		}
	}
	var adopt func(repo string)
	adopt = func(repo string) {
		gitdir, err := c.repoGitdir(repo)
		if err != nil {
			record(repo, "skipped", "not a Git repository or path is unavailable", err.Error())
			return
		}
		if visited[gitdir] {
			record(repo, "skipped", "object database already visited", "")
			return
		}
		visited[gitdir] = true
		defer c.visitModules(filepath.Join(gitdir, "modules"), adopt)
		stage := "preparing repository"
		if err := c.adopt(repo, gitdir, quiet, &stage, record, progress); err != nil {
			record(repo, "failed", addFailureReason(err, stage), err.Error())
		}
	}
	adopt(resolvePath(c.cwd, c.at(path)))
	return result, nil
}

func (c *Client) adopt(repo, gitdir string, quiet bool, stage *string, record func(repo, status, reason, detail string), progress func(repo, step string)) error {
	format, err := c.checked([]string{"rev-parse", "--show-object-format"}, repo)
	if err != nil {
		return err
	}
	if format != "sha1" {
		record(repo, "skipped", "unsupported object format (requires SHA-1)", "")
		return nil
	}
	// A fetch from a partial clone with promised blobs fails: upload-pack disables lazy fetching.
	promisor, err := c.git([]string{"config", "--get-regexp", `^remote\..*\.promisor$`}, repo, captured, nil)
	if err != nil {
		return err
	}
	if trim(promisor.stdout) != "" {
		objects, err := c.checked([]string{"rev-list", "--all", "--objects", "--missing=print"}, repo)
		if err != nil {
			return err
		}
		if slices.ContainsFunc(splitLines(objects), func(line string) bool { return strings.HasPrefix(line, "?") }) {
			record(repo, "skipped", `partial clone with missing objects; run "git fetch --refetch" or re-clone without --filter, then add it again`, "")
			return nil
		}
	}
	commonGitdir, err := c.repoCommonGitdir(repo)
	if err != nil {
		return err
	}
	url, ok := c.origin(repo)
	if !ok {
		record(repo, "skipped", "no origin remote", "")
		return nil
	}
	key := c.remoteKey(url, repo)
	if key == "" {
		record(repo, "skipped", "origin URL cannot be used as a store key", "")
		return nil
	}
	root := c.StorePath()
	return c.withLock(root, func() error {
		poolReused := isPresent(poolPath(root))
		pool, err := c.ensurePool(root)
		if err != nil {
			return err
		}
		tips, err := c.consumerTips(repo)
		if err != nil {
			return err
		}
		// A successful marker belongs to this worktree; linked worktrees can have different HEADs.
		marker := filepath.Join(gitdir, "gitx-cache.json")
		state := jsonLine(adoptionState{Version: 1, Pool: pool, Remote: url, Key: key, Tips: tips})
		alternate := filepath.Join(commonGitdir, "objects", "info", "alternates")
		originalAlternates, readErr := readText(alternate)
		alreadyLinked := hasAlternate(alternateLines(originalAlternates), filepath.Join(pool, "objects"))
		registered := readTextOr(filepath.Join(root, "remotes", remoteID(key)+".json"), "") == registration(url, key)
		stateMatches := poolReused && alreadyLinked && registered && readTextOr(marker, "") == state
		id, err := consumerID(root, commonGitdir)
		if err != nil {
			return err
		}
		if stateMatches {
			unpinned, err := c.unpinnedTips(pool, id, tips)
			if err != nil {
				return err
			}
			if len(unpinned) == 0 {
				// Checkouts adopted before the consumer registry existed register here.
				if err := registerConsumer(root, id, commonGitdir); err != nil {
					return err
				}
				record(repo, "skipped", "already current", "")
				progress(repo, "already current")
				return nil
			}
		}
		progress(repo, "packing local objects")
		repack := []string{"-c", "repack.writeBitmaps=false", "repack", "-a", "-d", "-l"}
		// Gather loose local objects before adding an alternate; afterwards Git may
		// consider a local object redundant and omit it from a new pack.
		if !alreadyLinked {
			if _, err := c.checked(repack, repo); err != nil {
				return err
			}
		}
		beforeUniqueBytes := uniquePackBytes(commonGitdir)
		progress(repo, "importing refs")
		*stage = "importing refs"
		if err := c.pinConsumer(pool, repo, commonGitdir, tips); err != nil {
			return err
		}
		*stage = "sharing objects"
		progress(repo, "sharing objects")
		err = setAlternate(commonGitdir, pool)
		if err == nil {
			err = removeLegacyKeeps(commonGitdir)
		}
		if err == nil {
			_, err = c.checked(repack, repo)
		}
		if err != nil {
			// Restore only until this repack succeeds; afterwards objects it dropped live only in the pool.
			if readErr != nil {
				removeAll(alternate)
			} else {
				_ = writeText(alternate, originalAlternates)
			}
			return err
		}
		info := filepath.Join(commonGitdir, "objects", "info")
		if isPresent(filepath.Join(info, "commit-graph")) || isPresent(filepath.Join(info, "commit-graphs")) {
			if _, err := c.checked([]string{"commit-graph", "write", "--reachable"}, repo); err != nil {
				return err
			}
		}
		if _, err := c.checked([]string{"fsck", "--connectivity-only", "--no-reflogs"}, repo); err != nil {
			return err
		}
		// Local adoption succeeds even when the remote is temporarily unavailable.
		if err := registerRemote(root, url, key); err != nil {
			return err
		}
		refreshErr := c.fetchRemoteObjects(pool, url, key, false, quiet)
		if err := writeText(marker, state); err != nil {
			return err
		}
		if c.options.OnStorageReport != nil {
			afterUniqueBytes := uniquePackBytes(commonGitdir)
			c.emitStorageReport(StorageReport{
				Operation:           "add",
				Repository:          repo,
				PoolReused:          poolReused,
				BeforeUniqueBytes:   &beforeUniqueBytes,
				AfterUniqueBytes:    &afterUniqueBytes,
				EstimatedSavedBytes: max(0, beforeUniqueBytes-afterUniqueBytes),
			})
		}
		if refreshErr != nil {
			record(repo, "added", "remote refresh deferred; retry with git-dedup store fetch", refreshErr.Error())
			c.warn("git-dedup: adding " + repo + ": remote refresh deferred; retry with git-dedup store fetch\n")
		} else {
			record(repo, "added", "", "")
		}
		return nil
	})
}
