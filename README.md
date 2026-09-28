# gitx

[![npm version](https://img.shields.io/npm/v/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![npm downloads](https://img.shields.io/npm/dm/@bhouston/gitx.svg)](https://www.npmjs.com/package/@bhouston/gitx)
[![CI](https://github.com/bhouston/gix/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/gix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/gix/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-gitx-blue)](https://bhouston.github.io/gix/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

_A Git wrapper for independent checkouts backed by shared local storage._

gitx keeps a bare mirror for each supported remote and shares Git object files with repeated clones. Use it for parallel project checkouts, coding-agent workspaces, and repositories with submodules. Checkouts remain ordinary Git repositories with their original `origin` URL.

Optimized for short-lived repositories in agentic workflows. **Automatically** reuse Git objects across repeated checkouts and worktrees with submodules, reducing repeated downloads and duplicate object storage as agents spin up new workspaces. gitx manages mirror creation, updates, and reuse for you, removing the bookkeeping of maintaining mirrors and passing reference paths to each clone.

**[Documentation](https://bhouston.github.io/gix/) · [CLI reference](https://bhouston.github.io/gix/docs/cli) · [Agent setup](https://bhouston.github.io/gix/docs/agents)**

## Features

- Reuse local mirrors across repeated remote clones.
- Consolidate existing repositories, including local commits and discoverable submodules.
- Prepare nested submodules and submodules inside new worktrees from mirrors.
- Inspect storage sharing with optional `--stats` reports.
- Refresh, prune, and clear the store while preserving consumers' Git objects.
- Use the TypeScript core library in your own Node.js tools.

Requires **Node.js 22+ and Git**. Tested on macOS and Linux. Git LFS is optional for repositories that use it.

## Installation

```sh
npm install --global @bhouston/gitx
```

The executable is `gitx`. The source repository is [bhouston/gix](https://github.com/bhouston/gix).

## Quick start

```sh
# Clone the same remote into two independent working copies.
gitx clone https://github.com/bhouston/gix.git gix-main
gitx --stats clone https://github.com/bhouston/gix.git gix-review

# Consolidate a repository you already have.
gitx cache ./gix-main --stats

# Inspect the store and your setup.
gitx store
gitx doctor
```

Use ordinary Git inside either checkout. gitx also forwards Git commands such as `gitx status`, `gitx diff`, and `gitx -C gix-main log --oneline`.

### Submodules and worktrees

```sh
gitx clone --recurse-submodules https://github.com/you/project.git
cd project
gitx submodule update --init --recursive
gitx worktree add -b review ../project-review
```

Supported submodule updates prepare missing module repositories from mirrors before Git checks them out. `worktree add` shares the main repository's common object database and initializes supported submodules in the new worktree. With `--no-checkout`, initialization waits for a later submodule update. `submodule add` uses Git, then caches the added module.

Unsupported clone forms, including local paths, shallow or partial clones, and SHA-256 repositories, use ordinary Git behavior. See the [CLI reference](https://bhouston.github.io/gix/docs/cli) for the supported paths.

### Storage reports

Reports go to stderr and show whether a mirror was reused or created, bytes shared through hard links, and bytes copied. Clone savings estimate duplicate pack bytes avoided; cache savings compare private pack bytes before and after adoption.

Measurement is opt-in and scans local `.pack`, `.idx`, and `.rev` file metadata, without traversing Git objects. It excludes loose objects and Git LFS. These are logical file-size estimates, not measured disk blocks reclaimed; reflinks can share physical storage without matching inode IDs. Creating a mirror on first use may yield no net savings yet. Plain Git fallback does not print a report.

## Configuration

The default store is a cache directory in your home directory. Choose a location on the same filesystem as your repositories:

```sh
git config --global gitx.store "$HOME/.cache/gitx"
```

Installation and cloning do not change global Git configuration. `gitx store set <path>` is an explicit alternative that sets **both** global `gitx.store` and `lfs.storage`.

| Setting              | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `GITX_STORE`         | Override the store path for an invocation                                 |
| `GITX_DISABLE=1`     | Forward to Git without optimization                                       |
| `gitx.store`         | Store path in Git configuration                                           |
| `gitx.enabled=false` | Disable optimization persistently                                         |
| `gitx.gitPath`       | Select the Git executable                                                 |
| `gitx.linkMode`      | Choose `auto`, `hardlink`, `reflink`, or `copy` for eligible object files |

## How storage stays independent

Each consumer has its own Git object directory and uses no Git alternates. Hard links let multiple filenames refer to the same stored bytes: deleting the mirror removes its links while the consumer's links remain valid. Existing Git repositories remain usable after the store is deleted. Worktrees retain Git's normal dependency on their common repository.

Keep the store on the same filesystem as your working copies to enable hard links. Cross-filesystem copies and later Git maintenance can reduce sharing. The first clone creates a mirror, so savings generally come from reusing it across consumers.

Git LFS is separate. `gitx store clear` also removes the store's LFS directory; objects held only there may need to be fetched again. Cache adoption retains existing local LFS objects. Clearing requires the `.gitx-store` marker and refuses directories with unrelated files. Store mutations are serialized with locks.

Read the [storage model](https://bhouston.github.io/gix/docs/how-it-works) and [safety guide](https://bhouston.github.io/gix/docs/safety) for details.

## Packages

| Package                                                                  | Purpose                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [@bhouston/gitx](https://www.npmjs.com/package/@bhouston/gitx)           | CLI interface, Git forwarding, and clidoc/OpenCLI support       |
| [@bhouston/gitx-core](https://www.npmjs.com/package/@bhouston/gitx-core) | Git operations, mirrors, and storage API                        |
| [Website](https://github.com/bhouston/gix/tree/main/packages/website)    | Docusaurus documentation and project site; not published to npm |

For scripts and applications:

```sh
npm install @bhouston/gitx-core
```

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({ cwd: process.cwd() });
process.exitCode = await gitx.run(['clone', 'https://github.com/bhouston/gix.git']);
```

See the [core API guide](https://github.com/bhouston/gix/tree/main/packages/core). After installing globally, the [agent setup guide](https://bhouston.github.io/gix/docs/agents) provides instructions to add to `AGENTS.md` or `CLAUDE.md` so agents call `gitx` explicitly.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:proof
```

`pnpm check` runs Oxlint, Oxfmt, TypeScript checks, Vitest, workflow tests, npm package checks, and the documentation build. CLI tests use `vitest-command-line`. The proof script creates temporary loopback Git remotes, verifies concurrent clones share object files, deletes the store, and checks that consumers remain valid.

See [development documentation](https://bhouston.github.io/gix/docs/development), the [implementation plan](https://github.com/bhouston/gix/blob/main/docs/PLAN.md), and [release setup](https://github.com/bhouston/gix/blob/main/RELEASING.md).

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/gix/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gix/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gix/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
