---
title: Agent setup
---

After installing gitx globally, you can tell a coding agent to call it explicitly for Git commands by adding the following to your `AGENTS.md` or `CLAUDE.md`:

```md
## Git commands

Use `gitx` in place of `git` for Git commands. It forwards ordinary commands to Git and uses a shared local store for supported clone, submodule, and worktree operations. In particular, use `gitx clone <remote> [directory]`, `gitx submodule update --init --recursive`, and `gitx worktree add <path> [branch]`.

For an existing checkout, `gitx cache [path]` can adopt its Git objects into the store. When a storage estimate is useful, use `gitx --stats clone <remote> [directory]` or `gitx cache [path] --stats`.
```

Existing repositories keep normal Git behavior. Commands such as `gitx status`, `gitx fetch`, and `gitx pull` are passed through to Git. Supported operations use the shared store without making a checkout depend on it; unsupported forms fall back to Git. The `--stats` report is optional and estimates logical packed-file reuse, not physical disk usage.

There is no automatic replacement of `git` on your `PATH`; to route an editor's Git integration through gitx, see [editor setup](./editors.md). Agents use `gitx` when you want the wrapper; existing `git` commands still invoke Git directly. You do not need to edit every repository's Git configuration. For storage settings and supported options, see the [getting started guide](./index.md) and [CLI reference](/docs/cli).
