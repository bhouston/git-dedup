---
id: index
title: Get started
slug: /
---

Install git-dedup with npm:

```sh
npm install -g git-dedup
```

Requires Node.js 22+ and Git on macOS or Linux.

If you used the previous `gitx` CLI, update scripts and editor settings to call `git-dedup`. Existing stores and linked checkouts continue to work; git-dedup finds an existing store automatically.

## Clone a repository

```sh
# Automatically create or reuse the object pool in ~/.git-dedup.
git-dedup clone https://github.com/you/project.git project

# Borrow from the pool for another checkout.
git-dedup clone https://github.com/you/project.git project-review
cd project-review

# Work with Git as usual.
git status
git diff
git log --oneline
```

## Submodules and worktrees

```sh
git-dedup submodule update --init --recursive
git-dedup worktree add -b review ../review
```

## Existing repositories

```sh
# Add the current repository to the store.
git-dedup cache .

# Preview every checkout below a directory before adopting them.
git-dedup cache ~/Coding --all --dry-run
git-dedup cache ~/Coding --all

# View the store.
git-dedup store
git-dedup store list
```

See the [CLI reference](/docs/cli) for commands or [agent setup](./agents.md) for coding agents.
