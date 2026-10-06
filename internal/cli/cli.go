// Package cli is the git-dedup command line: Git commands pass through to Git, and clone, submodule, and
// worktree can use the shared store.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/bhouston/git-dedup/internal/core"
	"github.com/bhouston/git-dedup/internal/discover"
	"github.com/urfave/cli/v3"
)

type app struct {
	version string
	stdout  io.Writer
	stderr  io.Writer
	// bare is set when git-dedup runs without arguments.
	bare bool
	// code and err are the result of the command handler that ran.
	code int
	err  error
}

// Main runs the CLI and returns the process exit code. Git commands keep their original argument array.
func Main(args []string, version string) int {
	if code, handled := testAPI(args); handled {
		return code
	}
	a := &app{version: version, stdout: os.Stdout, stderr: os.Stderr}
	code, err := a.main(args)
	if err != nil {
		fmt.Fprintln(a.stderr, "Error: "+err.Error())
		return 1
	}
	return code
}

func (a *app) main(args []string) (int, error) {
	stats := len(args) > 0 && args[0] == "--stats"
	forwarded := args
	if stats {
		forwarded = args[1:]
	}
	first := ""
	if len(forwarded) > 0 {
		first = forwarded[0]
	}
	switch first {
	case "", "store", "docgen", "--help", "-h", "--version", "-v":
	default:
		return a.runGit(forwarded, stats)
	}
	// Editors such as VS Code parse this as Git's version, so lead with Git's line.
	if len(args) == 1 && (first == "--version" || first == "-v") {
		version, err := core.New(core.Options{}).GitVersion()
		if err != nil {
			return 0, err
		}
		fmt.Fprintf(a.stdout, "%s (git-dedup %s)\n", version, a.version)
		return 0, nil
	}
	a.bare = len(args) == 0
	if err := a.command().Run(context.Background(), append([]string{"git-dedup"}, args...)); err != nil {
		if errors.As(err, new(usageError)) {
			return 1, nil
		}
		return 1, err
	}
	return a.code, a.err
}

func (a *app) runGit(args []string, stats bool) (int, error) {
	if !stats {
		return core.New(core.Options{}).Run(args)
	}
	var reports []core.StorageReport
	client := core.New(core.Options{OnStorageReport: func(report core.StorageReport) { reports = append(reports, report) }})
	code, err := client.Run(args)
	a.printStorageReports(reports)
	return code, err
}

// printStorageReports reports logical pack bytes; no filesystem allocation estimate is available.
func (a *app) printStorageReports(reports []core.StorageReport) {
	for _, report := range reports {
		pool := "created"
		if report.PoolReused {
			pool = "reused"
		}
		prefix := fmt.Sprintf("git-dedup: %s %s: %s object pool; ", report.Operation, report.Repository, pool)
		if report.Operation == "add" {
			fmt.Fprintf(a.stderr, "%sprivate packs %s -> %s; estimated private pack reduction %s\n", prefix,
				humanizeBytes(value(report.BeforeUniqueBytes)), humanizeBytes(value(report.AfterUniqueBytes)), humanizeBytes(report.EstimatedSavedBytes))
		} else {
			fmt.Fprint(a.stderr, prefix+"objects borrowed through Git alternates\n")
		}
	}
	if len(reports) == 0 {
		return
	}
	if reports[0].Operation == "add" {
		var total int64
		for _, report := range reports {
			total += report.EstimatedSavedBytes
		}
		fmt.Fprintf(a.stderr, "git-dedup: estimated private pack reduction %s; logical pack bytes only; actual disk reclaimed may differ.\n", humanizeBytes(total))
	} else {
		fmt.Fprintf(a.stderr, "git-dedup: %s storage depends on objects already present in the shared pool.\n", reports[0].Operation)
	}
}

func value(pointer *int64) int64 {
	if pointer == nil {
		return 0
	}
	return *pointer
}

func (a *app) storeInfo(*cli.Command) (int, error) {
	client := core.New(core.Options{})
	info := client.StoreInfo()
	fmt.Fprintf(a.stdout, "%s\nRemotes: %d\nSize: %s\n", info.Path, info.RemoteCount, humanizeBytes(info.SizeBytes))
	health := client.Doctor()
	if health.Empty {
		fmt.Fprintln(a.stdout, "The store is empty. Start with `git-dedup clone <url>` or `git-dedup store add [path]`.")
	}
	code := 0
	for _, check := range health.Checks {
		status := "OK"
		if !check.OK {
			status, code = "WARN", 1
		}
		fmt.Fprintf(a.stdout, "%s %s: %s\n", status, check.Name, check.Detail)
	}
	return code, nil
}

func (a *app) reportRepositories(result *core.StoreAddResult, verbose bool) {
	for _, repository := range result.Repositories {
		if repository.Reason == "" {
			continue
		}
		label := map[string]string{"added": "Warning", "failed": "Failed"}[repository.Status]
		if label == "" {
			label = "Skipped"
		}
		fmt.Fprintf(a.stderr, "%s %s: %s\n", label, repository.Path, repository.Reason)
		if verbose && repository.Detail != "" {
			fmt.Fprintln(a.stderr, repository.Detail)
		}
	}
}

func (a *app) storeAdd(command *cli.Command) (int, error) {
	all, dryRun, verbose := command.Bool("all"), command.Bool("dry-run"), command.Bool("verbose")
	// The global --stats and store add's own --stats mean the same thing, as in yargs.
	stats := command.Bool("stats") || command.Root().Bool("stats")
	if dryRun && !all {
		return 1, fmt.Errorf("--dry-run requires --all")
	}
	path := command.StringArg("path")
	var reports []core.StorageReport
	options := core.Options{}
	if stats {
		options.OnStorageReport = func(report core.StorageReport) { reports = append(reports, report) }
	}
	client := core.New(options)
	if !all {
		result, err := client.Add(path, false)
		if err != nil {
			return 1, err
		}
		a.reportRepositories(result, verbose)
		fmt.Fprintf(a.stdout, "Added %d repository(s); skipped %d; failed %d.\n", result.Added, result.Skipped, result.Failed)
		if stats {
			a.printStorageReports(reports)
		}
		return boolCode(result.Failed > 0), nil
	}
	git, err := client.GitPath()
	if err != nil {
		return 1, err
	}
	if path == "" {
		path, _ = os.Getwd()
	}
	targets, err := discover.Checkouts(path, git)
	if err != nil {
		return 1, err
	}
	fmt.Fprintf(a.stdout, "Discovered %d checkout(s):\n", len(targets))
	for _, target := range targets {
		suffix := ""
		if target.CoveredBy != "" {
			suffix = " (submodule of " + target.CoveredBy + ")"
		}
		fmt.Fprintf(a.stdout, "  %s%s\n", target.Path, suffix)
	}
	if dryRun {
		return 0, nil
	}
	completed := map[string]bool{}
	added, skipped, failed := 0, 0, 0
	for _, target := range targets {
		if target.CoveredBy != "" && completed[target.CoveredBy] {
			fmt.Fprintf(a.stdout, "Skipped %s: handled with %s\n", target.Path, target.CoveredBy)
			continue
		}
		result, err := client.Add(target.Path, false)
		if err != nil {
			failed++
			fmt.Fprintf(a.stderr, "Failed %s: store add operation failed\n", target.Path)
			if verbose {
				fmt.Fprintln(a.stderr, err.Error())
			}
			continue
		}
		added += result.Added
		skipped += result.Skipped
		failed += result.Failed
		a.reportRepositories(result, verbose)
		completed[target.Path] = true
		fmt.Fprintf(a.stdout, "Finished %s: added %d, skipped %d, failed %d\n", target.Path, result.Added, result.Skipped, result.Failed)
	}
	fmt.Fprintf(a.stdout, "Added %d repository(s); skipped %d; failed %d.\n", added, skipped, failed)
	if stats {
		a.printStorageReports(reports)
	}
	return boolCode(failed > 0), nil
}

func boolCode(failed bool) int {
	if failed {
		return 1
	}
	return 0
}

func (a *app) storeFetch(*cli.Command) (int, error) {
	result, err := core.New(core.Options{}).Fetch()
	if err != nil {
		return 1, err
	}
	for _, remote := range result.Remotes {
		if remote.Status == "failed" {
			fmt.Fprintf(a.stderr, "Failed %s: %s\n", remote.Key, remote.Reason)
		}
	}
	fmt.Fprintf(a.stdout, "Fetched %d remote(s); %d failed.\n", result.Fetched, result.Failed)
	return boolCode(result.Failed > 0), nil
}

func (a *app) storeGC(*cli.Command) (int, error) {
	result, err := core.New(core.Options{}).GC()
	if err != nil {
		return 1, err
	}
	if result.Compacted {
		fmt.Fprintln(a.stdout, "Compacted the shared object pool.")
	} else {
		fmt.Fprintln(a.stdout, "The shared object pool is empty.")
	}
	return 0, nil
}

func (a *app) storeList(*cli.Command) (int, error) {
	remotes, err := core.New(core.Options{}).ListRemotes()
	if err != nil {
		return 1, err
	}
	if len(remotes) == 0 {
		fmt.Fprintln(a.stdout, "No remotes registered.")
		return 0, nil
	}
	fmt.Fprintln(a.stdout, "KEY\tFETCH URL")
	for _, remote := range remotes {
		fmt.Fprintf(a.stdout, "%s\t%s\n", remote.Key, remote.Remote)
	}
	return 0, nil
}

func (a *app) storePrune(*cli.Command) (int, error) {
	result, err := core.New(core.Options{}).Prune()
	if err != nil {
		return 1, err
	}
	fmt.Fprintf(a.stdout, "Reclaimed %s.\n", humanizeBytes(result.ReclaimedBytes))
	return 0, nil
}

func (a *app) storeRemove(command *cli.Command) (int, error) {
	path, verbose := command.StringArg("path"), command.Bool("verbose")
	client := core.New(core.Options{})
	if command.Bool("forget") {
		forgotten, err := client.Forget(path)
		if err != nil {
			return 1, err
		}
		for _, gitdir := range forgotten {
			fmt.Fprintf(a.stdout, "Forgot %s\n", gitdir)
		}
		if len(forgotten) == 0 {
			fmt.Fprintf(a.stderr, "No registered checkout matches %s.\n", path)
			return 1, nil
		}
		return 0, nil
	}
	result, err := client.Remove(path)
	if err != nil {
		return 1, err
	}
	for _, repository := range result.Repositories {
		if repository.Status == "removed" {
			fmt.Fprintf(a.stdout, "Removed %s: objects now use %s\n", repository.Path, humanizeBytes(value(repository.ObjectBytes)))
		} else {
			label := "Skipped"
			if repository.Status == "failed" {
				label = "Failed"
			}
			fmt.Fprintf(a.stderr, "%s %s: %s\n", label, repository.Path, repository.Reason)
		}
		if verbose && repository.Detail != "" {
			fmt.Fprintln(a.stderr, repository.Detail)
		}
	}
	if result.Removed == 0 && result.Failed == 0 {
		fmt.Fprintf(a.stdout, "Nothing to remove: %s is not linked to the store.\n", path)
	} else {
		fmt.Fprintf(a.stdout, "Removed %d repository(s); skipped %d; failed %d.\n", result.Removed, result.Skipped, result.Failed)
	}
	return boolCode(result.Failed > 0), nil
}
