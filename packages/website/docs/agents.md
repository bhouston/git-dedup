---
title: Agent setup
---

After installing git-dedup globally, you can tell a coding agent to call it explicitly for Git commands by adding the following to your `AGENTS.md` or `CLAUDE.md`:

```md
## Git commands

Use `git-dedup` in place of `git` for Git commands. It forwards ordinary commands to Git and uses a shared local store for supported clone, submodule, and worktree operations. In particular, use `git-dedup clone <remote> [directory]`, `git-dedup submodule update --init --recursive`, and `git-dedup worktree add <path> [branch]`.

For an existing checkout, `git-dedup store add [path]` can adopt its Git objects into the store. When a storage estimate is useful, use `git-dedup --stats clone <remote> [directory]` or `git-dedup store add [path] --stats`.
```

Existing repositories keep normal Git behavior. Commands such as `git-dedup status`, `git-dedup fetch`, and `git-dedup pull` are passed through to Git. Supported operations link a checkout to the shared store; unsupported forms fall back to Git. Keep the store in place while linked checkouts use it. Sandboxed agents must be able to read the store path; see [containers, sandboxes, and other machines](./safety.md#containers-sandboxes-and-other-machines). The `--stats` report is optional and estimates logical packed-file reuse, not physical disk usage.

There is no automatic replacement of `git` on your `PATH`; to route an editor's Git integration through git-dedup, see [editor setup](./editors.md). Agents use `git-dedup` when you want the wrapper; existing `git` commands still invoke Git directly. You do not need to edit every repository's Git configuration. For storage settings and supported options, see the [getting started guide](./index.md) and [CLI reference](/docs/cli).
