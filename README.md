# git-dedup

[![npm version](https://img.shields.io/npm/v/git-dedup.svg)](https://www.npmjs.com/package/git-dedup)
[![npm downloads](https://img.shields.io/npm/dm/git-dedup.svg)](https://www.npmjs.com/package/git-dedup)
[![CI](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/bhouston/git-dedup/branch/main/graph/badge.svg)](https://codecov.io/gh/bhouston/git-dedup)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/git-dedup/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-git--dedup-blue)](https://git-dedup.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

**Faster checkouts, a fraction of the disk space.**

git-dedup is a wrapper around `git` built for fleets of coding agents. It forwards ordinary Git commands unchanged and automatically keeps one shared copy of Git history, so every new clone, worktree, and submodule reuses what is already on disk instead of downloading it again.

- **6x faster checkouts.** Large checkouts drop from over a minute to about 10 seconds.
- **70% less disk.** Across 117 checkouts, Git data dropped from 35.5 GB to 11.1 GB.
- **No workflow changes.** Checkouts are normal Git repositories. Use `git`, your editor, and your agents as before.

## Install and use

```sh
npm install --global git-dedup

# check out a new repo automatically using the dedup store
git-dedup clone https://github.com/you/project.git

# dedup an existing repo into the store
git-dedup store add ./my-existing-repo
```

That's it. git-dedup automatically consolidates the new or existing project's history into a shared store in `~/.git-dedup` or if its history already existed there, it reuses it automatically.

Requires **Node.js 22+ and Git**. Tested on macOS, Linux, and Windows.

**[Documentation](https://git-dedup.ben3d.ca/) · [CLI reference](https://git-dedup.ben3d.ca/docs/cli) · [Agent setup](https://git-dedup.ben3d.ca/docs/agents)**

## Why I built it

I run fleets of coding agents, each in its own checkout. Every task started by cloning repositories and submodules from scratch, so agents sat idle waiting on downloads. Then I started running out of disk space, because every checkout held another full copy of the same history. git-dedup fixed both. We have dogfooded it heavily across our own agent fleets and repositories to make it robust and efficient.

## More commands

```sh
# Worktrees and submodules get their history from the store too.
git-dedup clone --recurse-submodules https://github.com/you/project.git
git-dedup worktree add -b my-task ../my-task
git-dedup submodule update --init --recursive

# Reclaim space from repositories you already have.
git-dedup store add .
git-dedup store add ~/Coding --all

# Inspect the store.
git-dedup store
```

Ordinary commands, such as `git-dedup status`, are forwarded to Git. Unsupported clone and fetch forms fall back to plain Git. See the [CLI reference](https://git-dedup.ben3d.ca/docs/cli).

## Shallow checkouts and CI

Supported network clones and fetches ignore `--depth` (any value), `--single-branch`, `--filter=blob:none`, and `--filter=tree:0`, providing full history through the shared store. A cold store downloads full history once; later runs reuse its objects while still checking the remote for updates. There is no opt-out: use native Git for true shallow semantics. `--shallow-since` and `--shallow-exclude` pass through unchanged, and sparse working-tree settings stay intact. Fetch upgrades an existing shallow repository to full history; `--deepen` and `--unshallow` add no history restriction on an already full repository.

On a self-hosted GitHub Actions runner, `actions/checkout` invokes `git init` and `git fetch`, so install a `git` shim pointing to git-dedup ahead of native Git on the runner's `PATH` **before checkout runs**. Keep Node.js and the store available between jobs, and set `git-dedup.gitPath` to the absolute native Git executable to avoid shim recursion. See the [CI setup guide](https://git-dedup.ben3d.ca/docs/ci).

## Configuration

The default store is `~/.git-dedup` (`%USERPROFILE%\.git-dedup` on Windows). Override it with `GIT_DEDUP_STORE`:

```sh
export GIT_DEDUP_STORE="$HOME/my-git-dedup-store"
```

```powershell
$env:GIT_DEDUP_STORE = "$HOME\my-git-dedup-store"
```

Changing `GIT_DEDUP_STORE` selects a different store; it does not move the existing one. git-dedup does not change global Git configuration.

| Setting             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `GIT_DEDUP_STORE`   | Override the store path for an invocation |
| `git-dedup.gitPath` | Select the Git executable                 |

## Keep the store

Your checkouts read their history from the shared store. Deleting it breaks every repository consolidated into it. See the [store guide](https://git-dedup.ben3d.ca/docs/safety) for moving or detaching checkouts.

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
