# Storage dependency

Cached repositories use Git alternates. Their `objects/info/alternates` file points at `<store>/pool.git/objects`. Git reads missing objects from that pool. Deleting or moving the store can make branches, commits, and working trees unreadable.

The store is part of the object database for every cached checkout. Keep it at the same path while those checkouts are in use. A linked worktree shares its main repository's object directory; submodules have their own object directories and alternate files.

`gitx store fetch` updates remote refs in separate namespaces. gitx records consumer refs in the pool. `gitx store gc` compacts the pool without pruning unreachable objects.

The store defaults to `~/.cache/gitx`; set `GITX_STORE` to choose another location before caching or cloning. Changing this variable later does not rewrite existing alternate paths.
