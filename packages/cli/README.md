# gitx CLI

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

For large repositories, reusing a populated store can turn a **100+ second fresh clone into a near-instant repeat checkout**. The first clone fills the mirror; actual times depend on remote updates, disk speed, and the files Git needs to check out.

**[Documentation](https://gitx.ben3d.ca/) · [Source](https://github.com/bhouston/gitx) · [Agent setup](https://gitx.ben3d.ca/docs/agents)**

## Installation

Requires **Node.js 22+ and Git** on macOS or Linux.

```sh
npm install --global @bhouston/gitx
gitx --help
```

## Usage

```sh
# Repeated clones reuse the remote's mirror.
gitx clone https://github.com/bhouston/gitx.git gitx-main
gitx --stats clone https://github.com/bhouston/gitx.git gitx-review

# Adopt an existing repository and its discoverable submodules.
gitx cache ./gitx-main --stats

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

Supported updates prepare missing submodule repositories from mirrors, including nested modules with `--recursive`. `gitx submodule add` caches the module after Git creates it. `gitx worktree add` uses Git's common object database and initializes supported submodules in the new worktree; `--no-checkout` defers initialization.

Other Git commands and unsupported clone forms pass through to Git. Local path clones, shallow or partial clones, and SHA-256 repositories use ordinary Git behavior.

### Store commands

| Command                      | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `gitx cache [path]`          | Adopt or relink an existing repository and its discoverable submodules |
| `gitx store`                 | Show store path, mirror count, and size                                |
| `gitx store refresh`         | Fetch and repack mirrors                                               |
| `gitx store gc --unused 30d` | Remove mirrors unused for the specified age                            |
| `gitx store clear`           | Delete the recognized store, including stored LFS objects              |
| `gitx store set <path>`      | Set global `gitx.store` and `lfs.storage`                              |
| `gitx doctor`                | Inspect filesystem, Git, and LFS setup                                 |

### Optional storage reports

```sh
gitx --stats clone https://github.com/bhouston/gitx.git gitx-extra
gitx cache ./gitx-extra --stats
```

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

## Storage safety

Each consumer has its own Git object directory and uses no Git alternates. Hard links let multiple filenames refer to the same stored bytes: deleting the mirror removes its links while the consumer's links remain valid. Existing Git repositories remain usable after the store is deleted. Worktrees retain Git's normal dependency on their common repository.

Keep the store on the same filesystem as your working copies to enable hard links. Cross-filesystem copies and later Git maintenance can reduce sharing. The first clone creates a mirror, so savings generally come from reusing it across consumers.

Git LFS is separate. `gitx store clear` also removes the store's LFS directory; objects held only there may need to be fetched again. Cache adoption retains existing local LFS objects. Clearing requires the `.gitx-store` marker and refuses directories with unrelated files. Store mutations are serialized with locks.

Read the [storage model](https://gitx.ben3d.ca/docs/how-it-works) and [safety guide](https://gitx.ben3d.ca/docs/safety) for details.

## Command documentation and agents

Run `gitx --help` or a store command's `--help` flag for options. The CLI supports [clidoc](https://github.com/bhouston/clidoc) and OpenCLI output:

```sh
gitx docgen --format json --output gitx.json
gitx docgen --format markdown --output gitx-commands.md
gitx __opencli
```

The [agent setup guide](https://gitx.ben3d.ca/docs/agents) has copyable instructions for `AGENTS.md` and `CLAUDE.md` after a global installation.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/gitx/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gitx/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gitx/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
