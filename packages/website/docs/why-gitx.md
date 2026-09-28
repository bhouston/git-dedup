---
title: Why gitx?
---

## Automatic sharing, independent checkouts

gitx is designed for people who keep several checkouts of the same repositories: parallel development branches, coding-agent workspaces, and projects with repeated submodule dependencies. We prefer its approach for these workflows because sharing is automatic and the resulting Git repositories can outlive the cache.

```sh
gitx clone https://github.com/you/project.git project-main
gitx --stats clone https://github.com/you/project.git project-review
gitx cache ./existing-project --stats
```

For supported operations, gitx chooses and refreshes a mirror, creates an independent consumer, and restores the original remote URL. There is no per-clone reference path to track or separate dissociation step to remember. The same storage logic prepares supported submodules, including nested modules and modules inside linked worktrees.

## Inspired by pnpm's shared-store simplicity

gitx was inspired by the simplicity of pnpm's shared package store: run a familiar command and let the tool reuse local data across projects. Sharing should be a routine part of the workflow, without manually wiring each new project to a cache.

pnpm's [documented node_modules layout](https://pnpm.io/symlinked-node-modules-structure) combines package files hard-linked from a content-addressable store with symbolic links that arrange dependencies. gitx applies the shared-store idea to Git: supported clones reuse a local mirror, while each consumer keeps its own object links or copies. The store handles reuse; the checkout remains usable with ordinary Git.

The inspiration is both ease of use and efficient storage. pnpm organizes package contents; gitx maintains a bare mirror per normalized remote and shares Git object files. gitx does not use pnpm's store or reproduce its dependency layout. Its cache-deletion guarantee follows from its own independent object directories, as explained below.

## Compared with Chromium's depot_tools

Chromium's Git caching tools are part of **depot_tools**, including `gclient` and `git cache`. They serve Chromium's development workflow. Chromium's [depot_tools guide](https://www.chromium.org/developers/how-tos/depottools/) describes that toolchain.

There are two relevant paths in the [current gclient implementation](https://chromium.googlesource.com/chromium/tools/depot_tools/+/refs/heads/main/gclient_scm.py):

- **Shared-cache mode** clones with `--shared` and uses Git alternates. A checkout can depend on objects in the cache, so deleting that cache can leave required objects missing.
- **Bootstrap mode** hard-links or copies objects instead. This also supports independent new checkouts. Selecting bootstrap mode does not automatically detach an existing checkout that already uses alternates.

The independence property is therefore not unique to gitx. Our preference for gitx is about making it the normal path for supported, everyday Git operations. Install one Node.js CLI, run `gitx clone`, and let it manage mirror selection, updates, locking, origin URLs, and submodule preparation. Existing repositories can be adopted with `gitx cache`; optional reports show how much packed data is shared.

Use depot_tools when working in a project that requires its workflow. gitx does not replace `gclient` dependency management or the rest of Chromium's tooling.

## Compared with manual mirrors and reference clones

Git already provides the building blocks. The important choice is whether the consumer owns links or copies of its objects, or continues borrowing them from another repository.

| Approach                                    | Sharing and cache-deletion behavior                                                          | What you manage                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `git clone --reference <mirror> <remote>`   | Borrows objects through alternates; deleting needed reference objects can break the consumer | Mirror lifecycle and reference dependencies              |
| Add `--dissociate` to a reference clone     | Copies the borrowed objects locally so the reference is no longer required                   | Mirror setup, updates, paths, and clone flags            |
| Local clone of a self-contained bare mirror | Can hard-link objects and remain valid after mirror deletion                                 | Mirror setup, freshness, origin URL, and coordination    |
| Supported gitx clone or cache adoption      | Keeps object links or copies in the consumer, without alternates                             | Choose a store if the default location does not suit you |

Git documents these mechanisms and the risks of borrowed objects in its [`git clone` reference](https://git-scm.com/docs/git-clone). `--reference-if-able` permits a missing reference at clone time; it does not make a successfully borrowed reference disposable afterward.

A carefully maintained manual local-mirror workflow can provide the same independence. `--reference --dissociate` is another sound option when independent copies are acceptable. gitx packages the mirror workflow into repeatable commands and extends it to existing repositories and supported submodules, reducing the manual steps needed to keep it reliable.

## Why deleting the store preserves Git objects

A hard link is another filename for the same file on disk. Neither filename is a pointer to the other filename:

```text
store/mirrors/project.git/objects/pack/pack-….pack ─┐
                                                  ├─ same file data
project/.git/objects/pack/pack-….pack ──────────────┘
```

Deleting the store removes the first name. The consumer's name still keeps the file data alive. Git can continue reading it without finding the mirror path. Where files are copied instead, the consumer already has a separate copy. Normal Git repacking writes replacement files rather than modifying shared pack contents in place.

Alternates behave differently: Git looks in another object directory for missing objects. If that directory disappears, those lookups fail. gitx's optimized consumers do not use alternates, so removing its store does not create that dependency failure.

This is covered by tests, not just a design intention. The repository's `pnpm test:proof` creates temporary remotes and concurrent consumers, verifies shared pack inodes, deletes the store, checks consumers with `git fsck --full` and history reads, and verifies that a later clone rebuilds the store.

Use `gitx store clear` for coordinated cleanup. It waits for active gitx store operations and checks the store marker and directory contents. Deleting files externally bypasses these locks; do not remove the store manually while gitx is using it.

## What this guarantee covers

- **Git objects in optimized consumers.** Unsupported invocations are forwarded to Git. Explicit `--reference` or `--shared` options retain Git's own semantics, including any dependencies they create.
- **The gitx store, not a worktree's parent repository.** Linked worktrees still depend on Git's common repository. Submodule preparation does not change that relationship.
- **Git LFS has separate storage.** `gitx store set` also sets global `lfs.storage`. LFS content stored only there may need downloading again after cleanup. See [safety and limitations](./safety.md).
- **Deletion, not arbitrary file damage.** Hard-linked files share contents; manually overwriting a shared object can damage every link to it. This is not a backup system.
- **Savings depend on the filesystem and workflow.** Hard links require the same filesystem. Copies, subsequent repacking, and the first mirror's storage cost affect savings. Normal fetches and pulls are not accelerated.

For repeated local checkouts, the benefit is practical: fewer setup steps, automatic reuse, and a store you can discard without breaking the Git objects already held by its consumers. See [how it works](./how-it-works.md) for implementation details and [the CLI reference](./cli.md) for commands.
