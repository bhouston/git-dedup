# gitx

[![npm version](https://img.shields.io/npm/v/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![npm downloads](https://img.shields.io/npm/dm/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![CI](https://github.com/bhouston/gitx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/gitx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/gitx/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-gitx-blue)](https://gitx.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

gitx automatically reuses Git objects across checkouts through a local mirror store. Built for short-lived coding-agent workspaces, it gives you independent checkouts with fewer downloads and less duplicate storage.

```sh
# Automatically create or reuse a mirror in the default store: ~/.cache/gitx.
gitx clone https://github.com/you/project.git project

# Another checkout reuses the mirror instead of downloading it all again.
gitx clone https://github.com/you/project.git project-review
cd project-review

# All normal Git commands work in the checkout.
git status
git diff
git log --oneline
```

For large repositories, reusing a populated store can turn a **100+ second fresh clone into a near-instant repeat checkout**.

**[Documentation](https://gitx.ben3d.ca/) · [CLI reference](https://gitx.ben3d.ca/docs/cli) · [Agent setup](https://gitx.ben3d.ca/docs/agents)**

## Features

- Reuse local mirrors across repeated remote clones.
- Consolidate existing repositories, including local commits and discoverable submodules.
- Prepare nested submodules and submodules inside new worktrees from mirrors.
- Inspect storage sharing with optional `--stats` reports.
- Fetch and prune the store while preserving consumers' Git objects.
- Use the TypeScript core library in your own Node.js tools.

Requires **Node.js 22+ and Git**. Tested on macOS and Linux. Git LFS is optional for repositories that use it.

## Installation

```sh
npm install --global @bhouston/gitx
```

The executable is `gitx`. The source repository is [bhouston/gitx](https://github.com/bhouston/gitx).

## Quick start

```sh
# Clone the same remote into two independent working copies.
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

Supported submodule updates prepare missing module repositories from mirrors before Git checks them out. `worktree add` shares the main repository's common object database and initializes supported submodules in the new worktree. With `--no-checkout`, initialization waits for a later submodule update. `submodule add` uses Git, then caches the added module.

Unsupported clone forms, including local paths, shallow or partial clones, and SHA-256 repositories, use ordinary Git behavior. See the [CLI reference](https://gitx.ben3d.ca/docs/cli) for the supported paths.

### Storage reports

Reports go to stderr and show whether a mirror was reused or created, bytes shared through hard links, and bytes copied. Clone savings estimate duplicate pack bytes avoided; cache savings compare private pack bytes before and after adoption.

Measurement is opt-in and scans local `.pack`, `.idx`, and `.rev` file metadata, without traversing Git objects. It excludes loose objects and Git LFS. These are logical file-size estimates, not measured disk blocks reclaimed; reflinks can share physical storage without matching inode IDs. Creating a mirror on first use may yield no net savings yet. Plain Git fallback does not print a report.

## Configuration

The default store is `~/.cache/gitx`. Override it with `GITX_STORE`:

```sh
export GITX_STORE="$HOME/my-gitx-store"
```

Changing `GITX_STORE` selects a different store; it does not move the existing one. gitx does not change global Git configuration.

| Setting              | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `GITX_STORE`         | Override the store path for an invocation                                 |
| `GITX_DISABLE=1`     | Forward to Git without optimization                                       |
| `gitx.enabled=false` | Disable optimization persistently                                         |
| `gitx.gitPath`       | Select the Git executable                                                 |
| `gitx.linkMode`      | Choose `auto`, `hardlink`, `reflink`, or `copy` for eligible object files |

## How storage stays independent

Each consumer has its own Git object directory and uses no Git alternates. Hard links let multiple filenames refer to the same stored bytes: deleting the mirror removes its links while the consumer's links remain valid. Existing Git repositories remain usable after the store is deleted. Worktrees retain Git's normal dependency on their common repository.

Keep the store on the same filesystem as your working copies to enable hard links. Cross-filesystem copies and later Git maintenance can reduce sharing. The first clone creates a mirror, so savings generally come from reusing it across consumers.

To remove the store, delete its directory when no gitx operations are running. Cache adoption retains existing local Git LFS objects. gitx does not configure `lfs.storage`.

Read the [storage model](https://gitx.ben3d.ca/docs/how-it-works) and [safety guide](https://gitx.ben3d.ca/docs/safety) for details.

## Packages

| Package                                                                  | Purpose                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [@bhouston/gitx](https://www.npmjs.com/package/@bhouston/gitx)           | CLI interface, Git forwarding, and clidoc/OpenCLI support       |
| [@bhouston/gitx-core](https://www.npmjs.com/package/@bhouston/gitx-core) | Git operations, mirrors, and storage API                        |
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

`pnpm check` runs Oxlint, Oxfmt, TypeScript checks, Vitest, workflow tests, npm package checks, and the documentation build. CLI tests use `vitest-command-line`. The proof script creates temporary loopback Git remotes, verifies concurrent clones share object files, deletes the store, and checks that consumers remain valid.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [RELEASING.md](RELEASING.md) for release setup.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/gitx/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gitx/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gitx/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
