// Package discover finds Git checkouts under a directory for `git-dedup store add --all`.
package discover

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/bhouston/git-dedup/internal/core"
)

type Checkout struct {
	Path         string `json:"path"`
	GitDir       string `json:"gitDir"`
	CommonGitDir string `json:"commonGitDir"`
	// CoveredBy is the parent repository whose store add operation visits this initialized submodule.
	CoveredBy string `json:"coveredBy,omitempty"`
}

func isInsideWorktree(git, path string) bool {
	output, err := exec.Command(git, "-C", path, "rev-parse", "--is-inside-work-tree").Output()
	return err == nil && strings.TrimSpace(string(output)) == "true"
}

func ignoredDirectories(git, path string, names []string) (map[string]bool, error) {
	ignored := map[string]bool{}
	if len(names) == 0 {
		return ignored, nil
	}
	command := exec.Command(git, "-C", path, "check-ignore", "--no-index", "-z", "--stdin")
	command.Stdin = strings.NewReader(strings.Join(names, "\x00") + "\x00")
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	var exit *exec.ExitError
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 1) {
		return nil, fmt.Errorf("git check-ignore failed: %s", strings.TrimSpace(stderr.String()))
	}
	for _, name := range strings.Split(stdout.String(), "\x00") {
		if name != "" {
			ignored[name] = true
		}
	}
	return ignored, nil
}

// compareNames orders paths for display, close to JavaScript's localeCompare: case-insensitive first.
func compareNames(a, b string) int {
	if order := strings.Compare(strings.ToLower(a), strings.ToLower(b)); order != 0 {
		return order
	}
	return strings.Compare(a, b)
}

// Checkouts discovers checkout roots without following symlinks or entering ignored directories or Git metadata.
func Checkouts(directory, git string) ([]Checkout, error) {
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(root); err != nil {
		return nil, err
	} else if !info.IsDir() {
		return nil, fmt.Errorf("Not a directory: %s", root)
	}
	type pendingDir struct {
		path           string
		insideWorktree bool
	}
	var candidates []string
	pending := []pendingDir{{root, isInsideWorktree(git, root)}}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		entries, err := os.ReadDir(current.path)
		if err != nil {
			return nil, err
		}
		hasGitEntry := slices.ContainsFunc(entries, func(entry os.DirEntry) bool {
			return entry.Name() == ".git" && (entry.Type().IsRegular() || entry.IsDir())
		})
		// A stale .git entry (e.g. a pruned worktree pointer) must not be treated as a repository.
		hasGit := hasGitEntry && isInsideWorktree(git, current.path)
		if hasGit {
			candidates = append(candidates, current.path)
		}
		var directories []string
		for _, entry := range entries {
			if entry.IsDir() && entry.Name() != ".git" {
				directories = append(directories, entry.Name())
			}
		}
		excluded := map[string]bool{}
		if hasGit || (current.insideWorktree && !hasGitEntry) {
			if excluded, err = ignoredDirectories(git, current.path, directories); err != nil {
				return nil, err
			}
		}
		for _, name := range directories {
			if !excluded[name] {
				pending = append(pending, pendingDir{filepath.Join(current.path, name), current.insideWorktree || hasGit})
			}
		}
	}

	slices.SortFunc(candidates, func(a, b string) int {
		if len(a) != len(b) {
			return len(a) - len(b)
		}
		return compareNames(a, b)
	})
	var found []Checkout
	seen := map[string]bool{}
	for _, path := range candidates {
		output, err := exec.Command(git, "-C", path, "rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir").Output()
		if err != nil {
			// A .git entry alone is not enough to identify a valid checkout.
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		if len(lines) < 2 || lines[0] == "" || lines[1] == "" {
			continue
		}
		gitDir, err := core.Realpath(resolve(path, strings.TrimSpace(lines[0])))
		if err != nil {
			continue
		}
		commonGitDir, err := core.Realpath(resolve(path, strings.TrimSpace(lines[1])))
		if err != nil || seen[commonGitDir] {
			continue
		}
		seen[commonGitDir] = true
		found = append(found, Checkout{Path: path, GitDir: gitDir, CommonGitDir: commonGitDir})
	}
	slices.SortFunc(found, func(a, b Checkout) int { return compareNames(a.Path, b.Path) })
	separator := string(filepath.Separator)
	for i := range found {
		child := &found[i]
		for _, candidate := range found {
			if candidate.Path != child.Path && strings.HasPrefix(child.Path, candidate.Path+separator) &&
				strings.HasPrefix(child.GitDir, filepath.Join(candidate.GitDir, "modules")+separator) {
				child.CoveredBy = candidate.Path
				break
			}
		}
	}
	if found == nil {
		found = []Checkout{}
	}
	return found, nil
}

func resolve(base, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(base, path)
}
