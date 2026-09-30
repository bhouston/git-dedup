---
id: index
title: Get started
slug: /
---

**Many coding agents, one copy of Git history.** git-dedup is a Git wrapper whose clones, forks, and worktree submodules share one local object pool. Agents and editors can create a fresh checkout per task without storing the history again. In one typical setup of 117 checkouts, Git objects take 11.1 GB instead of 35.5 GB (70% less). Checkout is also 6x faster for large repos, dropping from over 1 minute to 10 seconds.

Install git-dedup with npm:

```sh
npm install -g git-dedup
```

Requires Node.js 22+ and Git on macOS or Linux.

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
git-dedup store add .

# Preview every checkout below a directory before adopting them.
git-dedup store add ~/Coding --all --dry-run
git-dedup store add ~/Coding --all

# View the store and its health checks.
git-dedup store
git-dedup store list
```

The `--all` sweep follows each checkout's Git ignore rules. It skips `.git` metadata and symlinks. A directory outside a Git worktree has no repository ignore rules, so all of its directory names are eligible for discovery.

See the [CLI reference](/docs/cli) for commands or [agent setup](./agents.md) for coding agents.
