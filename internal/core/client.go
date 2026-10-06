// Package core shares one copy of Git history across clones, worktrees, and submodules through a store
// of Git objects that checkouts borrow through alternates.
package core

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// Options configures a Client. Zero values use the process working directory, environment, and Git on PATH.
type Options struct {
	Cwd string
	// Env is the full environment, as from os.Environ. Nil uses the process environment.
	Env             []string
	GitPath         string
	OnStorageReport func(StorageReport)
	Stdin           io.Reader
	Stdout          io.Writer
	Stderr          io.Writer
}

type StorageReport struct {
	Operation           string `json:"operation"`
	Repository          string `json:"repository"`
	PoolReused          bool   `json:"poolReused"`
	EstimatedSavedBytes int64  `json:"estimatedSavedBytes"`
	// Logical bytes in private pack files before/after checkout adoption. Loose objects are excluded.
	BeforeUniqueBytes *int64 `json:"beforeUniqueBytes,omitempty"`
	AfterUniqueBytes  *int64 `json:"afterUniqueBytes,omitempty"`
}

// Client runs git-dedup operations for one working directory and environment.
type Client struct {
	options     Options
	cwd         string
	incomingEnv []string
	env         []string
	cachedGit   string
	stderr      io.Writer
	stdout      io.Writer
	stdin       io.Reader
}

var repositoryEnvironment = []string{
	"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE",
}

// New creates a Client.
func New(options Options) *Client {
	cwd := options.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	cwd, _ = filepath.Abs(cwd)
	incoming := options.Env
	if incoming == nil {
		incoming = os.Environ()
	}
	client := &Client{options: options, cwd: cwd, incomingEnv: incoming}
	client.env = withEnv(incoming, "GITX_ACTIVE", "1", "GIT_DEDUP_ACTIVE", "1")
	client.stderr = options.Stderr
	if client.stderr == nil {
		client.stderr = os.Stderr
	}
	client.stdout = options.Stdout
	if client.stdout == nil {
		client.stdout = os.Stdout
	}
	client.stdin = options.Stdin
	if client.stdin == nil {
		client.stdin = os.Stdin
	}
	return client
}

// splitEnv splits an environment entry. Windows names ignore case, and a leading `=` names a per-drive directory.
func splitEnv(entry string) (key, value string) {
	split := strings.Index(entry[min(1, len(entry)):], "=") + min(1, len(entry))
	if split < 1 {
		return normalizeEnvKey(entry), ""
	}
	return normalizeEnvKey(entry[:split]), entry[split+1:]
}

func normalizeEnvKey(key string) string {
	if isWindows {
		return strings.ToUpper(key)
	}
	return key
}

func lookupEnv(env []string, name string) string {
	want := normalizeEnvKey(name)
	for i := len(env) - 1; i >= 0; i-- {
		if key, value := splitEnv(env[i]); key == want {
			return value
		}
	}
	return ""
}

func withEnv(env []string, pairs ...string) []string {
	out := make([]string, 0, len(env)+len(pairs)/2)
	for _, entry := range env {
		key, _ := splitEnv(entry)
		replaced := false
		for i := 0; i < len(pairs); i += 2 {
			replaced = replaced || key == normalizeEnvKey(pairs[i])
		}
		if !replaced {
			out = append(out, entry)
		}
	}
	for i := 0; i < len(pairs); i += 2 {
		out = append(out, pairs[i]+"="+pairs[i+1])
	}
	return out
}

func (c *Client) hasRepositoryEnvironment() bool {
	for _, key := range repositoryEnvironment {
		if lookupEnv(c.env, key) != "" {
			return true
		}
	}
	return false
}

func (c *Client) warn(message string) {
	_, _ = io.WriteString(c.stderr, message)
}

func (c *Client) emitStorageReport(report StorageReport) {
	if c.options.OnStorageReport == nil {
		return
	}
	defer func() {
		if recover() != nil {
			c.warn("git-dedup: storage report callback failed\n")
		}
	}()
	c.options.OnStorageReport(report)
}

func ownExecutable() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := realpath(path); err == nil {
		return resolved
	}
	return ""
}

// GitPath returns the real Git executable that git-dedup runs.
func (c *Client) GitPath() (string, error) {
	if c.cachedGit != "" {
		return c.cachedGit, nil
	}
	own := ownExecutable()
	// The npm launcher runs this binary; a `git` shim pointing at the launcher is git-dedup too.
	launcher := ""
	if path := lookupEnv(c.env, "GIT_DEDUP_LAUNCHER"); path != "" {
		launcher, _ = realpath(path)
	}
	isSelf := func(actual string) bool { return actual == own || (launcher != "" && actual == launcher) }
	candidate := c.options.GitPath
	if candidate == "" {
		// Windows names executables with an extension. Only .exe spawns without a shell, so skip .cmd shims.
		name := "git"
		if isWindows {
			name = "git.exe"
		}
		for _, part := range filepath.SplitList(lookupEnv(c.env, "PATH")) {
			if part == "" {
				part = "."
			}
			path := resolvePath(c.cwd, filepath.Join(part, name))
			actual, err := realpath(path)
			if err != nil || isSelf(actual) {
				continue
			}
			if isExecutable(path) {
				candidate = path
				break
			}
		}
		if candidate == "" {
			return "", errors.New("Real Git executable not found on PATH")
		}
		configured := c.configValue(candidate, "git-dedup.gitPath")
		if configured == "" {
			configured = c.configValue(candidate, "gitx.gitPath")
		}
		if configured != "" {
			candidate = resolvePath(c.cwd, expandHome(configured))
		}
	}
	actual, err := realpath(candidate)
	if err != nil || isSelf(actual) {
		return "", errors.New("git-dedup.gitPath must point to a real Git executable, not git-dedup itself")
	}
	if !isExecutable(candidate) {
		return "", errorf("git-dedup.gitPath is not executable: %s", candidate)
	}
	c.cachedGit = candidate
	return candidate, nil
}

func (c *Client) configValue(git, key string) string {
	command := exec.Command(git, "config", "--get", key)
	command.Dir = c.cwd
	command.Env = c.env
	output, err := command.Output()
	if err != nil {
		return ""
	}
	return trim(string(output))
}

type gitResult struct {
	code   int
	stdout string
	stderr string
}

type stdioMode int

const (
	captured stdioMode = iota
	inherited
	// tee captures output like captured and also streams stderr (Git progress) to the user.
	tee
)

func (c *Client) git(args []string, at string, mode stdioMode, input *string) (gitResult, error) {
	binary, err := c.GitPath()
	if err != nil {
		return gitResult{}, err
	}
	if at == "" {
		at = c.cwd
	}
	command := exec.Command(binary, args...)
	command.Dir = at
	command.Env = c.env
	var stdout, stderr bytes.Buffer
	if mode == inherited {
		command.Stdin, command.Stdout, command.Stderr = c.stdin, c.stdout, c.stderr
	} else {
		if input != nil {
			command.Stdin = strings.NewReader(*input)
		}
		command.Stdout = &stdout
		command.Stderr = &stderr
		if mode == tee {
			command.Stderr = io.MultiWriter(&stderr, c.stderr)
		}
	}
	code, err := runForwardingSignals(command, mode == inherited)
	if err != nil {
		return gitResult{}, err
	}
	return gitResult{code: code, stdout: stdout.String(), stderr: stderr.String()}, nil
}

// at returns c.cwd for an empty directory argument.
func (c *Client) at(dir string) string {
	if dir == "" {
		return c.cwd
	}
	return dir
}

func (c *Client) checked(args []string, at string) (string, error) {
	return c.checkedWith(args, at, false, nil)
}

func (c *Client) checkedWith(args []string, at string, progress bool, input *string) (string, error) {
	if c.hasRepositoryEnvironment() {
		return "", errors.New("Unset Git repository override environment variables before running git-dedup storage operations")
	}
	mode := captured
	if progress {
		mode = tee
	}
	result, err := c.git(args, at, mode, input)
	if err != nil {
		return "", err
	}
	if result.code != 0 {
		return "", errorf("git %s failed: %s", strings.Join(args, " "), trim(result.stderr))
	}
	return trim(result.stdout), nil
}

func (c *Client) passthrough(args []string, at string) (int, error) {
	result, err := c.git(args, at, inherited, nil)
	return result.code, err
}

// StorePath returns the canonical store directory.
func (c *Client) StorePath() string {
	configured := lookupEnv(c.env, "GIT_DEDUP_STORE")
	if configured == "" {
		configured = lookupEnv(c.env, "GITX_STORE")
	}
	if configured != "" {
		return canonicalPath(resolvePath(c.cwd, expandHome(configured)))
	}
	for _, legacy := range []string{"~/.cache/gitx", "~/.gitx"} {
		path := expandHome(legacy)
		if readTextOr(filepath.Join(path, ".gitx-store"), "") == storeMarker {
			return canonicalPath(path)
		}
	}
	return canonicalPath(expandHome("~/.git-dedup"))
}

// Run runs a git-dedup command line and returns Git's exit code.
func (c *Client) Run(args []string) (int, error) {
	parsed, ok := parseGlobal(args, c.cwd)
	if lookupEnv(c.incomingEnv, "GITX_ACTIVE") == "1" || lookupEnv(c.incomingEnv, "GIT_DEDUP_ACTIVE") == "1" || !ok {
		return c.passthrough(args, c.cwd)
	}
	managed := parsed.command == "clone" || parsed.command == "fetch" ||
		(parsed.command == "submodule" && len(parsed.rest) > 0 && (parsed.rest[0] == "add" || parsed.rest[0] == "update")) ||
		(parsed.command == "worktree" && len(parsed.rest) > 0 && parsed.rest[0] == "add")
	if c.hasRepositoryEnvironment() {
		if managed {
			c.fallback(parsed.rest, "Git repository environment variables are set")
		}
		return c.passthrough(args, c.cwd)
	}
	// Actions supplies per-command configuration (including authentication).
	// Carry it into every underlying Git call rather than dropping it on the pool fetch.
	if parsed.command == "fetch" {
		var settings [][2]string
		var remaining []string
		for i := 0; i < len(parsed.prefix); i++ {
			arg := parsed.prefix[i]
			if strings.HasPrefix(arg, "-c") {
				setting := arg[2:]
				if arg == "-c" {
					i++
					setting = parsed.prefix[i]
				}
				settings = append(settings, configSetting(setting))
				continue
			}
			remaining = append(remaining, arg)
			if slices.Contains([]string{"-C", "--git-dir", "--work-tree", "--namespace", "--config-env"}, arg) {
				i++
				remaining = append(remaining, parsed.prefix[i])
			}
		}
		if len(settings) > 0 {
			options := c.options
			options.Env = withConfig(c.incomingEnv, settings)
			child := New(options)
			child.stderr, child.stdout, child.stdin = c.stderr, c.stdout, c.stdin
			return child.Run(append(append(remaining, "fetch"), parsed.rest...))
		}
	}
	// -C is resolved explicitly. Other global options can change Git semantics, so forward intact.
	for i := 0; i < len(parsed.prefix); i++ {
		arg := parsed.prefix[i]
		if arg == "-C" {
			i++
			continue
		}
		if managed {
			c.fallback(parsed.rest, "global option "+optionName(arg)+" is not supported")
		}
		// ponytail: a clone forwarded here (or with repository environment variables) is not checked for pool
		// borrowing; options like -C and --git-dir move where it lands. Pin it with `store add` if needed.
		return c.passthrough(args, c.cwd)
	}
	if parsed.cwd != c.cwd {
		options := c.options
		options.Cwd = parsed.cwd
		options.Env = c.incomingEnv
		child := New(options)
		child.stderr, child.stdout, child.stdin = c.stderr, c.stdout, c.stdin
		return child.Run(append([]string{parsed.command}, parsed.rest...))
	}
	switch parsed.command {
	case "clone":
		code, handled, err := c.clone(parsed.rest, parsed.cwd)
		if err != nil || handled {
			return code, err
		}
	case "fetch":
		code, handled, err := c.fetchCheckout(parsed.rest)
		if err != nil || handled {
			return code, err
		}
	case "submodule":
		return c.updateSubmodules(parsed.rest, parsed.cwd)
	case "worktree":
		return c.addWorktree(parsed.rest, parsed.cwd)
	}
	return c.passthrough(args, c.cwd)
}

// fallback reports a handled command that is forwarded to plain Git, unless Git was asked to be quiet.
func (c *Client) fallback(args []string, reason string) {
	if !slices.Contains(args, "-q") && !slices.Contains(args, "--quiet") {
		c.warn("git-dedup: " + reason + "; using plain Git\n")
	}
}

// GitVersion returns the underlying Git version line, such as `git version 2.50.1`.
func (c *Client) GitVersion() (string, error) {
	result, err := c.git([]string{"--version"}, c.cwd, captured, nil)
	if err != nil {
		return "", err
	}
	if result.code != 0 {
		return "", errorf("git --version failed: %s", trim(result.stderr))
	}
	return trim(result.stdout), nil
}
