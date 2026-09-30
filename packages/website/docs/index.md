---
id: index
title: Get started
slug: /
---

Install gitx with npm:

```sh
npm install -g @bhouston/gitx
```

Requires Node.js 22+ and Git on macOS or Linux.

## Clone a repository

```sh
# Automatically create or reuse the object pool in ~/.cache/gitx.
gitx clone https://github.com/you/project.git project

# Borrow from the pool for another checkout.
gitx clone https://github.com/you/project.git project-review
cd project-review

# Work with Git as usual.
git status
git diff
git log --oneline
```

## Submodules and worktrees

```sh
gitx submodule update --init --recursive
gitx worktree add -b review ../review
```

## Existing repositories

```sh
# Add the current repository to the store.
gitx cache .

# Preview every checkout below a directory before caching them.
gitx cache ~/Coding --all --dry-run
gitx cache ~/Coding --all

# View the store.
gitx store
gitx store list
```

See the [CLI reference](/docs/cli) for commands or [agent setup](./agents.md) for coding agents.
