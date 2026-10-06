package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const opencliVersion = "1.0.0-alpha.14"

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

func marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), err
}

func flagObject(flag flagDef) object {
	o := object{{"name", flag.name}, {"type", flag.kind}}
	if flag.alias != "" {
		o = append(o, field{"aliases", []string{flag.alias}})
	}
	if flag.summary != "" {
		o = append(o, field{"summary", flag.summary})
	}
	if len(flag.choices) > 0 {
		var choices []object
		for _, choice := range flag.choices {
			choices = append(choices, object{{"value", choice}})
		}
		o = append(o, field{"choices", choices})
	}
	if flag.def != nil {
		o = append(o, field{"default", flag.def})
	}
	return o
}

// document builds the OpenCLI description of git-dedup in the Node CLI's key order.
func document(version string) object {
	var commandFields object
	for _, command := range commands {
		o := object{{"summary", command.summary}}
		if command.group {
			o = append(o, field{"kind", "group"})
		}
		if len(command.args) > 0 {
			var args []object
			for _, arg := range command.args {
				a := object{{"name", arg.name}, {"required", arg.required}}
				if arg.kind != "" {
					a = append(a, field{"type", arg.kind})
				}
				if arg.summary != "" {
					a = append(a, field{"summary", arg.summary})
				}
				args = append(args, a)
			}
			o = append(o, field{"args", args})
		}
		if len(command.flags) > 0 {
			var flags []object
			for _, flag := range command.flags {
				flags = append(flags, flagObject(flag))
			}
			o = append(o, field{"flags", flags})
		}
		commandFields = append(commandFields, field{command.name, o})
	}
	return object{
		{"opencliVersion", opencliVersion},
		{"info", object{{"title", "git-dedup"}, {"binary", "git-dedup"}, {"version", version}, {"summary", description}}},
		{"commands", commandFields},
		{"global", object{{"flags", []object{{{"name", "stats"}, {"type", "boolean"}, {"summary", statsSummary}}}}}},
	}
}

func (a app) docgen(inv invocation) (int, error) {
	format := inv.flags["format"]
	var text string
	switch format {
	case "yaml":
		text = toYAML(document(a.version), 0)
	case "markdown":
		text = a.markdown()
	default:
		data, err := json.MarshalIndent(document(a.version), "", "  ")
		if err != nil {
			return 1, err
		}
		text = string(data) + "\n"
	}
	if output := inv.flags["output"]; output != "" {
		return 0, os.WriteFile(output, []byte(text), 0o666)
	}
	fmt.Fprint(a.stdout, text)
	return 0, nil
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

func usage(command commandDef) string {
	parts := []string{command.name}
	for _, arg := range command.args {
		if arg.required {
			parts = append(parts, "<"+arg.name+">")
		} else {
			parts = append(parts, "[<"+arg.name+">]")
		}
	}
	parts = append(parts, "[--stats]")
	for _, flag := range command.flags {
		if flag.name == "stats" {
			continue
		}
		if flag.kind == "boolean" {
			parts = append(parts, "[--"+flag.name+"]")
		} else {
			parts = append(parts, "[--"+flag.name+" <"+flag.name+">]")
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

func (a app) markdown() string {
	var out strings.Builder
	fmt.Fprintf(&out, "# git-dedup\n\n%s\n\nBinary: `git-dedup` · Version: `%s`\n\n", description, a.version)
	out.WriteString("## Global flags\n\n| Flag | Type | Required | Description |\n| --- | --- | --- | --- |\n")
	fmt.Fprintf(&out, "| `--stats` | boolean | No | %s |\n", statsSummary)
	sorted := slices.Clone(commands)
	slices.SortFunc(sorted, func(x, y commandDef) int { return strings.Compare(x.name, y.name) })
	for _, command := range sorted {
		fmt.Fprintf(&out, "\n## %s\n\n%s\n\n", command.name, command.summary)
		if command.group {
			out.WriteString("Command group\n\n")
		}
		fmt.Fprintf(&out, "### Usage\n\n```sh\n%s\n```\n", usage(command))
		if len(command.args) > 0 {
			out.WriteString("\n| Argument | Type | Required | Description |\n| --- | --- | --- | --- |\n")
			for _, arg := range command.args {
				kind := arg.kind
				if kind == "" {
					kind = "string"
				}
				fmt.Fprintf(&out, "| `%s` | %s | %s | %s |\n", arg.name, kind, yesNo(arg.required), arg.summary)
			}
		}
		if len(command.flags) > 0 {
			out.WriteString("\n| Flag | Type | Required | Description |\n| --- | --- | --- | --- |\n")
			for _, flag := range command.flags {
				text := flag.summary
				if flag.alias != "" {
					text += "; Aliases: `" + flag.alias + "`"
				}
				if len(flag.choices) > 0 {
					text += "; Choices: " + strings.Join(flag.choices, ", ")
				}
				if flag.def != nil {
					text += fmt.Sprintf("; Default: `%v`", flag.def)
				}
				fmt.Fprintf(&out, "| `--%s` | %s | No | %s |\n", flag.name, flag.kind, text)
			}
		}
	}
	return out.String()
}
