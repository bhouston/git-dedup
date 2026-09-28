---
title: Why gitx?
---

gitx makes repeated checkouts faster and smaller by automatically reusing a local mirror. It is built for coding agents, parallel tasks, and short-lived workspaces that need fresh copies of the same repositories.

## Clone freely, store once

Every new workspace usually downloads and stores another copy of a repository's history. gitx keeps a mirror in its local store and reuses those Git objects across checkouts. You run a familiar command; gitx manages the mirror for you.

```sh
# Automatically create or reuse a mirror in ~/.cache/gitx.
gitx clone https://github.com/you/project.git project-main

# Reuse it for another independent checkout.
gitx clone https://github.com/you/project.git project-review

# Add a repository you already have.
gitx cache ./existing-project
```

For large repositories, reusing a populated store can turn a **100+ second fresh clone into a near-instant repeat checkout**. Add `--stats` to see how much packed data is shared.

The same approach helps with submodules and submodules inside new worktrees. Agents can create workspaces as needed while gitx handles mirror creation, updates, and reuse in the background.

## Keep using Git

Each checkout is an ordinary Git repository with its original remote URL. Use `git status`, `git diff`, `git commit`, and the rest of your normal workflow. Editors and other Git tools continue to work with it.

gitx also forwards ordinary Git commands, so you can use it consistently in scripts and agent instructions. The [agent setup guide](./agents.md) has a short instruction you can add to your project.

## Inspired by pnpm

pnpm showed how convenient a shared local store can be: run the command and let the tool reuse data across projects. gitx brings that simplicity to Git repositories.

You do not need to maintain mirrors yourself, find the right reference path for each clone, or remember extra flags. Sharing becomes part of creating a checkout.

## Compared with manual mirrors and reference clones

Git provides the building blocks, but you have to remember the setup for every repository:

```sh
# Create a mirror before using it for checkouts.
mkdir -p ~/git-mirrors
git clone --mirror https://github.com/you/project.git ~/git-mirrors/project.git

# Remember its location and refresh it before each new checkout.
git -C ~/git-mirrors/project.git fetch --prune origin

# Clone locally to share objects, then restore the real remote URL.
git clone ~/git-mirrors/project.git project-review
git -C project-review remote set-url origin https://github.com/you/project.git
```

Reference clones also require the mirror path each time. Add `--dissociate` to keep the checkout independent:

```sh
git clone --reference ~/git-mirrors/project.git --dissociate \
  https://github.com/you/project.git project-task
```

For each different repository, you must create its own mirror first, remember where it lives, keep it updated, and use the right clone commands. That is a lot of bookkeeping.

With gitx:

```sh
# Mirror creation, lookup, updates, and reuse are automatic.
gitx clone https://github.com/you/project.git project-review
gitx clone https://github.com/you/another-project.git another-task
```

gitx automates the local-mirror workflow while keeping its benefits: fewer downloads, shared object storage, independent checkouts, and normal remote URLs.

Chromium's **depot_tools** also offers Git caching as part of its development toolchain. gitx focuses on a simple, general-purpose CLI for everyday repositories. Use depot_tools for projects built around it; use gitx to add automatic mirror reuse to your existing Git workflow.

[Get started](./index.md) with one npm install. See the [CLI reference](/docs/cli) for commands and [Safety](./safety.md) for storage guarantees.
