# gitx CLI

[![npm version](https://img.shields.io/npm/v/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![npm downloads](https://img.shields.io/npm/dm/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![CI](https://github.com/bhouston/gitx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/gitx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/gitx/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-gitx-blue)](https://gitx.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

gitx keeps Git objects from many remotes in one local object pool. Supported clones and linked repositories use Git alternates to borrow those objects, reducing duplicate storage across checkouts and forks. gitx is not a disposable cache: linked checkouts depend on the store.

In one typical local setup spanning 117 checkouts (94 distinct Git object databases, with linked worktrees counted once), gitx uses 11.1 GB for Git objects versus an estimated 35.5 GB without sharing, saving about 24.4 GB (69%).

```sh
# Populate the shared object pool in ~/.gitx.
gitx clone https://github.com/you/project.git project

# Another checkout borrows objects from the same pool.
gitx clone https://github.com/you/project.git project-review
cd project-review

# All normal Git commands work in the checkout.
git status
git diff
git log --oneline
```

Repeated clones can borrow objects already in the pool, reducing download and storage work.

**[Documentation](https://gitx.ben3d.ca/) · [Source](https://github.com/bhouston/gitx) · [Agent setup](https://gitx.ben3d.ca/docs/agents)**

## Installation

Requires **Node.js 22+ and Git** on macOS or Linux.

```sh
npm install --global @bhouston/gitx
gitx --help
```

## Usage

```sh
# Repeated clones borrow from the shared pool.
gitx clone https://github.com/bhouston/gitx.git gitx-main
gitx --stats clone https://github.com/bhouston/gitx.git gitx-review

# Adopt an existing repository and its discoverable submodules.
gitx cache ./gitx-main --stats

# Preview, then cache every checkout in a workspace directory.
gitx cache ~/Coding --all --dry-run
gitx cache ~/Coding --all

# Ordinary Git commands also work through gitx.
gitx -C gitx-main status
```

### Submodules and worktrees

```sh
gitx clone --recurse-submodules https://github.com/you/project.git
cd project
gitx submodule update --init --recursive
gitx worktree add -b review ../project-review
```

Supported updates prepare missing submodule repositories from the pool, including nested modules with `--recursive`. `gitx submodule add` caches the module after Git creates it. `gitx worktree add` uses Git's common object database and initializes supported submodules in the new worktree; `--no-checkout` defers initialization.

Other Git commands and unsupported clone forms pass through to Git. Local path clones, shallow or partial clones, and SHA-256 repositories use ordinary Git behavior.

`cache --all` scans checkout directories below the given path without following symlinks. It skips Git metadata and common dependency/build directories (`node_modules`, `vendor`, `dist`, `build`, `target`, `.next`, `.nuxt`, `.turbo`, `.venv`, and `coverage`). It does not initialize absent submodules. Linked worktrees sharing one Git object database are processed once. Each checkout's outcome appears separately, and a failed checkout does not stop the remaining targets.

### Store commands

| Command                        | Purpose                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `gitx cache [path]`            | Adopt or relink an existing repository and its discoverable submodules     |
| `gitx cache <directory> --all` | Discover and cache checkouts below a directory; use `--dry-run` to preview |
| `gitx store`                   | Show store path, remote count, and size                                    |
| `gitx store fetch`             | Fetch registered remotes into the pool                                     |
| `gitx store gc`                | Compact the pool without pruning consumer objects                          |
| `gitx doctor`                  | Inspect the pool and Git setup                                             |

### Optional storage reports

```sh
gitx --stats clone https://github.com/bhouston/gitx.git gitx-extra
gitx cache ./gitx-extra --stats
```

Reports go to stderr and show whether the pool already existed. Cache reports compare private pack bytes before and after adoption. Clone reports identify use of Git alternates; they do not estimate disk savings.

Measurement is opt-in and scans local `.pack`, `.idx`, and `.rev` file metadata, without traversing Git objects. It excludes loose objects. These are logical file-size estimates, not measured disk blocks reclaimed. The first use populates the pool and can increase total disk use. Plain Git fallback does not print a report.

## Configuration

The default store is `~/.gitx`. Override it with `GITX_STORE`:

```sh
export GITX_STORE="$HOME/my-gitx-store"
```

Changing `GITX_STORE` selects a different store; it does not move the existing one. gitx does not change global Git configuration.

| Setting        | Purpose                                   |
| -------------- | ----------------------------------------- |
| `GITX_STORE`   | Override the store path for an invocation |
| `gitx.gitPath` | Select the Git executable                 |

## Store dependency

Cached checkouts depend on the object pool through Git alternates. Deleting or moving the store can make their history unreadable. The pool can be on a different filesystem.

Read the [storage model](https://gitx.ben3d.ca/docs/how-it-works) and [store dependency guide](https://gitx.ben3d.ca/docs/safety) for details.

## Command documentation and agents

Run `gitx --help` or a store command's `--help` flag for options. `gitx docgen` writes [clidoc](https://github.com/bhouston/clidoc) documentation:

```sh
gitx docgen --format json --output gitx.json
gitx docgen --format markdown --output gitx-commands.md
```

The [agent setup guide](https://gitx.ben3d.ca/docs/agents) has copyable instructions for `AGENTS.md` and `CLAUDE.md` after a global installation.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/gitx/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gitx/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gitx/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
