package cli

import (
	"encoding/json"
	"strings"
	"testing"
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

func TestParse(t *testing.T) {
	for _, c := range []struct {
		args    []string
		command string
		problem string
	}{
		{[]string{"store"}, "git-dedup store", ""},
		{[]string{"store", "add", "x", "--dry-run", "--all", "--verbose"}, "git-dedup store add", ""},
		{[]string{"--stats", "store", "add"}, "git-dedup store add", ""},
		{[]string{"store", "remove"}, "git-dedup store remove", "Not enough non-option arguments: got 0, need at least 1"},
		{[]string{"store", "refresh"}, "git-dedup store", "Unknown argument: refresh"},
		{[]string{"store", "list", "a", "--bogus"}, "git-dedup store list", "Unknown arguments: bogus, a"},
		{[]string{"docgen", "-o", "out.json", "--format", "yaml"}, "git-dedup docgen", ""},
		{[]string{"docgen", "--format=xml"}, "git-dedup docgen", "Invalid values:\n  Argument: format, Given: \"xml\", Choices: \"json\", \"yaml\", \"markdown\""},
	} {
		inv := parse(c.args)
		if inv.command.name != c.command || inv.problem != c.problem {
			t.Errorf("parse(%q) = %s, %q; want %s, %q", c.args, inv.command.name, inv.problem, c.command, c.problem)
		}
	}
	inv := parse([]string{"store", "add", "--no-stats", "--dryRun=true", "--all"})
	if inv.flag("stats") || !inv.flag("dry-run") || !inv.flag("all") {
		t.Errorf("flags = %v", inv.flags)
	}
	inv = parse([]string{"docgen", "-o", "out.json"})
	if inv.flags["output"] != "out.json" {
		t.Errorf("output = %q", inv.flags["output"])
	}
}

func TestDocument(t *testing.T) {
	data, err := json.Marshal(document("1.2.3"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Info     struct{ Version string }
		Commands map[string]json.RawMessage
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Info.Version != "1.2.3" || len(doc.Commands) != len(commands) || doc.Commands["git-dedup store add"] == nil {
		t.Errorf("document = %s", data)
	}
	markdown := app{version: "1.2.3"}.markdown()
	if !strings.Contains(markdown, "git-dedup store add [<path>] [--stats] [--all] [--dry-run] [--verbose]") {
		t.Errorf("markdown usage missing:\n%s", markdown)
	}
	if yaml := toYAML(document("1.2.3"), 0); !strings.Contains(yaml, "      - name: output\n        type: string\n") {
		t.Errorf("yaml layout:\n%s", yaml)
	}
}
