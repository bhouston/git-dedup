# git-dedup

[![npm version](https://img.shields.io/npm/v/git-dedup.svg)](https://www.npmjs.com/package/git-dedup)
[![npm downloads](https://img.shields.io/npm/dm/git-dedup.svg)](https://www.npmjs.com/package/git-dedup)
[![CI](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/bhouston/git-dedup/branch/main/graph/badge.svg)](https://codecov.io/gh/bhouston/git-dedup)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/git-dedup/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-git--dedup-blue)](https://git-dedup.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

**Many coding agents, one copy of Git history.**

Coding agents and editors clone the same repositories again and again: one checkout per task, per agent, per review. Each clone normally carries its own full copy of the history. git-dedup is a Git wrapper whose clones, forks, and worktree submodules share one local object pool, so every new checkout reuses the history already on disk.

In one typical local setup spanning 117 checkouts (94 distinct Git object databases, with linked worktrees counted once), git-dedup uses 11.1 GB for Git objects versus 35.5 GB without sharing, saving about 24.4 GB (70%). Checkout is also 6x faster for large repos, dropping from over 1 minute to 10 seconds.

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

**[Documentation](https://git-dedup.ben3d.ca/) · [CLI reference](https://git-dedup.ben3d.ca/docs/cli) · [Agent setup](https://git-dedup.ben3d.ca/docs/agents)**

## Features

- Reuse one object pool across remotes and repeated clones.
- Consolidate existing repositories, including local commits and discoverable submodules.
- Prepare nested submodules and submodules inside new worktrees from the pool.
- Inspect storage sharing with optional [`--stats` reports](https://git-dedup.ben3d.ca/docs/how-it-works#storage-reports).
- Fetch registered remotes and compact the pool while retaining consumer objects.
- Use the TypeScript core library in your own Node.js tools.

Requires **Node.js 22+ and Git**. Tested on macOS and Linux.

## Installation

```sh
npm install --global git-dedup
```

The executable is `git-dedup`. The source repository is [bhouston/git-dedup](https://github.com/bhouston/git-dedup).

## Quick start

```sh
# Clone the same remote into two working copies.
git-dedup clone https://github.com/bhouston/git-dedup.git git-dedup-main
git-dedup --stats clone https://github.com/bhouston/git-dedup.git git-dedup-review

# Consolidate a repository you already have.
git-dedup store add ./git-dedup-main --stats

# Inspect the store and your setup.
git-dedup store
git-dedup store list
```

Use ordinary Git inside either checkout. git-dedup also forwards Git commands such as `git-dedup status`, `git-dedup diff`, and `git-dedup -C git-dedup-main log --oneline`.

### Submodules and worktrees

```sh
git-dedup clone --recurse-submodules https://github.com/you/project.git
cd project
git-dedup submodule update --init --recursive
git-dedup worktree add -b review ../project-review
```

Supported submodule updates prepare missing module repositories from the pool before Git checks them out. `worktree add` shares the main repository's common object database and initializes supported submodules in the new worktree. With `--no-checkout`, initialization waits for a later submodule update. `submodule add` uses Git, then adds the module to the shared store.

Unsupported clone forms, including local paths, shallow or partial clones, and SHA-256 repositories, use ordinary Git behavior. git-dedup then prints one `git-dedup: <reason>; using plain Git` line on stderr unless you pass `-q` or `--quiet`. See the [CLI reference](https://git-dedup.ben3d.ca/docs/cli) for the supported paths.

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

## Packages

| Package                                                                     | Purpose                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [git-dedup](https://www.npmjs.com/package/git-dedup)                        | CLI interface, Git forwarding, and `git-dedup docgen` documentation |
| [git-dedup-core](https://www.npmjs.com/package/git-dedup-core)              | Git operations, object pool, and storage API                        |
| [Website](https://github.com/bhouston/git-dedup/tree/main/packages/website) | Docusaurus documentation and project site; not published to npm     |

For scripts and applications:

```sh
npm install git-dedup-core
```

```ts
import { createGitDedup } from 'git-dedup-core';

const dedup = createGitDedup({ cwd: process.cwd() });
process.exitCode = await dedup.run(['clone', 'https://github.com/bhouston/git-dedup.git']);
```

See the [core API guide](https://github.com/bhouston/git-dedup/tree/main/packages/core). After installing globally, the [agent setup guide](https://git-dedup.ben3d.ca/docs/agents) provides instructions to add to `AGENTS.md` or `CLAUDE.md` so agents call `git-dedup` explicitly.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:proof
```

`pnpm check` runs Oxlint, Oxfmt, TypeScript checks, Vitest, workflow tests, npm package checks, and the documentation build. CLI tests use `vitest-command-line`. The proof script creates temporary loopback Git remotes and verifies that concurrent clones share one object pool and remain valid after pool maintenance.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [RELEASING.md](RELEASING.md) for release setup.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/git-dedup/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/git-dedup/releases) for release notes.

## License

[MIT](https://github.com/bhouston/git-dedup/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
