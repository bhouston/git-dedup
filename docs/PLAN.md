# gitx implementation plan

This plan translates the [original overlay design](DESIGN.md) into milestones that can be proved with disposable local repositories. It tracks both completed scope and future work; a design target should not be read as implemented behavior.

## Architecture

- `@bhouston/gitx-core` owns store selection, remote key normalization, mirror locking, clone operations, and testable Git process helpers. It may use `simple-git` where the library gives reliable behavior, with direct Git invocation where exact passthrough or process semantics matter.
- `gitx` is a thin Node.js CLI built with `yargs-file-commands`. It dispatches supported actions to core and forwards everything else to the real Git executable. It exposes command metadata for clidoc and uses `vitest-command-line` for process-level tests.
- `@bhouston/gitx-website` is a Docusaurus site with a getting started guide, architecture, safety notes, development guidance, and this roadmap.
- pnpm manages the workspace; TypeScript, Vitest, Oxlint, and Oxformat provide build and checks.

## Milestone 1: foundation and clone — implemented

1. Resolve the real Git executable for explicit `gitx` invocations; keep exit codes and streams useful for ordinary Git commands.
2. Resolve the store from `GITX_STORE`, then `gitx.store`, then a documented default. Only explicit configuration commands may edit global Git settings.
3. Normalize supported remote URLs to a bounded store key. Do not merge identities that may be different, such as arbitrary SSH host aliases.
4. Serialize store mutations with a store lock alongside the store and a lock per mirror key. This prevents `store clear` from racing mirror work, while limiting concurrent mirror updates across keys. Build missing mirrors in a temporary location and publish atomically.
5. Clone from the mirror, set `origin` to the requested remote, and retain a normal object directory with no alternates. Preserve the requested destination and applicable supported options.
6. Forward unsupported clone modes and local path sources to Git. Do not optimize shallow, partial, bare, mirror, reference, or SHA-256 clone modes.

**Proof:** `pnpm test:proof` creates two temporary repositories served through a loopback Git daemon, makes three concurrent clones into a temporary store, checks that two clones share a pack inode, clears the store, verifies each clone with `git fsck`, full history, and clean status, then rebuilds the mirror. Unit and command-line tests cover fallback and passthrough.

## Milestone 2: submodules and worktrees — implemented for supported updates

The core prepares missing submodule Git directories from mirrors before supported `submodule update` commands, then invokes real Git. With `--recursive`, it does the same in nested modules. This includes updates inside linked worktrees and `clone --recurse-submodules`. `submodule add` runs Git and then caches the added module. Relative submodule URLs resolve against the superproject remote. Unsupported submodule forms continue through Git. `worktree add` uses Git's shared common object database and initializes supported submodules through mirrors after creation; `--no-checkout` skips initialization. Broader option and Git-version coverage remains future work.

**Proof:** integration tests use local fixtures to check that submodule updates in a clone and linked worktree reuse mirror pack inodes. Continue validating different Git versions and option combinations.

## Milestone 3: existing repository adoption — implemented, continuing validation

`gitx cache [path]` seeds or refreshes a mirror, links eligible packs (copying when needed), and repacks local objects with kept packs excluded. It copies existing local Git LFS objects into the store while retaining their original files. Continue validating kept-pack behavior on different Git versions and filesystem combinations.

## Milestone 4: maintenance and diagnostics — implemented, continuing validation

Store inspection, refresh, garbage collection, clear, and doctor commands are available. Doctor reports filesystem relationship, reflink support, Git version, and LFS configuration. `gitx store set` explicitly writes global `gitx.store` and `lfs.storage`. `gitx store clear` removes mirrors and the store's LFS directory, so the LFS implications need clear documentation and targeted tests.

The store has a `.gitx-store` marker. `store clear` refuses an unmarked directory or one with unrelated files. `doctor` can initialize an empty store and marker without editing global configuration.

## Later exploration

Fetch and pull acceleration, shallow and partial clone handling, Windows, and reflinked LFS working files are outside the initial scope.

## Validation gates

- `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`, and `pnpm docs:build` pass.
- `pnpm test:proof` exercises concurrent clones, object sharing, store deletion, and mirror rebuild against disposable loopback remotes.
- Core tests cover mirror key normalization, concurrent mirror access, clone behavior, and store deletion. CLI tests cover actual process behavior and fallback.
- A disposable end-to-end fixture demonstrates working clones and storage sharing with a local consolidated store. Its output and limits should be recorded in the repository or final implementation report.
