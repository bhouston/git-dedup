# Native implementation

git-dedup is a Go program. Through version 2, it was written in TypeScript (`git-dedup-core` and the `git-dedup` npm CLI); the Go port replaced it so it can ship as a native binary through npm, GitHub Releases, Linux packages, Homebrew, Scoop, and winget without a runtime.

## Layout

| Path                | Contents                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| `cmd/git-dedup`     | Entry point; `main.version` is set at build time                                 |
| `internal/core`     | Store, lock, pool, clone, fetch, submodule, worktree, add, remove, prune         |
| `internal/discover` | Checkout discovery for `store add --all`                                         |
| `internal/cli`      | Command tree (urfave/cli v3), `docgen` (OpenCLI from that tree), stats, test API |
| `packages/cli`      | The npm package: `bin/git-dedup.js` runs `native/<platform>-<arch>/git-dedup`    |
| `test`              | Behavior suites that drive the binary                                            |

## Store compatibility contract

Stores and checkouts created by any git-dedup version, including the TypeScript 2.x releases, must keep working, and different versions may share one store. Everything below is a compatibility contract; changing it needs a migration.

**Store location.** `$GIT_DEDUP_STORE`, else `$GITX_STORE` (relative to the working directory, `~` expanded), else a legacy `~/.cache/gitx` or `~/.gitx` that holds a valid marker, else `~/.git-dedup`. The path is canonicalized (symlinks and Windows 8.3 names resolved).

**Store contents.**

| Path                           | Format                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.gitx-store`                  | Exactly `gitx-store-v2\n`. A store is only created in a missing or empty directory.                                                                                                         |
| `pool.git/`                    | Bare SHA-1 repository. Config: `gc.writeCommitGraph=false`, `maintenance.commit-graph.enabled=false`, `gc.auto=0`, `maintenance.auto=false`, `gc.pruneExpire=never`, `core.longpaths=true`. |
| `pool.git` refs                | `refs/gitx/remotes/<sha256(key)>/{heads,tags}/*` mirror each remote; `refs/gitx/consumers/<consumer-id>/<oid>` pin each checkout's tips.                                                    |
| `remotes/<sha256(key)>.json`   | `{"key":"…","remote":"…"}\n`, HTTP(S) credentials removed.                                                                                                                                  |
| `consumers/<consumer-id>.json` | `{"gitdir":"<common gitdir>"}\n`                                                                                                                                                            |
| `clones/<uuid>.json`           | `{"pid":…,"destination":"…"}\n` while a clone has fetched but not yet pinned.                                                                                                               |

JSON files are written like `JSON.stringify(value) + "\n"`, without HTML escaping, so both implementations produce identical bytes.

**Store keys.** `host[:port]/path` from the remote URL, with `.git` removed, the host lowercased, and default HTTP(S) ports dropped. SSH home-relative paths become `~user/` unless the user is `git`. Only `http`, `https`, `ssh`, `git`, and scp-style remotes are keyed; anything else falls back to plain Git.

**Lock.** A sibling directory `.<store-name>.gitx-lock` created with `mkdir`, holding `owner` (`<pid>\n`) and `heartbeat`, which the holder touches every 10 seconds. A waiter reaps the lock when its owner process is dead and the lock is older than 5 seconds, or when it has seen no change for 60 seconds of monotonic time. Reapers serialize on `<lock>.reap`.

**Checkout side.** `<common gitdir>/gitx-consumer-id` (a UUID), a `<store>/pool.git/objects` line in `objects/info/alternates`, and `<gitdir>/gitx-cache.json` (`{"version":1,"pool","remote","key","tips"}`) after `store add`.

**Environment.** Child Git processes get `GIT_DEDUP_ACTIVE=1` and `GITX_ACTIVE=1`; when they are already set, git-dedup passes everything to Git unchanged. The Git executable can be overridden with `git config git-dedup.gitPath` (or the older `gitx.gitPath`).

**Command line.** Output text, exit codes, and the `git-dedup: <reason>; using plain Git` fallback notices match the Node CLI.

## CLI layer

`internal/cli/cli.go` sends every first argument other than `store`, `docgen`, `--help`/`-h`, and `--version`/`-v` (after an optional `--stats`) straight to `core.Client.Run`, without parsing it. `git-dedup --version` alone prints Git's version line followed by git-dedup's.

Only git-dedup's own commands go through [urfave/cli v3](https://github.com/urfave/cli). Each handler stores its exit code and error on the app, so an error returned by urfave/cli is always a usage mistake. `--stats` and `--version` are persistent root flags, so they also work after a command name.

`docgen` builds the OpenCLI document from the command tree with the `ourfave` adapter from [opencli](https://github.com/bcdxn/opencli), then adds what the adapter does not read: required arguments, the `--format` choices, and the `git-dedup clone` passthrough. It writes JSON and YAML with its own serializer, because the opencli codec always writes an empty `global.config`, which the OpenCLI schema rejects. Markdown keeps a `## git-dedup <command>` section per command.

## Testing

- `pnpm test` builds the binary for this machine and runs the Vitest suites in `test/` against it.
- `test/cli.test.ts` runs the CLI through the npm launcher, as users do.
- The other suites call storage operations directly through `test/native.ts`, which drives the binary's test-only `__api` command. That command only exists when `GIT_DEDUP_TEST_API` names a result file; without it, `__api` is an ordinary unknown Git command.
- `pnpm test:coverage` uses a coverage-instrumented binary and writes `coverage/native.out`.
- `go test ./...` covers the command line, URL keys, formatting, and docgen (checked with opencli's validator) without Node.

## npm launcher

`packages/cli/bin/git-dedup.js` starts the binary for `process.platform` and `process.arch` with inherited stdio, and exits with its status. It sets `GIT_DEDUP_LAUNCHER` to its own path, so a `git` shim that points at the launcher is recognized as git-dedup rather than run as Git. The package ships all six binaries (about 10 MB packed); per-platform optional dependencies would make installs smaller if that becomes a concern.

## Differences from the TypeScript CLI (2.x)

- An error from a store command prints `Error: <message>` and exits 1. The Node CLI printed the command's help followed by a stack trace.
- Help text comes from urfave/cli instead of matching yargs. A usage mistake (unknown command or flag, missing argument, or invalid `--format`) prints `Incorrect Usage: <problem>` and the command's help to stderr and exits 1, with urfave/cli's wording.
- Flags only take their exact names. yargs also accepted camelCase (`--dryRun`) and negated (`--no-stats`) forms.
- A bare `git-dedup --stats` shows help. The Node CLI printed nothing.
- The OpenCLI document also lists `--help` and `--version` as global flags, gives every argument a `type`, and does not mark `git-dedup store` as a group, because it runs the store health check itself. `docgen --format yaml` quotes some strings differently. The YAML parses to the same document.
- `store add --all` sorts discovered paths case-insensitively, which is close to, but not identical to, JavaScript's `localeCompare`.
- Errors from the operating system read differently (for example, Go reports `is a directory` where Node reports `EISDIR`).
- The `git-dedup-core` library API is gone; scripts run the `git-dedup` command.
- The npm package needs Node.js 18 or later rather than 22, only to start the launcher.
