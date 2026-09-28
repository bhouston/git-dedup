---
id: index
title: Get started
slug: /
---

gitx is a Node.js wrapper around Git. It keeps a local mirror for a remote so repeated clones can reuse Git objects. Its checkouts are ordinary Git repositories with their original `origin` URL.

gitx requires Node.js 22 or newer, Git, and macOS or Linux. This project is in active development; see the [roadmap](./roadmap.md) for the current scope.

## From this repository

```sh
pnpm install
pnpm build
node packages/cli/dist/bin.js clone https://github.com/you/project.git
```

Add `--stats` before `clone` to see a local storage-sharing estimate, or use `gitx cache [path] --stats` when adopting an existing repository. The report is optional and based on pack file sizes and filesystem metadata. See the [CLI reference](./cli.md#optional-storage-report) for how to read it.

After installing the CLI globally, the command is `gitx clone <remote> [directory]`. You can also run a Git command through gitx and inspect the result with ordinary Git:

```sh
cd project
git remote -v
git status
```

gitx chooses a store using `GITX_STORE` or Git's `gitx.store` configuration. If neither is set, it uses a cache directory in your home directory. Put the store on the same filesystem as your working copies to allow Git to share object files through hard links. A different filesystem still permits a working clone, but Git may copy objects.

```sh
git config --global gitx.store "$HOME/.cache/gitx"
```

gitx does not change your global Git configuration during installation or cloning. The command above is an explicit, optional preference.

Alternatively, `gitx store set <path>` writes the global `gitx.store` **and** `lfs.storage` Git settings. Use it only if you want both settings to point into the chosen store.

Git configuration also supports `gitx.enabled=false` for a persistent Git passthrough, `gitx.gitPath` to choose the real Git executable, and `gitx.linkMode` (`auto`, `hardlink`, `reflink`, or `copy`) to control how eligible objects enter consumers. `GITX_DISABLE=1` bypasses the optimization for one command. These settings are opt-in; gitx does not edit them during a clone.

## Store commands

```sh
gitx store                   # path, mirror count, and size
gitx store refresh           # fetch and repack mirrors
gitx store gc --unused 30d   # remove old mirrors
gitx doctor                  # inspect Git and store setup
gitx cache [path]            # adopt or relink an existing repository
```

`gitx store clear` removes the store, including its `lfs` directory. It requires a gitx store marker and refuses a directory with unrelated files. Read [the safety guide](./safety.md) before using it.

## What to expect

Supported remote clones use a bare mirror in the store. The resulting clone has its own `.git/objects` and a real remote URL. Commands outside gitx's supported optimization path are forwarded to Git. For example, local path clones and options that change object selection use ordinary Git behavior.

For a supported repository, `gitx submodule update --init` prepares missing submodule Git directories from mirrors before handing checkout to Git. `--recursive` extends this to nested submodules, and `gitx clone --recurse-submodules <remote>` uses that flow. `gitx submodule add` first uses Git, then caches the new submodule. `gitx worktree add` uses Git's shared common object database and initializes supported submodules from mirrors in the new worktree. `--no-checkout` leaves initialization to a later update.

Read [how it works](./how-it-works.md) for the storage model and [safety](./safety.md) before deleting a store or using Git LFS.

The [CLI reference](./cli.md) lists gitx commands and clidoc output options.

If you use a coding agent, the [agent setup guide](./agents.md) has copyable text for `AGENTS.md` or `CLAUDE.md` after gitx is installed globally.
