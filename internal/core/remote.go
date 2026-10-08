package core

import (
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var (
	scpRemote      = regexp.MustCompile(`^([^/@:]+)@([^/:]+):(.+)$`)
	keyPart        = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	leadingSlashes = regexp.MustCompile(`^/+`)
	gitSuffix      = regexp.MustCompile(`\.git/?$`)
)

// KeyForRemote returns the store key for a network remote, or "" when the remote cannot be keyed.
func KeyForRemote(remote string) string {
	var host, port, pathname string
	var user *string
	if m := scpRemote.FindStringSubmatch(remote); m != nil {
		user, host, pathname = &m[1], m[2], m[3]
		if !strings.HasPrefix(pathname, "/") {
			pathname = "/~/" + pathname
		}
	} else {
		parsed, ok := parseNetworkURL(remote)
		if !ok {
			return ""
		}
		host = parsed.hostname
		// `:` cannot appear in a host name, so ports never collide with hosts.
		if parsed.port != "" {
			port = ":" + parsed.port
		}
		if parsed.scheme == "ssh" {
			user = &parsed.username
		}
		pathname = parsed.pathname
	}
	// Home-relative SSH paths differ per user; `git` is the shared hosting account convention.
	home := ""
	if user != nil && strings.HasPrefix(pathname, "/~/") {
		pathname = pathname[2:]
		if *user != "git" {
			home = "~" + *user + "/"
		}
	}
	parts := strings.Split(gitSuffix.ReplaceAllString(leadingSlashes.ReplaceAllString(pathname, ""), ""), "/")
	if host == "" || len(parts) < 2 {
		return ""
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || !keyPart.MatchString(part) {
			return ""
		}
	}
	if !keyPart.MatchString(host) {
		return ""
	}
	return strings.ToLower(host) + port + "/" + home + strings.Join(parts, "/")
}

type networkURL struct {
	scheme, username, hostname, port, pathname string
}

// parseNetworkURL reads the parts of a WHATWG URL that store keys use, for the schemes Git fetches over.
func parseNetworkURL(remote string) (networkURL, bool) {
	parsed, err := url.Parse(remote)
	if err != nil || parsed.Opaque != "" {
		return networkURL{}, false
	}
	scheme := strings.ToLower(parsed.Scheme)
	special := scheme == "http" || scheme == "https"
	if !special && scheme != "ssh" && scheme != "git" {
		return networkURL{}, false
	}
	result := networkURL{scheme: scheme, hostname: parsed.Hostname()}
	if special {
		result.hostname = strings.ToLower(result.hostname)
	}
	if parsed.User != nil {
		result.username = parsed.User.Username()
	}
	if raw := parsed.Port(); raw != "" {
		number, err := strconv.Atoi(raw)
		if err != nil || number > 65535 {
			return networkURL{}, false
		}
		if !(scheme == "http" && number == 80) && !(scheme == "https" && number == 443) {
			result.port = strconv.Itoa(number)
		}
	}
	result.pathname = removeDotSegments(parsed.EscapedPath())
	if result.pathname == "" && special {
		result.pathname = "/"
	}
	return result, true
}

// removeDotSegments normalizes `.` and `..` path segments as the WHATWG URL parser does.
func removeDotSegments(path string) string {
	if path == "" {
		return ""
	}
	segments := strings.Split(path, "/")[1:]
	out := []string{}
	for i, segment := range segments {
		last := i == len(segments)-1
		switch segment {
		case ".":
			if last {
				out = append(out, "")
			}
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, segment)
		}
	}
	return "/" + strings.Join(out, "/")
}

func optionName(arg string) string {
	return strings.SplitN(arg, "=", 2)[0]
}

type cloneRequest struct {
	remote      string
	destination string
	recurse     bool
	forwarded   []string
}

// parseClone returns the parsed clone, or the reason git-dedup cannot handle it.
func parseClone(args []string) (cloneRequest, string) {
	var positional []string
	request := cloneRequest{forwarded: []string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if arg == "-b" || arg == "--branch" {
			i++
			if i >= len(args) || args[i] == "" {
				return cloneRequest{}, "clone option " + arg + " requires a value"
			}
			request.forwarded = append(request.forwarded, arg, args[i])
			continue
		}
		if strings.HasPrefix(arg, "--branch=") {
			request.forwarded = append(request.forwarded, arg)
			continue
		}
		// VS Code's Git: Clone passes --recursive, Git's alias for --recurse-submodules.
		if arg == "--recurse-submodules" || arg == "--recursive" {
			request.recurse = true
			continue
		}
		if slices.Contains([]string{"-q", "--quiet", "-v", "--verbose", "--progress", "--no-tags", "--sparse"}, arg) {
			request.forwarded = append(request.forwarded, arg)
			continue
		}
		if strings.HasPrefix(arg, "-") {
			return cloneRequest{}, "clone option " + optionName(arg) + " is not supported"
		}
		positional = append(positional, arg)
	}
	if len(positional) < 1 || len(positional) > 2 {
		return cloneRequest{}, "clone expects a repository and an optional directory"
	}
	if slices.Contains(positional, "") {
		return cloneRequest{}, "clone does not support an empty argument"
	}
	request.remote = positional[0]
	if len(positional) == 2 {
		request.destination = positional[1]
	}
	return request, ""
}

var (
	trailingSlashes = regexp.MustCompile(`/+$`)
	slashedGitDir   = regexp.MustCompile(`/+\.git$`)
	pathSeparators  = regexp.MustCompile(`[/:]`)
	dotGitSuffix    = regexp.MustCompile(`\.git$`)
)

func defaultCloneName(remote string) string {
	// Like Git, a local `repo/.git` (or `repo//.git`) clones into `repo`.
	name := slashedGitDir.ReplaceAllString(trailingSlashes.ReplaceAllString(remote, ""), "")
	parts := pathSeparators.Split(name, -1)
	return dotGitSuffix.ReplaceAllString(parts[len(parts)-1], "")
}

func submoduleAddPath(args []string) string {
	var positional []string
	for i := 1; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		// Options of `git submodule add` that take a separate value.
		if slices.Contains([]string{"-b", "--branch", "--reference", "--ref-format", "--name", "--depth"}, arg) {
			i++
		} else if !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
		}
	}
	switch len(positional) {
	case 1:
		return defaultCloneName(positional[0])
	case 2:
		return positional[1]
	}
	return ""
}

var scpPrefix = regexp.MustCompile(`^[^/@:]+@[^/:]+:.+`)

func resolveSubmoduleRemote(parent, child string) string {
	if !strings.HasPrefix(child, "./") && !strings.HasPrefix(child, "../") {
		return child
	}
	if KeyForRemote(parent) == "" {
		return ""
	}
	if scpPrefix.MatchString(parent) {
		at := strings.Index(parent, ":")
		base := strings.Split(parent[at+1:], "/")
		for _, part := range strings.Split(child, "/") {
			if part == ".." {
				if len(base) > 0 {
					base = base[:len(base)-1]
				}
			} else if part != "." {
				base = append(base, part)
			}
		}
		return parent[:at+1] + strings.Join(base, "/")
	}
	if !strings.HasSuffix(parent, "/") {
		parent += "/"
	}
	base, err := url.Parse(parent)
	if err != nil {
		return ""
	}
	reference, err := url.Parse(child)
	if err != nil {
		return ""
	}
	return base.ResolveReference(reference).String()
}

type globalArgs struct {
	prefix  []string
	command string
	rest    []string
	cwd     string
}

var prefixedGlobal = regexp.MustCompile(`^(--git-dir|--work-tree|--namespace|--config-env)=`)

func parseGlobal(args []string, cwd string) (globalArgs, bool) {
	prefix := []string{}
	for i := 0; i < len(args); {
		arg := args[i]
		switch arg {
		case "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env":
			if i+1 >= len(args) || args[i+1] == "" {
				return globalArgs{}, false
			}
			prefix = append(prefix, arg, args[i+1])
			if arg == "-C" {
				cwd = resolvePath(cwd, args[i+1])
			}
			i += 2
			continue
		}
		if prefixedGlobal.MatchString(arg) || strings.HasPrefix(arg, "-c") {
			prefix = append(prefix, arg)
			i++
			continue
		}
		if strings.HasPrefix(arg, "-") {
			return globalArgs{}, false
		}
		return globalArgs{prefix: prefix, command: arg, rest: args[i+1:], cwd: cwd}, true
	}
	return globalArgs{}, false
}

var (
	httpScheme      = regexp.MustCompile(`(?i)^https?:`)
	remoteAuthority = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*://)([^/?#]*)@`)
)

// redactRemote keeps URL credentials out of the store; Git credential helpers supply them at fetch time.
// HTTP(S) userinfo is a credential. Other schemes keep the user name, which SSH needs.
func redactRemote(remote, mask string) string {
	m := remoteAuthority.FindStringSubmatchIndex(remote)
	if m == nil {
		return remote
	}
	scheme, userinfo := remote[m[2]:m[3]], remote[m[4]:m[5]]
	user := ""
	if !httpScheme.MatchString(scheme) {
		user = strings.SplitN(userinfo, ":", 2)[0]
	}
	if user == userinfo {
		return remote
	}
	kept := user
	if mask != "" {
		if user != "" {
			kept += ":"
		}
		kept += mask
	}
	replacement := scheme
	if kept != "" {
		replacement += kept + "@"
	}
	return replacement + remote[m[1]:]
}

var (
	refCollision    = regexp.MustCompile(`(?i)cannot lock ref|reference already exists|case.insensitive|refname collision`)
	networkFailure  = regexp.MustCompile(`(?i)could not resolve host|connection refused|network is unreachable`)
	formatFailure   = regexp.MustCompile(`(?i)Unsupported Git object format`)
	gitFailureLines = regexp.MustCompile(`\b(?:fatal|error): [^\r\n]*`)
)

func addFailureReason(err error, stage string) string {
	message := err.Error()
	switch {
	case refCollision.MatchString(message):
		return "ref collision in the shared pool"
	case stage == "remote fetch" || networkFailure.MatchString(message):
		return "remote fetch failed"
	case formatFailure.MatchString(message):
		return "unsupported object format"
	}
	return "Git storage operation failed"
}

// gitFailure is the last Git `fatal:` or `error:` line of a failure, without captured progress output.
func gitFailure(err error) string {
	if err == nil {
		return ""
	}
	lines := gitFailureLines.FindAllString(err.Error(), -1)
	if len(lines) == 0 {
		return ""
	}
	return " (" + strings.TrimSpace(lines[len(lines)-1]) + ")"
}
