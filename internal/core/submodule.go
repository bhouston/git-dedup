package core

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

var (
	submoduleEntry = regexp.MustCompile(`^submodule\.(.+)\.(path|url) (.+)$`)
	submodulePath  = regexp.MustCompile(`^submodule\..*\.path (.+)$`)
)

func quietFlag(quiet bool) []string {
	if quiet {
		return []string{"-q"}
	}
	return nil
}

func (c *Client) seedSubmodules(repo string, quiet bool) error {
	modulesFile := filepath.Join(repo, ".gitmodules")
	if !isPresent(modulesFile) {
		return nil
	}
	parentRemote, _ := c.origin(repo)
	listing, err := c.git([]string{"config", "--file", modulesFile, "--get-regexp", `^submodule\..*\.(path|url)$`}, repo, captured, nil)
	if err != nil {
		return err
	}
	if listing.code != 0 {
		return nil
	}
	type item struct{ path, url string }
	var names []string
	byName := map[string]*item{}
	for _, line := range splitLines(listing.stdout) {
		m := submoduleEntry.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		entry := byName[m[1]]
		if entry == nil {
			entry = &item{}
			byName[m[1]] = entry
			names = append(names, m[1])
		}
		if m[2] == "path" {
			entry.path = m[3]
		} else {
			entry.url = m[3]
		}
	}
	for _, name := range names {
		entry := byName[name]
		if entry.path == "" || entry.url == "" || slices.ContainsFunc(strings.Split(name, "/"), func(p string) bool {
			return p == "" || p == "." || p == ".."
		}) {
			continue
		}
		registered, err := c.git([]string{"config", "--get", "submodule." + name + ".url"}, repo, captured, nil)
		if err != nil {
			return err
		}
		if registered.code != 0 {
			continue
		}
		active, err := c.git([]string{"config", "--type=bool", "--get", "submodule." + name + ".active"}, repo, captured, nil)
		if err != nil {
			return err
		}
		if trim(active.stdout) == "false" {
			continue
		}
		remote := resolveSubmoduleRemote(parentRemote, trim(registered.stdout))
		if remote == "" {
			continue
		}
		key := c.remoteKey(remote, repo)
		if key == "" {
			continue
		}
		target := resolvePath(repo, entry.path)
		// Leave populated paths (an initialized checkout or user files) to native Git, which refuses to clobber them.
		if !hasPrefixPath(target, repo) || len(readDirNames(target)) > 0 {
			continue
		}
		gitPathResult, err := c.git([]string{"rev-parse", "--path-format=absolute", "--git-path", "modules/" + name}, repo, captured, nil)
		if err != nil {
			return err
		}
		if gitPathResult.code != 0 {
			continue
		}
		gitdir := nativePath(trim(gitPathResult.stdout))
		if isPresent(gitdir) {
			continue
		}
		root := c.StorePath()
		err = c.withLock(root, func() error { return c.seedSubmodule(root, remote, key, gitdir, target, quiet) })
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) seedSubmodule(root, remote, key, gitdir, target string, quiet bool) error {
	pool, err := c.fetchRemote(root, remote, key, false, quiet)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(gitdir), 0o777); err != nil {
		return err
	}
	run := func(args ...string) error {
		_, err := c.checked(append([]string{"--git-dir", gitdir}, args...), "")
		return err
	}
	if _, err := c.checked([]string{"clone", "--bare", "--reference", pool, remote, gitdir}, ""); err != nil {
		return err
	}
	// Match a native submodule clone: remote-tracking refs, origin/HEAD, and only the default local branch.
	if err := run("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"); err != nil {
		return err
	}
	if err := run("fetch", "--quiet", "origin"); err != nil {
		return err
	}
	head, err := c.git([]string{"--git-dir", gitdir, "symbolic-ref", "--short", "-q", "HEAD"}, "", captured, nil)
	if err != nil {
		return err
	}
	branch := ""
	if head.code == 0 {
		branch = trim(head.stdout)
	}
	if branch != "" {
		for _, args := range [][]string{
			{"remote", "set-head", "origin", branch},
			{"config", "branch." + branch + ".remote", "origin"},
			{"config", "branch." + branch + ".merge", "refs/heads/" + branch},
		} {
			if err := run(args...); err != nil {
				return err
			}
		}
	}
	refs, err := c.checked([]string{"--git-dir", gitdir, "for-each-ref", "--format=%(refname:short)", "refs/heads"}, "")
	if err != nil {
		return err
	}
	var others []string
	for _, ref := range splitLines(refs) {
		if ref != "" && ref != branch {
			others = append(others, ref)
		}
	}
	if len(others) > 0 {
		if err := run(append([]string{"branch", "-D"}, others...)...); err != nil {
			return err
		}
	}
	if err := run("config", "core.bare", "false"); err != nil {
		return err
	}
	if err := run("config", "core.worktree", target); err != nil {
		return err
	}
	tips, err := c.consumerTips(gitdir)
	if err != nil {
		return err
	}
	return c.pinConsumer(pool, gitdir, gitdir, tips)
}

func (c *Client) updateSubmodules(args []string, at string) (int, error) {
	quiet := slices.Contains(args, "-q") || slices.Contains(args, "--quiet")
	submodule := func(args []string) (int, error) {
		return c.passthrough(append([]string{"submodule"}, args...), at)
	}
	if len(args) > 0 && args[0] == "add" {
		code, err := submodule(args)
		if err != nil || code != 0 {
			return code, err
		}
		target := submoduleAddPath(args)
		if target == "" {
			c.fallback(args, "submodule path not recognized")
		} else if _, err := c.Add(resolvePath(at, target), quiet); err != nil {
			c.warn("git-dedup: submodule adoption unavailable (Error: " + err.Error() + ")\n")
		}
		return 0, nil
	}
	if len(args) == 0 || args[0] != "update" {
		return submodule(args)
	}
	// Without a pathspec, `git submodule update` from a subdirectory covers the whole superproject.
	repo := at
	if toplevel, err := c.git([]string{"rev-parse", "--show-toplevel"}, at, captured, nil); err != nil {
		return 0, err
	} else if toplevel.code == 0 {
		repo = nativePath(trim(toplevel.stdout))
	}
	for _, arg := range args[1:] {
		if !slices.Contains([]string{"--init", "--recursive", "--quiet", "-q"}, arg) {
			c.fallback(args, "submodule update "+arg+" is not supported")
			return submodule(args)
		}
	}
	// The native clone default '.' activates every submodule, which seeding already handles.
	active, err := c.git([]string{"config", "--get-all", "submodule.active"}, at, captured, nil)
	if err != nil {
		return 0, err
	}
	if active.code == 0 && trim(active.stdout) != "." {
		c.fallback(args, "submodule.active is configured")
		return submodule(args)
	}
	if slices.Contains(args, "--init") {
		code, err := submodule(append([]string{"init"}, quietFlag(quiet)...))
		if err != nil || code != 0 {
			return code, err
		}
	}
	if err := c.seedSubmodules(repo, quiet); err != nil {
		c.fallback(args, "submodule adoption unavailable"+gitFailure(err))
	}
	recursive := slices.Contains(args, "--recursive") && slices.Contains(args, "--init")
	if !recursive {
		return submodule(args)
	}
	var withoutRecursive []string
	for _, arg := range args {
		if arg != "--recursive" {
			withoutRecursive = append(withoutRecursive, arg)
		}
	}
	if code, err := submodule(withoutRecursive); err != nil || code != 0 {
		return code, err
	}
	listing, err := c.git([]string{"config", "--file", ".gitmodules", "--get-regexp", `^submodule\..*\.path$`}, repo, captured, nil)
	if err != nil {
		return 0, err
	}
	if listing.code != 0 {
		return 0, nil
	}
	for _, line := range splitLines(trim(listing.stdout)) {
		m := submodulePath.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		child := resolvePath(repo, m[1])
		if !hasPrefixPath(child, repo) || !isPresent(child) {
			continue
		}
		nested, err := c.updateSubmodules(append([]string{"update", "--init", "--recursive"}, quietFlag(quiet)...), child)
		if err != nil || nested != 0 {
			return nested, err
		}
	}
	return 0, nil
}

// visitModules visits the checkout of every initialized submodule gitdir under a modules directory.
func (c *Client) visitModules(directory string, visit func(repo string)) {
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		modulePath := filepath.Join(directory, entry.Name())
		if isPresent(filepath.Join(modulePath, "HEAD")) {
			result, err := c.git([]string{"--git-dir", modulePath, "config", "--get", "core.worktree"}, "", captured, nil)
			if workTree := trim(result.stdout); err == nil && workTree != "" {
				visit(resolvePath(modulePath, workTree))
			}
		} else {
			c.visitModules(modulePath, visit)
		}
	}
}

var worktreeFlags = []string{
	"-f", "--force", "-d", "--detach", "--checkout", "--no-checkout", "--lock", "--track", "--no-track",
	"--guess-remote", "--no-guess-remote", "--orphan", "-q", "--quiet",
}

var worktreeValueFlag = regexp.MustCompile(`^(--reason|--track)=`)

func (c *Client) addWorktree(args []string, at string) (int, error) {
	worktree := func() (int, error) { return c.passthrough(append([]string{"worktree"}, args...), at) }
	if len(args) == 0 || args[0] != "add" {
		return worktree()
	}
	path := ""
	noCheckout, quiet := false, false
	for i := 1; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			if i+1 < len(args) {
				path = args[i+1]
			}
			break
		}
		if arg == "-b" || arg == "-B" || arg == "--reason" {
			i++
			continue
		}
		if arg == "--no-checkout" || arg == "--orphan" {
			noCheckout = true
		}
		if arg == "-q" || arg == "--quiet" {
			quiet = true
		}
		if slices.Contains(worktreeFlags, arg) || worktreeValueFlag.MatchString(arg) {
			continue
		}
		if strings.HasPrefix(arg, "-") {
			c.fallback(args, "worktree add "+optionName(arg)+" is not supported")
			return worktree()
		}
		path = arg
		break
	}
	code, err := worktree()
	if err != nil || code != 0 || path == "" || noCheckout {
		return code, err
	}
	target := resolvePath(at, path)
	// Git already shares the superproject object directory between worktrees.
	// Its submodules have separate gitdirs, so populate those through the pool.
	// Like plain git worktree add, succeed once the worktree exists; submodule setup is extra.
	if isPresent(filepath.Join(target, ".gitmodules")) {
		code, err := c.updateSubmodules(append([]string{"update", "--init", "--recursive"}, quietFlag(quiet)...), target)
		if err != nil || code != 0 {
			c.warn("git-dedup: worktree created, but submodule setup failed; retry with `git submodule update --init --recursive` in " + target + "\n")
		}
	}
	return 0, nil
}
