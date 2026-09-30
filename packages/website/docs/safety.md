# Storage dependency

Cached repositories use Git alternates. Their `objects/info/alternates` file points at `<store>/pool.git/objects`. Git reads missing objects from that pool. Deleting or moving the store can make branches, commits, and working trees unreadable. Keep the store available for as long as any cached checkout uses it.

To make a checkout independent, run `git repack -a -d` in it, then remove its `objects/info/alternates` file. Run `git fsck --full` afterward. For a repository with submodules, repeat this for each submodule Git directory. A linked worktree shares its main repository's object directory.

`gitx store fetch` updates remote refs in separate namespaces. gitx also pins consumer refs in the pool, so a later force push or branch deletion does not remove objects needed by an existing checkout. `gitx store gc` compacts the pool without pruning unreachable objects.

The store defaults to `~/.cache/gitx`; set `GITX_STORE` to choose another location before caching or cloning. Changing this variable later does not rewrite existing alternate paths.
