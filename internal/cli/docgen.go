package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/bcdxn/opencli/adapters/ourfave"
	"github.com/bcdxn/opencli/spec"
	"github.com/urfave/cli/v3"
)

// document describes git-dedup in OpenCLI, generated from the urfave/cli command tree.
func (a *app) document() *spec.Document {
	root := a.command()
	doc := ourfave.GenerateDocument(root,
		ourfave.WithInfo(&spec.Info{Title: "git-dedup", Binary: "git-dedup", Version: a.version, Summary: description}),
		// --version and --stats come from the root command's persistent flags.
		ourfave.WithGlobalFlags([]spec.FlagItem{{Name: "help", Aliases: []string{"h"}, Type: "boolean", Summary: "Show help"}}),
	)
	completeCommand(doc.Commands, root)
	// clone is a Git passthrough that never reaches urfave/cli.
	doc.Commands.Commands = append(doc.Commands.Commands, &spec.CommandItem{
		Segment:     "clone",
		CommandLine: "git-dedup clone",
		Summary:     "Clone a repository through the shared store when supported",
		Kind:        spec.CommandKindAction,
		Args: []spec.ArgumentItem{
			{Name: "repository", Type: "string", Required: true},
			{Name: "directory", Type: "string"},
		},
	})
	return doc
}

// completeCommand fills in what the adapter, written for urfave/cli v3.10, leaves out: required
// arguments and the choices of docgen --format.
func completeCommand(item *spec.CommandItem, command *cli.Command) {
	for i, argument := range command.Arguments {
		if arg, ok := argument.(*cli.StringArg); ok && i < len(item.Args) {
			item.Args[i].Required = arg.Required
		}
	}
	for i := range item.Flags {
		if item.CommandLine == "git-dedup docgen" && item.Flags[i].Name == "format" {
			item.Flags[i].Summary = "Output format"
			for _, format := range docgenFormats {
				item.Flags[i].Choices = append(item.Flags[i].Choices, spec.Choice{Value: format})
			}
		}
	}
	for _, child := range item.Commands {
		if index := slices.IndexFunc(command.Commands, func(c *cli.Command) bool { return c.Name == child.Segment }); index >= 0 {
			completeCommand(child, command.Commands[index])
		}
	}
}

func (a *app) docgen(command *cli.Command) (int, error) {
	format := command.String("format")
	if !validFormat(format) {
		problem := fmt.Errorf("invalid value %q for flag --format: choose one of %s", format, strings.Join(docgenFormats, ", "))
		return 1, a.onUsageError(context.TODO(), command, problem, true)
	}
	doc := a.document()
	var text string
	switch format {
	case "yaml":
		text = toYAML(documentObject(doc), 0)
	case "markdown":
		text = markdown(doc)
	default:
		data, err := json.MarshalIndent(documentObject(doc), "", "  ")
		if err != nil {
			return 1, err
		}
		text = string(data) + "\n"
	}
	if output := command.String("output"); output != "" {
		return 0, os.WriteFile(output, []byte(text), 0o666)
	}
	fmt.Fprint(a.stdout, text)
	return 0, nil
}

// object is a JSON object that keeps its key order.
type object []field

type field struct {
	key   string
	value any
}

func (o object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, f := range o {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, _ := json.Marshal(f.key)
		buf.Write(key)
		buf.WriteByte(':')
		value, err := marshal(f.value)
		if err != nil {
			return nil, err
		}
		buf.Write(value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// marshal encodes like JSON.stringify: without HTML escaping or a trailing newline.
func marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), err
}

// add appends a field unless its value is empty.
func (o object) add(key string, value any) object {
	switch v := value.(type) {
	case nil:
		return o
	case string:
		if v == "" {
			return o
		}
	case bool:
		if !v {
			return o
		}
	case []string:
		if len(v) == 0 {
			return o
		}
	case []object:
		if len(v) == 0 {
			return o
		}
	}
	return append(o, field{key, value})
}

func choiceObjects(choices []spec.Choice) []object {
	var objects []object
	for _, choice := range choices {
		objects = append(objects, object{}.add("value", choice.Value).add("description", choice.Description))
	}
	return objects
}

func flagObjects(flags []spec.FlagItem) []object {
	var objects []object
	for _, flag := range flags {
		objects = append(objects, object{{"name", flag.Name}, {"type", flag.Type}}.
			add("aliases", flag.Aliases).add("summary", flag.Summary).add("description", flag.Description).
			add("required", flag.Required).add("variadic", flag.Variadic).add("hidden", flag.Hidden).
			add("choices", choiceObjects(flag.Choices)).add("default", flag.Default))
	}
	return objects
}

// documentObject serializes an OpenCLI document in the Node CLI's key order. The opencli codec is not used
// because it always writes an empty global.config object, which the OpenCLI schema rejects.
func documentObject(doc *spec.Document) object {
	var commands object
	var visit func(*spec.CommandItem)
	visit = func(item *spec.CommandItem) {
		for _, child := range item.Commands {
			var args []object
			for _, arg := range child.Args {
				args = append(args, object{{"name", arg.Name}, {"required", arg.Required}}.
					add("type", arg.Type).add("summary", arg.Summary).add("description", arg.Description).
					add("variadic", arg.Variadic).add("hidden", arg.Hidden).
					add("choices", choiceObjects(arg.Choices)).add("default", arg.Default))
			}
			o := object{}.add("summary", child.Summary).add("description", child.Description).
				add("aliases", child.Aliases).add("hidden", child.Hidden).add("args", args).add("flags", flagObjects(child.Flags))
			if child.Kind == spec.CommandKindGroup {
				o = append(o, field{"kind", string(child.Kind)})
			}
			commands = append(commands, field{child.CommandLine, o})
			visit(child)
		}
	}
	// The root is the binary itself; info and global describe it.
	visit(doc.Commands)
	info := object{{"title", doc.Info.Title}, {"binary", doc.Info.Binary}, {"version", doc.Info.Version}}.
		add("summary", doc.Info.Summary).add("description", doc.Info.Description)
	result := object{{"opencliVersion", doc.OpenCLIVersion}, {"info", info}, {"commands", commands}}
	if doc.Global != nil {
		result = append(result, field{"global", object{}.add("flags", flagObjects(doc.Global.Flags))})
	}
	return result
}

var plainYAML = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ,;.()'/_-]*$`)

func yamlScalar(value any) string {
	switch v := value.(type) {
	case bool:
		return fmt.Sprint(v)
	case string:
		lower := strings.ToLower(v)
		_, numeric := strconv.ParseFloat(v, 64)
		if plainYAML.MatchString(v) && !strings.HasSuffix(v, " ") && numeric != nil &&
			!slices.Contains([]string{"true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"}, lower) {
			return v
		}
		quoted, _ := marshal(v)
		return string(quoted)
	}
	quoted, _ := marshal(value)
	return string(quoted)
}

// toYAML renders an ordered object tree as block-style YAML.
func toYAML(value any, indent int) string {
	pad := strings.Repeat(" ", indent)
	var out strings.Builder
	switch v := value.(type) {
	case object:
		for _, f := range v {
			out.WriteString(pad + yamlScalar(f.key) + ":")
			out.WriteString(yamlChild(f.value, indent))
		}
	}
	return out.String()
}

func yamlChild(value any, indent int) string {
	switch v := value.(type) {
	case object:
		return "\n" + toYAML(v, indent+2)
	case []object:
		var out strings.Builder
		out.WriteString("\n")
		for _, item := range v {
			body := toYAML(item, indent+4)
			out.WriteString(strings.Repeat(" ", indent+2) + "- " + strings.TrimLeft(body, " "))
		}
		return out.String()
	case []string:
		var out strings.Builder
		out.WriteString("\n")
		for _, item := range v {
			out.WriteString(strings.Repeat(" ", indent+2) + "- " + yamlScalar(item) + "\n")
		}
		return out.String()
	}
	return " " + yamlScalar(value) + "\n"
}

func usage(command *spec.CommandItem, global []spec.FlagItem) string {
	parts := []string{command.CommandLine}
	for _, arg := range command.Args {
		if arg.Required {
			parts = append(parts, "<"+arg.Name+">")
		} else {
			parts = append(parts, "[<"+arg.Name+">]")
		}
	}
	var flags []spec.FlagItem
	for _, flag := range slices.Concat(global, command.Flags) {
		if flag.Name != "help" && flag.Name != "version" &&
			!slices.ContainsFunc(flags, func(f spec.FlagItem) bool { return f.Name == flag.Name }) {
			flags = append(flags, flag)
		}
	}
	for _, flag := range flags {
		if flag.Type == "boolean" {
			parts = append(parts, "[--"+flag.Name+"]")
		} else {
			parts = append(parts, "[--"+flag.Name+" <"+flag.Name+">]")
		}
	}
	return strings.Join(parts, " ")
}

func yesNo(value bool) string {
	if value {
		return "Yes"
	}
	return "No"
}

func flagRows(out *strings.Builder, flags []spec.FlagItem) {
	out.WriteString("| Flag | Type | Required | Description |\n| --- | --- | --- | --- |\n")
	for _, flag := range flags {
		text := flag.Summary
		if len(flag.Aliases) > 0 {
			text += "; Aliases: `" + strings.Join(flag.Aliases, "`, `") + "`"
		}
		if len(flag.Choices) > 0 {
			var choices []string
			for _, choice := range flag.Choices {
				choices = append(choices, fmt.Sprint(choice.Value))
			}
			text += "; Choices: " + strings.Join(choices, ", ")
		}
		if flag.Default != nil {
			text += fmt.Sprintf("; Default: `%v`", flag.Default)
		}
		fmt.Fprintf(out, "| `--%s` | %s | %s | %s |\n", flag.Name, flag.Type, yesNo(flag.Required), text)
	}
}

// markdown renders the document with one "## <command line>" section per command.
func markdown(doc *spec.Document) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\n%s\n\nBinary: `%s` · Version: `%s`\n\n", doc.Info.Title, doc.Info.Summary, doc.Info.Binary, doc.Info.Version)
	var global []spec.FlagItem
	if doc.Global != nil {
		global = doc.Global.Flags
	}
	out.WriteString("## Global flags\n\n")
	flagRows(&out, global)
	var commands []*spec.CommandItem
	var collect func(*spec.CommandItem)
	collect = func(item *spec.CommandItem) {
		for _, child := range item.Commands {
			if !child.Hidden {
				commands = append(commands, child)
			}
			collect(child)
		}
	}
	collect(doc.Commands)
	slices.SortFunc(commands, func(x, y *spec.CommandItem) int { return strings.Compare(x.CommandLine, y.CommandLine) })
	for _, command := range commands {
		fmt.Fprintf(&out, "\n## %s\n\n%s\n\n", command.CommandLine, command.Summary)
		if command.Kind == spec.CommandKindGroup {
			out.WriteString("Command group\n\n")
		}
		fmt.Fprintf(&out, "### Usage\n\n```sh\n%s\n```\n", usage(command, global))
		if len(command.Args) > 0 {
			out.WriteString("\n| Argument | Type | Required | Description |\n| --- | --- | --- | --- |\n")
			for _, arg := range command.Args {
				kind := arg.Type
				if kind == "" {
					kind = "string"
				}
				fmt.Fprintf(&out, "| `%s` | %s | %s | %s |\n", arg.Name, kind, yesNo(arg.Required), arg.Summary)
			}
		}
		if len(command.Flags) > 0 {
			out.WriteString("\n")
			flagRows(&out, command.Flags)
		}
	}
	return out.String()
}
