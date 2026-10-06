package cli

import (
	"embed"
	"fmt"
	"slices"
	"strings"
)

//go:embed help/*.txt
var helpFiles embed.FS

const (
	description    = "Faster checkouts, a fraction of the disk space: share one copy of Git history across clones, worktrees, and submodules"
	statsSummary   = "Show object pool use and checkout adoption measurements"
	verboseSummary = "Show full Git errors for skipped and failed repositories"
)

type flagDef struct {
	name    string
	kind    string // "boolean" or "string"
	alias   string
	summary string
	choices []string
	// def is the default value shown in documentation: false for booleans, or a string.
	def any
}

type argDef struct {
	name     string
	required bool
	kind     string
	summary  string
}

type commandDef struct {
	name    string // full name, such as "git-dedup store add"
	summary string
	group   bool
	args    []argDef
	flags   []flagDef
	help    string // embedded help file
}

func boolFlag(name, summary string) flagDef {
	return flagDef{name: name, kind: "boolean", summary: summary, def: false}
}

// commands mirrors the yargs command tree of the Node CLI, in its documentation order.
var commands = []commandDef{
	{
		name:    "git-dedup docgen",
		summary: "Write the OpenCLI document to a file, or stdout if --output is omitted",
		flags: []flagDef{
			{name: "output", kind: "string", alias: "o", summary: "Output file; defaults to stdout"},
			{name: "format", kind: "string", summary: "Output format", choices: []string{"json", "yaml", "markdown"}, def: "json"},
		},
		help: "docgen",
	},
	{name: "git-dedup store", summary: "store commands", group: true, help: "store"},
	{
		name:    "git-dedup store add",
		summary: "Add a local checkout to the shared store; linked checkouts depend on it",
		args:    []argDef{{name: "path", kind: "string", summary: "Local checkout path (defaults to the current directory)"}},
		flags: []flagDef{
			boolFlag("stats", "Show the change in private pack storage"),
			boolFlag("all", "Discover and add all checkouts under the directory"),
			boolFlag("dry-run", "Preview checkouts discovered by --all without adding them"),
			boolFlag("verbose", verboseSummary),
		},
		help: "store-add",
	},
	{name: "git-dedup store fetch", summary: "Fetch registered remotes into the shared object pool", help: "store-fetch"},
	{name: "git-dedup store gc", summary: "Compact the shared object pool without pruning consumer objects", help: "store-gc"},
	{name: "git-dedup store list", summary: "List remotes registered in the shared store", help: "store-list"},
	{name: "git-dedup store prune", summary: "Reclaim pool objects that no registered checkout uses", help: "store-prune"},
	{
		name:    "git-dedup store remove",
		summary: "Detach a checkout and its submodules from the shared store",
		args:    []argDef{{name: "path", required: true, kind: "string", summary: "Local checkout path"}},
		flags: []flagDef{
			boolFlag("verbose", verboseSummary),
			boolFlag("forget", "Release a deleted checkout so store prune can reclaim its objects"),
		},
		help: "store-remove",
	},
	{
		name:    "git-dedup clone",
		summary: "Clone a repository through the shared store when supported",
		args:    []argDef{{name: "repository", required: true}, {name: "directory"}},
	},
}

var rootCommand = commandDef{name: "git-dedup", help: "root"}

var globalFlags = []flagDef{
	{name: "version", kind: "boolean"},
	{name: "help", kind: "boolean"},
	{name: "stats", kind: "boolean", summary: statsSummary},
}

func lookupCommand(name string) *commandDef {
	for i := range commands {
		if commands[i].name == name {
			return &commands[i]
		}
	}
	return nil
}

func helpText(command *commandDef) string {
	data, err := helpFiles.ReadFile("help/" + command.help + ".txt")
	if err != nil {
		panic(err)
	}
	return string(data)
}

// invocation is a parsed git-dedup command line for one of git-dedup's own commands.
type invocation struct {
	command    *commandDef
	positional []string
	flags      map[string]string
	help       bool
	version    bool
	stats      bool
	problem    string
}

func camelCase(name string) string {
	parts := strings.Split(name, "-")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

// parse reads arguments like the Node CLI's strict yargs parser.
func parse(args []string) invocation {
	result := invocation{command: &rootCommand, flags: map[string]string{}}
	var words, unknown []string
	var options []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			words = append(words, args[i+1:]...)
			break
		}
		if strings.HasPrefix(arg, "-") && arg != "-" {
			// A string option takes the next argument as its value.
			if !strings.Contains(arg, "=") && i+1 < len(args) && takesValue(args, arg) {
				arg += "=" + args[i+1]
				i++
			}
			options = append(options, arg)
			continue
		}
		words = append(words, arg)
	}
	// Resolve the command from the leading words.
	if len(words) > 0 && (words[0] == "store" || words[0] == "docgen") {
		result.command = lookupCommand("git-dedup " + words[0])
		words = words[1:]
		if result.command.group && len(words) > 0 {
			if sub := lookupCommand(result.command.name + " " + words[0]); sub != nil {
				result.command = sub
				words = words[1:]
			}
		}
	}
	allowed := append(slices.Clone(globalFlags), result.command.flags...)
	for _, option := range options {
		name, value, hasValue := strings.Cut(strings.TrimLeft(option, "-"), "=")
		negated := false
		flag := findFlag(allowed, name)
		if flag == nil && strings.HasPrefix(name, "no-") {
			if flag = findFlag(allowed, name[3:]); flag != nil && flag.kind == "boolean" {
				negated = true
			} else {
				flag = nil
			}
		}
		if flag == nil {
			unknown = append(unknown, name)
			continue
		}
		if flag.kind == "string" {
			result.flags[flag.name] = value
			continue
		}
		enabled := !negated
		if hasValue {
			enabled = value != "false"
			if negated {
				enabled = !enabled
			}
		}
		switch flag.name {
		case "help":
			result.help = enabled
		case "version":
			result.version = enabled
		case "stats":
			// The global flag and store add's own --stats share one value, as in yargs.
			result.stats = enabled
			result.flags["stats"] = fmt.Sprint(enabled)
		default:
			result.flags[flag.name] = fmt.Sprint(enabled)
		}
	}
	maxArgs := len(result.command.args)
	if len(words) > maxArgs {
		unknown = append(unknown, words[maxArgs:]...)
		words = words[:maxArgs]
	}
	result.positional = words
	switch {
	case len(unknown) == 1:
		result.problem = "Unknown argument: " + unknown[0]
	case len(unknown) > 1:
		result.problem = "Unknown arguments: " + strings.Join(unknown, ", ")
	}
	if result.problem == "" {
		required := 0
		for _, arg := range result.command.args {
			if arg.required {
				required++
			}
		}
		if len(words) < required {
			result.problem = fmt.Sprintf("Not enough non-option arguments: got %d, need at least %d", len(words), required)
		}
	}
	if format, ok := result.flags["format"]; ok && result.problem == "" && !slices.Contains([]string{"json", "yaml", "markdown"}, format) {
		result.problem = fmt.Sprintf("Invalid values:\n  Argument: format, Given: %q, Choices: \"json\", \"yaml\", \"markdown\"", format)
	}
	return result
}

// takesValue reports whether a separate argument after arg is the value of a string option.
func takesValue(args []string, arg string) bool {
	name := strings.TrimLeft(arg, "-")
	return (name == "output" || name == "o" || name == "format") && slices.Contains(args, "docgen")
}

func findFlag(flags []flagDef, name string) *flagDef {
	for i := range flags {
		if flags[i].name == name || camelCase(flags[i].name) == name || (flags[i].alias != "" && flags[i].alias == name) {
			return &flags[i]
		}
	}
	return nil
}

func (inv invocation) flag(name string) bool {
	return inv.flags[name] == "true"
}
