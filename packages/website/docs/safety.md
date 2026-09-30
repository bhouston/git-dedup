# Storage dependency

Linked repositories use Git alternates. Their `objects/info/alternates` file points at `<store>/pool.git/objects`. Git reads missing objects from that pool. Deleting or moving the store can make branches, commits, and working trees unreadable. git-dedup is not a disposable cache.

The store is part of the object database for every linked checkout. Keep it at the same path while those checkouts are in use. A linked worktree shares its main repository's object directory; submodules have their own object directories and alternate files.

`git-dedup store fetch` updates remote refs in separate namespaces. git-dedup records consumer refs in the pool. `git-dedup store gc` compacts the pool without pruning unreachable objects.

`git-dedup store list` shows each registered remote's canonical key and saved fetch URL. It reads local store metadata without contacting remotes. The object pool is shared across remotes, so the list does not assign a disk size to each remote.

`git-dedup store` reports the path, remote count, size, and health of the pool and Git executable. It reads the store without creating or changing it. A missing or invalid pool is reported as a warning and gives a nonzero exit code.

The store defaults to `~/.git-dedup`; set `GIT_DEDUP_STORE` to choose another location before adding a checkout or cloning. Changing this variable later does not rewrite existing alternate paths.

When upgrading from gitx, git-dedup automatically reuses an existing store at its old location. You can also set `GIT_DEDUP_STORE` explicitly. Keep the existing directory in place while any checkout points to it.
