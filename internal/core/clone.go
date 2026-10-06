package core

import (
	"os"
	"path/filepath"
	"slices"

	"golang.org/x/term"
)

type cloneMarker struct {
	Pid         int    `json:"pid"`
	Destination string `json:"destination"`
}

func (c *Client) stderrIsTerminal() bool {
	file, ok := c.stderr.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}

// clone runs a clone through the store. handled is false when the caller should forward the command to Git.
func (c *Client) clone(args []string, effectiveCwd string) (code int, handled bool, err error) {
	parsed, reason := parseClone(args)
	if reason != "" {
		c.fallback(args, reason)
		code, err := c.plainClone(args, effectiveCwd)
		return code, true, err
	}
	key := c.remoteKey(parsed.remote, effectiveCwd)
	if key == "" {
		c.fallback(args, "remote is not a supported network URL")
		code, err := c.plainClone(args, effectiveCwd)
		return code, true, err
	}
	name := parsed.destination
	if name == "" {
		name = defaultCloneName(parsed.remote)
	}
	destination := resolvePath(effectiveCwd, name)
	// Like Git, clone into a missing or empty directory.
	entries, readErr := os.ReadDir(destination)
	if (readErr != nil && !isNotExist(readErr)) || len(entries) > 0 {
		c.fallback(args, destination+" is not an empty directory")
		return 0, false, nil
	}
	root := c.StorePath()
	// Lock only the pool writes. Only store prune deletes pool objects, so git clone can
	// read the pool while other processes fetch or repack, and the new tips are pinned right after.
	poolReused := false
	var pool string
	var fetchErr error
	// Like git clone: progress on a terminal or with --progress, never with -q/--quiet.
	quiet := slices.Contains(parsed.forwarded, "-q") || slices.Contains(parsed.forwarded, "--quiet")
	progress := !quiet && (c.stderrIsTerminal() || slices.Contains(parsed.forwarded, "--progress"))
	// Until the pin lands, this clone borrows pool objects that nothing pins, so
	// store prune refuses while the marker exists. A failed pin leaves it behind.
	marker := filepath.Join(root, "clones", randomUUID()+".json")
	lockErr := c.withLock(root, func() error {
		if c.options.OnStorageReport != nil {
			poolReused = isPresent(poolPath(root))
		}
		pool, fetchErr = c.fetchRemote(root, parsed.remote, key, progress, quiet)
		if fetchErr != nil {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(marker), 0o777); err != nil {
			return err
		}
		return writeText(marker, jsonLine(cloneMarker{Pid: os.Getpid(), Destination: destination}))
	})
	if lockErr != nil {
		c.fallback(args, "object pool lock unavailable")
		return 0, false, nil
	}
	if fetchErr != nil {
		c.fallback(args, "object pool unavailable"+gitFailure(fetchErr))
		return 0, false, nil
	}
	cloneArgs := append(append([]string{"clone", "--reference", pool}, parsed.forwarded...), parsed.remote, destination)
	result, err := c.git(cloneArgs, effectiveCwd, inherited, nil)
	if err != nil {
		return 0, true, err
	}
	if result.code != 0 {
		if !isPresent(filepath.Join(destination, ".git")) {
			_ = os.Remove(marker)
		}
		return result.code, true, nil
	}
	commonGitdir, err := c.repoCommonGitdir(destination)
	if err != nil {
		return 0, true, err
	}
	tips, err := c.consumerTips(destination)
	if err != nil {
		return 0, true, err
	}
	err = c.withLock(root, func() error {
		if err := c.pinConsumer(pool, destination, commonGitdir, tips); err != nil {
			return err
		}
		removeAll(marker)
		return nil
	})
	if err != nil {
		return 0, true, err
	}
	c.emitStorageReport(StorageReport{Operation: "clone", Repository: destination, PoolReused: poolReused})
	if !parsed.recurse {
		return 0, true, nil
	}
	// Like native clone, activate every submodule, including ones added upstream later.
	active, err := c.git([]string{"config", "submodule.active", "."}, destination, inherited, nil)
	if err != nil || active.code != 0 {
		return active.code, true, err
	}
	update := []string{"update", "--init", "--recursive"}
	if quiet {
		update = append(update, "-q")
	}
	code, err = c.updateSubmodules(update, destination)
	return code, true, err
}

// plainClone runs `git clone` unchanged, then pins the new repository if it borrows from the pool:
// a local clone of a linked checkout copies its alternates.
func (c *Client) plainClone(args []string, at string) (int, error) {
	// Rather than re-parse Git's options, try each operand as the directory and as Git's guess from it
	// (`.git` appended for --bare/--mirror). Git only clones into a missing or empty directory.
	var candidates []string
	for i, operand := range args {
		if len(operand) > 0 && operand[0] == '-' && !slices.Contains(args[:i], "--") {
			continue
		}
		for _, path := range []string{operand, defaultCloneName(operand), defaultCloneName(operand) + ".git"} {
			candidate := resolvePath(at, path)
			if len(readDirNames(candidate)) == 0 && !slices.Contains(candidates, candidate) {
				candidates = append(candidates, candidate)
			}
		}
	}
	result, err := c.git(append([]string{"clone"}, args...), at, inherited, nil)
	if err != nil {
		return 0, err
	}
	if result.code == 0 {
		for _, candidate := range candidates {
			if err := c.pinBorrower(candidate); err != nil {
				return 0, err
			}
		}
	}
	return result.code, nil
}

func (c *Client) pinBorrower(destination string) error {
	// A worktree (or --separate-git-dir gitfile) at the destination, or a bare/mirror gitdir that is the destination.
	if !isPresent(filepath.Join(destination, ".git")) {
		gitdir, err := c.git([]string{"rev-parse", "--absolute-git-dir"}, destination, captured, nil)
		if err != nil || gitdir.code != 0 || !samePath(trim(gitdir.stdout), canonicalPath(destination)) {
			return nil
		}
	}
	root := c.StorePath()
	pool := poolPath(root)
	commonGitdir, err := c.repoCommonGitdir(destination)
	if err != nil {
		return err
	}
	alternates := readTextOr(filepath.Join(commonGitdir, "objects", "info", "alternates"), "")
	if !hasAlternate(alternateLines(alternates), filepath.Join(pool, "objects")) {
		return nil
	}
	// The source's pins hold these objects until this pin lands.
	tips, err := c.consumerTips(destination)
	if err != nil {
		return err
	}
	return c.withLock(root, func() error { return c.pinConsumer(pool, destination, commonGitdir, tips) })
}
