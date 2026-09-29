---
title: Editor setup
---

VS Code and editors built on it, such as Cursor and Windsurf, run every Git operation through the executable named by the `git.path` setting. Point it at gitx and the editor's clone and worktree commands use the shared store.

1. Find the absolute path to gitx:

   ```sh
   command -v gitx
   ```

2. Open your **user** settings JSON (Command Palette → **Preferences: Open User Settings (JSON)**). `git.path` is a machine setting, so workspace settings ignore it. Add:

   ```json
   {
     "git.path": "/absolute/path/to/gitx"
   }
   ```

3. Run **Developer: Reload Window**. The **Git** output channel should log a line such as `Using git "2.50.1 (gitx 0.1.0)"`.

With this setting, these editor actions go through gitx:

- **Git: Clone**, including recursive clones of repositories with submodules.
- **Git: Create Worktree** and agent sessions that create worktrees through the editor's Git integration. gitx also initializes the new worktree's submodules from the store, which the editor does not do on its own.
- Submodule updates started from the editor.

Every other Git command is forwarded unchanged. gitx adds some Node.js startup time to each command, but it skips its own command parser when forwarding.

The integrated terminal and command-line agents still call `git` from your `PATH`. Use `gitx` there directly, or follow the [agent setup guide](./agents.md).

If you install Node.js through a version manager such as nvm, the gitx path changes when you switch Node versions. Update `git.path` after switching. Remove the setting to go back to plain Git.

Visual Studio (the Windows IDE) is not supported, because gitx runs only on macOS and Linux.
