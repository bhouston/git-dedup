# Native port

git-dedup is being ported from Node.js to a native Go binary, so it can ship through Homebrew, apt/dnf/apk, winget, and Scoop without a runtime. The Go code lives at the repository root (`go.mod`, `cmd/git-dedup`, `internal/`). Once it reaches parity on every OS, the npm package will ship the Go binaries and the TypeScript implementation will be retired.

## Layout

| Path                | Contents                                                                           | TypeScript origin              |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| `cmd/git-dedup`     | Entry point; `main.version` is set at build time                                   | `packages/cli/src/bin.ts`      |
| `internal/core`     | Store, lock, pool, clone, submodule, worktree, add, remove, prune                  | `packages/core/src/index.ts`   |
| `internal/discover` | Checkout discovery for `store add --all`                                           | `packages/cli/src/discover.ts` |
| `internal/cli`      | Argument parsing, help (embedded from the yargs output), `docgen`, stats, test API | `packages/cli/src/`            |

## The contract: what both implementations must agree on

The Node and Go versions must be able to share one store, and a user may run either against the same checkouts. Everything below is a compatibility contract; changing it needs a migration.

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

## Testing

The TypeScript suites are the parity gate. `pnpm test:native` builds the Go binary into `build/native/` and runs `packages/core/test/*` plus the CLI and discovery tests against it:

- `packages/cli/src/cli.test.ts` runs the binary directly when `GIT_DEDUP_BIN` is set.
- The core and discovery suites call the library API. `packages/core/test/native.ts` maps that API onto the binary's test-only `__api` command, which only exists when `GIT_DEDUP_TEST_API` names a result file; without it, `__api` is an ordinary unknown Git command.
- `pnpm test:native --coverage` builds with Go coverage instrumentation and writes `coverage/native.out`.
- `go test ./...` covers parsing, URL keys, formatting, and docgen without Node.

Two lock tests mock Node's timers and clock and are skipped for the native binary. `handlers.test.ts` and `inprocess.test.ts` test the Node CLI's internals and stay with the Node suite.

## Intentional differences

- An error from a store command prints `Error: <message>` and exits 1. The Node CLI printed the command's help followed by a stack trace.
- A bare `git-dedup --stats` shows help. The Node CLI printed nothing.
- `docgen --format yaml` quotes some strings differently. The YAML parses to the same document.
- `store add --all` sorts discovered paths case-insensitively, which is close to, but not identical to, JavaScript's `localeCompare`.
- Errors from the operating system read differently (for example, Go reports `is a directory` where Node reports `EISDIR`).

## Status

- [x] Port of every command, including `fetch` from #144, with byte-compatible store files.
- [x] Shared suites run against the binary on Windows.
- [x] GoReleaser config: 6 targets, archives, deb/rpm/apk/Arch packages, Homebrew cask, Scoop, winget, SBOMs, macOS notarization, Windows signing hook.
- [x] CI: native suites on Linux x64/arm64, macOS, and Windows (informational), plus package install checks in Debian, Ubuntu, Fedora, and Alpine.
- [ ] Green on Linux and macOS, then make the `native` CI job required.
- [ ] Publishing: create the tap, Scoop bucket, winget-pkgs fork, apt/rpm repository, and signing credentials (see [RELEASING.md](../RELEASING.md)), then run GoReleaser from the release workflow.
- [ ] npm: ship the Go binaries through per-platform optional dependencies and retire `packages/core`.
