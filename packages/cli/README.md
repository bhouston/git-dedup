# git-dedup CLI

[![npm version](https://img.shields.io/npm/v/git-dedup.svg)](https://www.npmjs.com/package/git-dedup)
[![npm downloads](https://img.shields.io/npm/dm/git-dedup.svg)](https://www.npmjs.com/package/git-dedup)
[![CI](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/git-dedup/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-git--dedup-blue)](https://git-dedup.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

**Many coding agents, one copy of Git history.**

Coding agents and editors clone the same repositories again and again: one checkout per task, per agent, per review. Each clone normally carries its own full copy of the history. git-dedup is a Git wrapper whose clones, forks, and worktree submodules share one local object pool, so every new checkout reuses the history already on disk.

In one typical local setup spanning 117 checkouts (94 distinct Git object databases, with linked worktrees counted once), git-dedup uses 11.1 GB for Git objects versus an estimated 35.5 GB without sharing, saving about 24.4 GB (69%).

```sh
# Populate the shared object pool in ~/.git-dedup.
git-dedup clone https://github.com/you/project.git project

# Another checkout borrows objects from the same pool.
git-dedup clone https://github.com/you/project.git project-review
cd project-review

# All normal Git commands work in the checkout.
git status
git diff
git log --oneline
```

Repeated clones can borrow objects already in the pool, reducing download and storage work.

**[Documentation](https://git-dedup.ben3d.ca/) · [Source](https://github.com/bhouston/git-dedup) · [Agent setup](https://git-dedup.ben3d.ca/docs/agents)**

## Installation

Requires **Node.js 22+ and Git** on macOS or Linux.

```sh
npm install --global git-dedup
git-dedup --help
```

## Usage

```sh
# Repeated clones borrow from the shared pool.
git-dedup clone https://github.com/bhouston/git-dedup.git git-dedup-main
git-dedup --stats clone https://github.com/bhouston/git-dedup.git git-dedup-review

# Adopt an existing repository and its discoverable submodules.
git-dedup store add ./git-dedup-main --stats

# Preview, then adopt every checkout in a workspace directory.
git-dedup store add ~/Coding --all --dry-run
git-dedup store add ~/Coding --all

# Ordinary Git commands also work through git-dedup.
git-dedup -C git-dedup-main status
```

### Submodules and worktrees

```sh
git-dedup clone --recurse-submodules https://github.com/you/project.git
cd project
git-dedup submodule update --init --recursive
git-dedup worktree add -b review ../project-review
```

Supported updates prepare missing submodule repositories from the pool, including nested modules with `--recursive`. `git-dedup submodule add` adds the module to the store after Git creates it. `git-dedup worktree add` uses Git's common object database and initializes supported submodules in the new worktree; `--no-checkout` defers initialization.

Other Git commands and unsupported clone forms pass through to Git. Local path clones, shallow or partial clones, and SHA-256 repositories use ordinary Git behavior. When git-dedup forwards a clone, submodule, or worktree command it would otherwise handle, it prints one `git-dedup: <reason>; using plain Git` line on stderr unless you pass `-q` or `--quiet`.

`store add` accepts a local checkout path, not a remote URL. The checkout can then depend on the shared store for Git objects. `store fetch` refreshes registered remotes.

`store add --all` scans checkout directories below the given path without following symlinks. Within a Git worktree, it follows applicable Git ignore rules and skips `.git` metadata. Outside a Git worktree, it scans all directory names until it finds a checkout. It does not initialize absent submodules. Linked worktrees sharing one Git object database are processed once. Each checkout's outcome appears separately, and a failed checkout does not stop the remaining targets.

### Store commands

| Command                                 | Purpose                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `git-dedup store add [path]`            | Adopt or relink a repository and its submodules; report skipped and failed paths (`--verbose` shows full Git errors) |
| `git-dedup store add <directory> --all` | Discover and adopt checkouts below a directory; use `--dry-run` to preview                                           |
| `git-dedup store`                       | Show store path, remote count, size, and Git and pool health checks                                                  |
| `git-dedup store fetch`                 | Fetch registered remotes into the pool                                                                               |
| `git-dedup store gc`                    | Compact the pool without pruning consumer objects                                                                    |

### Optional storage reports

```sh
git-dedup --stats clone https://github.com/bhouston/git-dedup.git git-dedup-extra
git-dedup store add ./git-dedup-extra --stats
```

Reports go to stderr. See [storage reports](https://git-dedup.ben3d.ca/docs/how-it-works#storage-reports) for what they measure.

## Configuration

The default store is `~/.git-dedup`. Override it with `GIT_DEDUP_STORE`:

```sh
export GIT_DEDUP_STORE="$HOME/my-git-dedup-store"
```

Changing `GIT_DEDUP_STORE` selects a different store; it does not move the existing one. git-dedup does not change global Git configuration.

| Setting             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `GIT_DEDUP_STORE`   | Override the store path for an invocation |
| `git-dedup.gitPath` | Select the Git executable                 |

## Store dependency

Linked checkouts depend on the object pool through Git alternates. Deleting or moving the store can make their history unreadable. The pool can be on a different filesystem.

Read the [storage model](https://git-dedup.ben3d.ca/docs/how-it-works) and [store dependency guide](https://git-dedup.ben3d.ca/docs/safety) for details.

## Command documentation and agents

Run `git-dedup --help` or a store command's `--help` flag for options. `git-dedup docgen` writes [clidoc](https://github.com/bhouston/clidoc) documentation:

```sh
git-dedup docgen --format json --output git-dedup.json
git-dedup docgen --format markdown --output git-dedup-commands.md
```

The [agent setup guide](https://git-dedup.ben3d.ca/docs/agents) has copyable instructions for `AGENTS.md` and `CLAUDE.md` after a global installation.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/git-dedup/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/git-dedup/releases) for release notes.

## License

[MIT](https://github.com/bhouston/git-dedup/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
