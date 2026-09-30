---
title: Editor setup
---

VS Code and editors built on it, such as Cursor and Windsurf, run every Git operation through the executable named by the `git.path` setting. Point it at git-dedup and the editor's clone and worktree commands use the shared store.

1. Find the absolute path to git-dedup:

   ```sh
   command -v git-dedup
   ```

2. Open your **user** settings JSON (Command Palette → **Preferences: Open User Settings (JSON)**). `git.path` is a machine setting, so workspace settings ignore it. Add:

   ```json
   {
     "git.path": "/absolute/path/to/git-dedup"
   }
   ```

3. Run **Developer: Reload Window**. The **Git** output channel should log a line such as `Using git "2.50.1 (git-dedup 0.1.0)"`.

With this setting, these editor actions go through git-dedup:

- **Git: Clone**, including recursive clones of repositories with submodules.
- **Git: Create Worktree** and agent sessions that create worktrees through the editor's Git integration. git-dedup also initializes the new worktree's submodules from the store, which the editor does not do on its own.
- Submodule updates started from the editor.

Every other Git command is forwarded unchanged. git-dedup adds some Node.js startup time to each command, but it skips its own command parser when forwarding.

The integrated terminal and command-line agents still call `git` from your `PATH`. Use `git-dedup` there directly, or follow the [agent setup guide](./agents.md).

If you install Node.js through a version manager such as nvm, the git-dedup path changes when you switch Node versions. Update `git.path` after switching. Remove the setting to go back to plain Git.

Dev containers and remote workspaces need the store mounted at the same path; see [containers, sandboxes, and other machines](./safety.md#containers-sandboxes-and-other-machines).

Visual Studio (the Windows IDE) is not supported, because git-dedup runs only on macOS and Linux.
