package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/bcdxn/opencli/validate"
)

func TestHumanizeBytes(t *testing.T) {
	// Expected values come from humanize-units, which the Node CLI uses.
	for bytes, want := range map[int64]string{
		0: "0B", 999: "999B", 1000: "1kB", 1125: "1.13kB", 1234: "1.23kB", 12345: "12.3kB",
		123456: "123kB", 999999: "1000kB", 1500000: "1.5MB", 2500000000: "2.5GB",
	} {
		if got := humanizeBytes(bytes); got != want {
			t.Errorf("humanizeBytes(%d) = %q, want %q", bytes, got, want)
		}
	}
}

// run runs git-dedup's own commands in process. The cases below never reach the store or Git.
func run(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	a := &app{version: "1.2.3", stdout: &out, stderr: &errOut}
	code, err := a.main(args)
	if err != nil {
		errOut.WriteString("Error: " + err.Error() + "\n")
		code = 1
	}
	return code, out.String(), errOut.String()
}

func TestCommandLine(t *testing.T) {
	for _, c := range []struct {
		args   []string
		code   int
		stdout string
		stderr string
	}{
		// A bare invocation writes help to stderr; --help writes it to stdout.
		{nil, 0, "", "COMMANDS:"},
		{[]string{"--help"}, 0, "COMMANDS:", ""},
		{[]string{"--stats"}, 0, "COMMANDS:", ""},
		{[]string{"store", "--help"}, 0, "remove", ""},
		{[]string{"store", "add", "--help"}, 0, "--dry-run", ""},
		// --version with anything else prints only git-dedup's version.
		{[]string{"--version", "--stats"}, 0, "1.2.3\n", ""},
		{[]string{"store", "list", "--version"}, 0, "1.2.3\n", ""},
		{[]string{"store", "remove"}, 1, "", `Required argument "path" not set`},
		{[]string{"store", "refresh"}, 1, "", `unknown command "refresh"`},
		{[]string{"store", "list", "extra"}, 1, "", `unexpected argument "extra"`},
		{[]string{"store", "list", "--bogus"}, 1, "", "flag provided but not defined: -bogus"},
		{[]string{"store", "add", "--dry-run"}, 1, "", "Error: --dry-run requires --all\n"},
		{[]string{"docgen", "--format=xml"}, 1, "", `invalid value "xml" for flag --format`},
	} {
		code, stdout, stderr := run(t, c.args...)
		if code != c.code || !strings.Contains(stdout, c.stdout) || !strings.Contains(stderr, c.stderr) ||
			(c.stdout == "" && stdout != "") || (c.stderr == "" && stderr != "") {
			t.Errorf("git-dedup %q = %d\nstdout: %s\nstderr: %s", c.args, code, stdout, stderr)
		}
	}
}

func TestDocgen(t *testing.T) {
	code, data, stderr := run(t, "docgen")
	if code != 0 || stderr != "" {
		t.Fatalf("docgen = %d: %s", code, stderr)
	}
	if err := validate.ValidateJSON([]byte(data)); err != nil {
		t.Errorf("invalid OpenCLI JSON: %v\n%s", err, data)
	}
	var doc struct {
		Info     struct{ Title, Version string }
		Global   struct{ Flags []struct{ Name string } }
		Commands map[string]struct {
			Args []struct {
				Name     string
				Required bool
			}
			Flags []struct {
				Name    string
				Choices []struct{ Value string }
			}
		}
	}
	if err := json.Unmarshal([]byte(data), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Info.Title != "git-dedup" || doc.Info.Version != "1.2.3" ||
		!slices.ContainsFunc(doc.Global.Flags, func(f struct{ Name string }) bool { return f.Name == "stats" }) {
		t.Errorf("document = %s", data)
	}
	for _, name := range []string{"store", "store add", "store fetch", "store list", "store gc", "store remove", "store prune", "docgen", "clone"} {
		if _, ok := doc.Commands["git-dedup "+name]; !ok {
			t.Errorf("document lacks git-dedup %s", name)
		}
	}
	if clone := doc.Commands["git-dedup clone"].Args; len(clone) != 2 || clone[0].Name != "repository" || !clone[0].Required || clone[1].Required {
		t.Errorf("clone args = %+v", clone)
	}
	if remove := doc.Commands["git-dedup store remove"].Args; len(remove) != 1 || !remove[0].Required {
		t.Errorf("store remove args = %+v", remove)
	}
	if format := doc.Commands["git-dedup docgen"].Flags[1]; format.Name != "format" || len(format.Choices) != 3 {
		t.Errorf("docgen format flag = %+v", format)
	}

	code, yaml, _ := run(t, "docgen", "--format", "yaml")
	if err := validate.ValidateYAML([]byte(yaml)); code != 0 || err != nil {
		t.Errorf("invalid OpenCLI YAML (%d): %v\n%s", code, err, yaml)
	}

	_, markdown, _ := run(t, "docgen", "--format", "markdown")
	for _, want := range []string{"## git-dedup store add\n", "## git-dedup clone\n", "git-dedup store add [<path>] [--stats] [--all] [--dry-run] [--verbose]"} {
		if !strings.Contains(markdown, want) {
			t.Errorf("markdown lacks %q:\n%s", want, markdown)
		}
	}

	output := filepath.Join(t.TempDir(), "out.json")
	if code, stdout, _ := run(t, "docgen", "-o", output); code != 0 || stdout != "" {
		t.Errorf("docgen -o = %d, %q", code, stdout)
	}
	if written, err := os.ReadFile(output); err != nil || string(written) != data {
		t.Errorf("docgen -o wrote %q, %v", written, err)
	}
}
