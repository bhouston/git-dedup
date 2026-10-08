package core

import (
	"slices"
	"testing"
)

func TestKeyForRemote(t *testing.T) {
	for _, remote := range []string{
		"git@github.com:team/project.git",
		"git@github.com:/team/project.git",
		"ssh://git@github.com/team/project.git",
		"ssh://git@github.com/~/team/project.git",
		"https://github.com/team/project.git",
		"https://user@github.com/team/project",
		"https://GitHub.com:443/team/project",
		"http://github.com/team/project",
		"git://github.com/team/project.git",
	} {
		if got := KeyForRemote(remote); got != "github.com/team/project" {
			t.Errorf("KeyForRemote(%q) = %q", remote, got)
		}
	}
	for remote, want := range map[string]string{
		"alice@server:/srv/project.git":      "server/srv/project",
		"ssh://alice@server/srv/project.git": "server/srv/project",
		"alice@server:proj/x.git":            "server/~alice/proj/x",
		"git://127.0.0.1:9418/team/p.git":    "127.0.0.1:9418/team/p",
		"https://host/a/./b/../c":            "host/a/c",
		"/tmp/project.git":                   "",
		"file:///tmp/project.git":            "",
		"https://host/only":                  "",
		"https://host/a%20b/c":               "",
		"https://[::1]/a/b":                  "",
	} {
		if got := KeyForRemote(remote); got != want {
			t.Errorf("KeyForRemote(%q) = %q, want %q", remote, got, want)
		}
	}
	distinct := map[string]bool{}
	for _, remote := range []string{"alice@server:proj/x.git", "bob@server:proj/x.git", "alice@server:/proj/x.git", "http://h_8080/a/b", "http://h:8080/a/b"} {
		distinct[KeyForRemote(remote)] = true
	}
	if len(distinct) != 5 || distinct[""] {
		t.Errorf("distinct remotes share keys: %v", distinct)
	}
}

func TestRedactRemote(t *testing.T) {
	for _, c := range []struct{ remote, mask, want string }{
		{"https://user:token@github.com/team/project", "", "https://github.com/team/project"},
		{"https://user:token@github.com/team/project", "***", "https://***@github.com/team/project"},
		{"ssh://git:secret@host/x/y", "", "ssh://git@host/x/y"},
		{"ssh://git:secret@host/x/y", "***", "ssh://git:***@host/x/y"},
		{"ssh://git@host/x/y", "***", "ssh://git@host/x/y"},
		{"git@github.com:team/project.git", "***", "git@github.com:team/project.git"},
	} {
		if got := redactRemote(c.remote, c.mask); got != c.want {
			t.Errorf("redactRemote(%q, %q) = %q, want %q", c.remote, c.mask, got, c.want)
		}
	}
}

func TestParseClone(t *testing.T) {
	request, reason := parseClone([]string{"-q", "--recursive", "-b", "main", "--", "https://h/a/b", "dir"})
	if reason != "" || request.remote != "https://h/a/b" || request.destination != "dir" || !request.recurse ||
		!slices.Equal(request.forwarded, []string{"-q", "-b", "main"}) {
		t.Errorf("parseClone = %+v, %q", request, reason)
	}
	for _, c := range []struct {
		args []string
		want string
	}{
		// History-narrowing options keep their meaning: plain Git handles the clone.
		{[]string{"--depth=1", "https://h/a/b"}, "clone option --depth is not supported"},
		{[]string{"--depth", "1", "https://h/a/b"}, "clone option --depth is not supported"},
		{[]string{"--shallow-since=2020-01-01", "https://h/a/b"}, "clone option --shallow-since is not supported"},
		{[]string{"--filter=blob:none", "https://h/a/b"}, "clone option --filter is not supported"},
		{[]string{"--single-branch", "https://h/a/b"}, "clone option --single-branch is not supported"},
		{[]string{"--mirror", "https://h/a/b"}, "clone option --mirror is not supported"},
		{[]string{"https://h/a/b", "-b"}, "clone option -b requires a value"},
		{[]string{"a", "b", "c"}, "clone expects a repository and an optional directory"},
		{[]string{"https://h/a/b", ""}, "clone does not support an empty argument"},
	} {
		if _, reason := parseClone(c.args); reason != c.want {
			t.Errorf("parseClone(%q) reason = %q, want %q", c.args, reason, c.want)
		}
	}
}

func TestDefaultCloneName(t *testing.T) {
	for remote, want := range map[string]string{
		"https://h/team/project.git": "project",
		"git@h:team/project.git":     "project",
		"/srv/repo/.git":             "repo",
		"/srv/repo//.git/":           "repo",
		"host:project":               "project",
	} {
		if got := defaultCloneName(remote); got != want {
			t.Errorf("defaultCloneName(%q) = %q, want %q", remote, got, want)
		}
	}
}

func TestResolveSubmoduleRemote(t *testing.T) {
	for _, c := range []struct{ parent, child, want string }{
		{"https://h/team/super.git", "../child.git", "https://h/team/child.git"},
		{"https://h/team/super.git", "./nested", "https://h/team/super.git/nested"},
		{"git@h:team/super.git", "../child.git", "git@h:team/child.git"},
		{"https://h/team/super.git", "https://other/x/y", "https://other/x/y"},
		{"/local/super", "../child", ""},
	} {
		if got := resolveSubmoduleRemote(c.parent, c.child); got != c.want {
			t.Errorf("resolveSubmoduleRemote(%q, %q) = %q, want %q", c.parent, c.child, got, c.want)
		}
	}
}

func TestParseGlobal(t *testing.T) {
	parsed, ok := parseGlobal([]string{"-C", "sub", "-c", "a=b", "--git-dir=x", "clone", "url"}, "/base")
	if !ok || parsed.command != "clone" || !slices.Equal(parsed.rest, []string{"url"}) ||
		!slices.Equal(parsed.prefix, []string{"-C", "sub", "-c", "a=b", "--git-dir=x"}) {
		t.Errorf("parseGlobal = %+v, %v", parsed, ok)
	}
	for _, args := range [][]string{{"--version"}, {"-C"}, {"-C", ""}, {"-Cdir", "status"}, {}} {
		if _, ok := parseGlobal(args, "/base"); ok {
			t.Errorf("parseGlobal(%q) accepted", args)
		}
	}
}

func TestSubmoduleAddPath(t *testing.T) {
	for want, args := range map[string][]string{
		"project": {"add", "https://h/team/project.git"},
		"lib/x":   {"add", "-b", "main", "--name", "n", "https://h/a/b", "lib/x"},
		"-dashed": {"add", "--", "https://h/a/b", "-dashed"},
		"":        {"add"},
	} {
		if got := submoduleAddPath(args); got != want {
			t.Errorf("submoduleAddPath(%q) = %q, want %q", args, got, want)
		}
	}
}

func TestGitFailureAndReasons(t *testing.T) {
	err := errorf("git fetch failed: remote: progress\nerror: first\nfatal: last one\n")
	if got := gitFailure(err); got != " (fatal: last one)" {
		t.Errorf("gitFailure = %q", got)
	}
	for message, want := range map[string]string{
		"cannot lock ref 'refs/x'":      "ref collision in the shared pool",
		"Could not resolve host: h":     "remote fetch failed",
		"Unsupported Git object format": "unsupported object format",
		"something else":                "Git storage operation failed",
	} {
		if got := addFailureReason(errorf("%s", message), "sharing objects"); got != want {
			t.Errorf("addFailureReason(%q) = %q, want %q", message, got, want)
		}
	}
}
