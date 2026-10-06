package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/urfave/cli/v3"
)

const (
	description    = "Faster checkouts, a fraction of the disk space: share one copy of Git history across clones, worktrees, and submodules"
	statsSummary   = "Show object pool use and checkout adoption measurements"
	verboseSummary = "Show full Git errors for skipped and failed repositories"
)

// docgenFormats are the values docgen --format accepts; the first is the default.
var docgenFormats = []string{"json", "yaml", "markdown"}

// usageError is a command line mistake that has already been reported with the command's help.
type usageError struct{ err error }

func (e usageError) Error() string { return e.err.Error() }

// command builds git-dedup's own command tree. Git commands never reach it; see app.main.
func (a *app) command() *cli.Command {
	pathArg := func(required bool, summary string) []cli.Argument {
		return []cli.Argument{&cli.StringArg{Name: "path", UsageText: summary, Required: required}}
	}
	verbose := func() cli.Flag { return &cli.BoolFlag{Name: "verbose", Usage: verboseSummary} }
	root := &cli.Command{
		Name:  "git-dedup",
		Usage: description,
		Description: "Git commands pass through to Git; clone, fetch, submodule, and worktree can use\n" +
			"the shared store.",
		HideVersion: true,
		Flags: []cli.Flag{
			// Persistent, so --version and --stats also work after a command name.
			&cli.BoolFlag{Name: "version", Aliases: []string{"v"}, Usage: "Show version number"},
			&cli.BoolFlag{Name: "stats", Usage: statsSummary},
		},
		Action: a.rootAction,
		Commands: []*cli.Command{
			{
				Name:  "docgen",
				Usage: "Write the OpenCLI document to a file, or stdout if --output is omitted",
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "output", Aliases: []string{"o"}, Usage: "Output file; defaults to stdout"},
					&cli.StringFlag{
						Name:        "format",
						Usage:       "Output format (" + strings.Join(docgenFormats, ", ") + ")",
						Value:       docgenFormats[0],
						DefaultText: docgenFormats[0],
					},
				},
				Action: a.action(a.docgen),
			},
			{
				Name:   "store",
				Usage:  "Show the shared store and its health",
				Action: a.action(a.storeInfo),
				Commands: []*cli.Command{
					{
						Name:      "add",
						Usage:     "Add a local checkout to the shared store; linked checkouts depend on it",
						ArgsUsage: "[path]",
						Arguments: pathArg(false, "Local checkout path (defaults to the current directory)"),
						Flags: []cli.Flag{
							&cli.BoolFlag{Name: "stats", Usage: "Show the change in private pack storage"},
							&cli.BoolFlag{Name: "all", Usage: "Discover and add all checkouts under the directory"},
							&cli.BoolFlag{Name: "dry-run", Usage: "Preview checkouts discovered by --all without adding them"},
							verbose(),
						},
						Action: a.action(a.storeAdd),
					},
					{Name: "fetch", Usage: "Fetch registered remotes into the shared object pool", Action: a.action(a.storeFetch)},
					{Name: "gc", Usage: "Compact the shared object pool without pruning consumer objects", Action: a.action(a.storeGC)},
					{Name: "list", Usage: "List remotes registered in the shared store", Action: a.action(a.storeList)},
					{Name: "prune", Usage: "Reclaim pool objects that no registered checkout uses", Action: a.action(a.storePrune)},
					{
						Name:      "remove",
						Usage:     "Detach a checkout and its submodules from the shared store",
						ArgsUsage: "<path>",
						Arguments: pathArg(true, "Local checkout path"),
						Flags: []cli.Flag{
							verbose(),
							&cli.BoolFlag{Name: "forget", Usage: "Release a deleted checkout so store prune can reclaim its objects"},
						},
						Action: a.action(a.storeRemove),
					},
				},
			},
		},
		Writer:    a.stdout,
		ErrWriter: a.stderr,
		// Errors are returned to Main; urfave/cli must not call os.Exit.
		ExitErrHandler: func(context.Context, *cli.Command, error) {},
	}
	walk(root, func(command *cli.Command) {
		command.HideHelpCommand = true
		command.OnUsageError = a.onUsageError
	})
	return root
}

func walk(command *cli.Command, visit func(*cli.Command)) {
	visit(command)
	for _, child := range command.Commands {
		walk(child, visit)
	}
}

// action adapts a handler to urfave/cli. The handler's exit code and error are kept on the app, so urfave/cli
// only sees usage errors, which it must not treat as exit codes.
func (a *app) action(handler func(*cli.Command) (int, error)) cli.ActionFunc {
	return func(ctx context.Context, command *cli.Command) error {
		if command.Args().Present() {
			problem := fmt.Errorf("unexpected argument %q", command.Args().First())
			if len(command.Commands) > 0 {
				problem = fmt.Errorf("unknown command %q", command.Args().First())
			}
			return a.onUsageError(ctx, command, problem, false)
		}
		if command.Bool("version") {
			fmt.Fprintln(a.stdout, a.version)
			return nil
		}
		a.code, a.err = handler(command)
		if errors.As(a.err, new(usageError)) {
			return a.err
		}
		return nil
	}
}

func (a *app) rootAction(ctx context.Context, command *cli.Command) error {
	if command.Args().Present() {
		return a.onUsageError(ctx, command, fmt.Errorf("unknown command %q", command.Args().First()), false)
	}
	if command.Bool("version") {
		fmt.Fprintln(a.stdout, a.version)
		return nil
	}
	// Like yargs' showHelp, a bare invocation writes help to stderr; --help writes it to stdout.
	out := a.stdout
	if a.bare {
		out = a.stderr
	}
	showHelp(out, command)
	return nil
}

func (a *app) onUsageError(_ context.Context, command *cli.Command, err error, _ bool) error {
	if errors.As(err, new(usageError)) {
		return err
	}
	fmt.Fprintf(a.stderr, "Incorrect Usage: %s\n\n", err)
	showHelp(a.stderr, command)
	return usageError{err}
}

// showHelp writes a command's urfave/cli help to w.
func showHelp(w io.Writer, command *cli.Command) {
	template := cli.CommandHelpTemplate
	switch {
	case command.Root() == command:
		template = cli.RootCommandHelpTemplate
	case len(command.VisibleCommands()) > 0:
		template = cli.SubcommandHelpTemplate
	}
	cli.HelpPrinter(w, template, command)
}

func validFormat(format string) bool {
	return slices.Contains(docgenFormats, format)
}
