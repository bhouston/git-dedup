# gitx

[![npm version](https://img.shields.io/npm/v/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![npm downloads](https://img.shields.io/npm/dm/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![CI](https://github.com/bhouston/gitx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/gitx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/gitx/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-gitx-blue)](https://gitx.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

gitx keeps Git objects from many remotes in one local object pool. Supported clones and cached repositories use Git alternates to borrow those objects, reducing duplicate storage across checkouts and forks.

```sh
# Populate the shared object pool in ~/.cache/gitx.
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

**[Documentation](https://gitx.ben3d.ca/) · [CLI reference](https://gitx.ben3d.ca/docs/cli) · [Agent setup](https://gitx.ben3d.ca/docs/agents)**

## Features

- Reuse one object pool across remotes and repeated clones.
- Consolidate existing repositories, including local commits and discoverable submodules.
- Prepare nested submodules and submodules inside new worktrees from the pool.
- Inspect storage sharing with optional `--stats` reports.
- Fetch registered remotes and compact the pool while retaining consumer objects.
- Use the TypeScript core library in your own Node.js tools.

Requires **Node.js 22+ and Git**. Tested on macOS and Linux.

## Installation

```sh
npm install --global @bhouston/gitx
```

The executable is `gitx`. The source repository is [bhouston/gitx](https://github.com/bhouston/gitx).

## Quick start

```sh
# Clone the same remote into two working copies.
gitx clone https://github.com/bhouston/gitx.git gitx-main
gitx --stats clone https://github.com/bhouston/gitx.git gitx-review

# Consolidate a repository you already have.
gitx cache ./gitx-main --stats

# Inspect the store and your setup.
gitx store
gitx doctor
```

Use ordinary Git inside either checkout. gitx also forwards Git commands such as `gitx status`, `gitx diff`, and `gitx -C gitx-main log --oneline`.

### Submodules and worktrees

```sh
gitx clone --recurse-submodules https://github.com/you/project.git
cd project
gitx submodule update --init --recursive
gitx worktree add -b review ../project-review
```

Supported submodule updates prepare missing module repositories from the pool before Git checks them out. `worktree add` shares the main repository's common object database and initializes supported submodules in the new worktree. With `--no-checkout`, initialization waits for a later submodule update. `submodule add` uses Git, then caches the added module.

Unsupported clone forms, including local paths, shallow or partial clones, and SHA-256 repositories, use ordinary Git behavior. See the [CLI reference](https://gitx.ben3d.ca/docs/cli) for the supported paths.

### Storage reports

Reports go to stderr and show whether the pool already existed. Cache reports compare private pack bytes before and after adoption. Clone reports identify use of Git alternates; they do not estimate disk savings.

Measurement is opt-in and scans local `.pack`, `.idx`, and `.rev` file metadata, without traversing Git objects. It excludes loose objects. These are logical file-size estimates, not measured disk blocks reclaimed. The first use populates the pool and can increase total disk use. Plain Git fallback does not print a report.

## Configuration

The default store is `~/.cache/gitx`. Override it with `GITX_STORE`:

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

## Packages

| Package                                                                  | Purpose                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [@bhouston/gitx](https://www.npmjs.com/package/@bhouston/gitx)           | CLI interface, Git forwarding, and `gitx docgen` documentation  |
| [@bhouston/gitx-core](https://www.npmjs.com/package/@bhouston/gitx-core) | Git operations, object pool, and storage API                    |
| [Website](https://github.com/bhouston/gitx/tree/main/packages/website)   | Docusaurus documentation and project site; not published to npm |

For scripts and applications:

```sh
npm install @bhouston/gitx-core
```

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({ cwd: process.cwd() });
process.exitCode = await gitx.run(['clone', 'https://github.com/bhouston/gitx.git']);
```

See the [core API guide](https://github.com/bhouston/gitx/tree/main/packages/core). After installing globally, the [agent setup guide](https://gitx.ben3d.ca/docs/agents) provides instructions to add to `AGENTS.md` or `CLAUDE.md` so agents call `gitx` explicitly.

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

See [CONTRIBUTING.md](https://github.com/bhouston/gitx/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gitx/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gitx/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
