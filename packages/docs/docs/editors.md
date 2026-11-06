---
title: Editor setup
---

VS Code and editors built on it, such as Cursor and Windsurf, run every Git operation through the executable named by the `git.path` setting. Point it at git-dedup and the editor's clone and worktree commands use the shared store.

1. Find the absolute path to the git-dedup binary. Point the editor at the native binary itself rather than the npm launcher: it starts faster, and editors on Windows can only run an `.exe`.
   - Installed with npm: the binary is inside the global package. Run `npm root -g` and append `git-dedup/native/<platform>-<arch>/git-dedup`, where the platform is `darwin`, `linux`, or `win32` and the architecture is `x64` or `arm64`. On Windows, the name ends in `.exe`. For example: `/opt/homebrew/lib/node_modules/git-dedup/native/darwin-arm64/git-dedup` or `C:\Users\you\AppData\Roaming\npm\node_modules\git-dedup\native\win32-x64\git-dedup.exe`.
   - Installed from a release archive or package: the `git-dedup` executable you installed, for example `/usr/bin/git-dedup`.

2. Open your **user** settings JSON (Command Palette → **Preferences: Open User Settings (JSON)**). `git.path` is a machine setting, so workspace settings ignore it. Add:

   ```json
   {
     "git.path": "/absolute/path/to/native/git-dedup"
   }
   ```

3. Run **Developer: Reload Window**. The **Git** output channel should log a line such as `Using git "2.50.1 (git-dedup 0.1.0)"`.

With this setting, these editor actions go through git-dedup:

- **Git: Clone**, including recursive clones of repositories with submodules.
- **Git: Create Worktree** and agent sessions that create worktrees through the editor's Git integration. git-dedup also initializes the new worktree's submodules from the store, which the editor does not do on its own.
- Submodule updates started from the editor.

Every other Git command is forwarded unchanged, without parsing its arguments.

The integrated terminal and command-line agents still call `git` from your `PATH`. Use `git-dedup` there directly, or follow the [agent setup guide](./agents.md).

If you install Node.js through a version manager such as nvm, the npm package path changes when you switch Node versions. Update `git.path` after switching. Remove the setting to go back to plain Git.

Dev containers and remote workspaces need the store mounted at the same path; see [containers, sandboxes, and other machines](./safety.md#containers-sandboxes-and-other-machines).

On Windows, use the `git-dedup.exe` path, not the `git-dedup.cmd` or `git-dedup.ps1` launchers that npm adds to your `PATH`: editors start `git.path` directly, without a shell. Visual Studio (the Windows IDE) uses its own bundled Git and is not supported.
