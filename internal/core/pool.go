package core

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
)

func (c *Client) ensurePool(root string) (string, error) {
	pool := poolPath(root)
	if !isPresent(pool) {
		if _, err := c.checked([]string{"init", "--bare", "--object-format=sha1", pool}, ""); err != nil {
			return "", err
		}
	}
	format, err := c.checked([]string{"-C", pool, "rev-parse", "--show-object-format"}, "")
	if err != nil {
		return "", err
	}
	if format != "sha1" {
		return "", errors.New("Unsupported Git object format in shared pool")
	}
	for _, setting := range [][2]string{
		// Git fsck in an alternate consumer can misread a commit graph from a pool
		// containing unrelated histories. The graph is derived data, so omit it.
		{"gc.writeCommitGraph", "false"},
		{"maintenance.commit-graph.enabled", "false"},
		// Consumers borrow objects that a force push can leave unreachable in the
		// pool. Automatic gc would prune them, so only store prune deletes objects,
		// after re-pinning every live consumer.
		{"gc.auto", "0"},
		{"maintenance.auto", "false"},
		{"gc.pruneExpire", "never"},
		// Pool ref names nest a 64-character remote ID, which can pass the 260-character
		// Windows path limit. Git for Windows lifts it with this setting; other Gits ignore it.
		{"core.longpaths", "true"},
	} {
		if _, err := c.checked([]string{"-C", pool, "config", setting[0], setting[1]}, ""); err != nil {
			return "", err
		}
	}
	removeAll(filepath.Join(pool, "objects", "info", "commit-graph"))
	removeAll(filepath.Join(pool, "objects", "info", "commit-graphs"))
	return pool, nil
}

func (c *Client) fetchRemote(root, remote, key string, progress, quiet bool) (string, error) {
	pool, err := c.ensurePool(root)
	if err != nil {
		return "", err
	}
	if err := c.fetchRemoteObjects(pool, remote, key, progress, quiet); err != nil {
		return "", err
	}
	return pool, registerRemote(root, remote, key)
}

func (c *Client) fetchRemoteObjects(pool, remote, key string, progress, quiet bool) error {
	id := remoteID(key)
	if !quiet {
		c.warn("git-dedup: updating object pool for " + key + "\n")
	}
	args := []string{"-C", pool, "fetch", "--no-tags"}
	if progress {
		args = append(args, "--progress")
	}
	args = append(args, remote,
		"+refs/heads/*:refs/gitx/remotes/"+id+"/heads/*",
		"+refs/tags/*:refs/gitx/remotes/"+id+"/tags/*")
	_, err := c.checkedWith(args, "", progress, nil)
	return err
}

func (c *Client) consumerTips(repo string) ([]string, error) {
	refs, err := c.checked([]string{"for-each-ref", "--format=%(objectname)", "refs"}, repo)
	if err != nil {
		return nil, err
	}
	tips := nonEmpty(splitLines(refs))
	// An unborn HEAD (orphan branch, bare repo naming a missing branch) has no tip to pin.
	head, err := c.git([]string{"rev-parse", "--verify", "-q", "HEAD"}, repo, captured, nil)
	if err != nil {
		return nil, err
	}
	if head.code == 0 {
		tips = append(tips, trim(head.stdout))
	}
	slices.Sort(tips)
	return slices.Compact(tips), nil
}

func (c *Client) unpinnedTips(pool, id string, tips []string) ([]string, error) {
	// A tip that a remote ref holds needs no pin until the remote moves. Only
	// store prune deletes objects, and it re-pins every live consumer first.
	output, err := c.checked([]string{"-C", pool, "for-each-ref", "--format=%(objectname)", "refs/gitx/consumers/" + id, "refs/gitx/remotes"}, "")
	if err != nil {
		return nil, err
	}
	held := map[string]bool{}
	for _, oid := range splitLines(output) {
		held[oid] = true
	}
	missing := []string{}
	for _, oid := range tips {
		if !held[oid] {
			missing = append(missing, oid)
		}
	}
	return missing, nil
}

func (c *Client) pinConsumer(pool, repo, commonGitdir string, tips []string) error {
	// Immutable snapshots keep old tips reachable after force pushes, branch
	// deletion, or a later store add call on the same checkout. Source ref names
	// cannot be copied into a files-backed pool: refs differing only by case
	// collide on case-insensitive filesystems. Object IDs are safe ref names,
	// and one pin per distinct tip preserves the same reachability.
	root := filepath.Dir(pool)
	id, err := consumerID(root, commonGitdir)
	if err != nil {
		return err
	}
	// Register before pinning: prune refuses to run while pins lack a registration.
	if err := registerConsumer(root, id, commonGitdir); err != nil {
		return err
	}
	missing, err := c.unpinnedTips(pool, id, tips)
	if err != nil {
		return err
	}
	// Keep fetch argument lists bounded for repositories with many refs.
	for offset := 0; offset < len(missing); offset += 128 {
		args := []string{"-C", pool, "fetch", "--no-tags", repo}
		for _, oid := range missing[offset:min(offset+128, len(missing))] {
			args = append(args, "+"+oid+":refs/gitx/consumers/"+id+"/"+oid)
		}
		if _, err := c.checked(args, ""); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) repoGitdir(path string) (string, error) {
	output, err := c.checked([]string{"rev-parse", "--absolute-git-dir"}, path)
	return nativePath(output), err
}

func (c *Client) repoCommonGitdir(path string) (string, error) {
	output, err := c.checked([]string{"rev-parse", "--path-format=absolute", "--git-common-dir"}, path)
	return nativePath(output), err
}

func (c *Client) origin(path string) (string, bool) {
	result, err := c.git([]string{"remote", "get-url", "origin"}, path, captured, nil)
	if err != nil || result.code != 0 {
		return "", false
	}
	return trim(result.stdout), true
}

func (c *Client) remoteKey(remote, at string) string {
	expanded, err := c.git([]string{"ls-remote", "--get-url", remote}, at, captured, nil)
	if err == nil && expanded.code == 0 {
		return KeyForRemote(trim(expanded.stdout))
	}
	return KeyForRemote(remote)
}

func hasPrefixPath(path, parent string) bool {
	return strings.HasPrefix(path, parent+string(filepath.Separator))
}
