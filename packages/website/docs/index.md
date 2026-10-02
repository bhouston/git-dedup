---
id: index
title: Get started
slug: /
---

**Faster checkouts, a fraction of the disk space.** git-dedup keeps one shared copy of Git history for all your clones, worktrees, and submodules. Large checkouts are 6x faster, dropping from over a minute to about 10 seconds, and Git data takes 70% less disk (11.1 GB instead of 35.5 GB across 117 checkouts).

## Install

```sh
npm install -g git-dedup
```

Requires Node.js 22+ and Git on macOS, Linux, or Windows.

## Clone

```sh
# check out a new repo automatically using the dedup store
git-dedup clone https://github.com/you/project.git

# dedup an existing repo into the store
git-dedup store add ./my-existing-repo
```

That's it. git-dedup automatically consolidates the new or existing project's history into a shared store in `~/.git-dedup` or if its history already existed there, it reuses it automatically. The checkout is a normal Git repository, so keep using `git` as usual.

## Worktrees and submodules

Worktrees and submodules get their history from the store too:

```sh
git-dedup clone --recurse-submodules https://github.com/you/project.git
git-dedup worktree add -b my-task ../my-task
git-dedup submodule update --init --recursive
```

## Reclaim space from existing repositories

```sh
# Consolidate one repository.
git-dedup store add .

# Or every repository under a directory.
git-dedup store add ~/Coding --all
```

## Keep the store

Your checkouts read their history from `~/.git-dedup`. Deleting it breaks every repository consolidated into it. See [the store](./safety.md) for moving or detaching checkouts.

Next: [set up your agents](./agents.md) or [your editor](./editors.md), or browse the [CLI reference](/docs/cli).
