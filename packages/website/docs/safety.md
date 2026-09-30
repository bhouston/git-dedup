# Storage dependency

Linked repositories use Git alternates. Their `objects/info/alternates` file points at `<store>/pool.git/objects`. Git reads missing objects from that pool. Deleting or moving the store can make branches, commits, and working trees unreadable. git-dedup is not a disposable cache.

The store is part of the object database for every linked checkout. Keep it at the same path while those checkouts are in use. A linked worktree shares its main repository's object directory; submodules have their own object directories and alternate files.

`git-dedup store fetch` updates remote refs in separate namespaces. git-dedup records consumer refs in the pool. `git-dedup store gc` compacts the pool without pruning unreachable objects.

`git-dedup store list` shows each registered remote's canonical key and saved fetch URL. It reads local store metadata without contacting remotes. The object pool is shared across remotes, so the list does not assign a disk size to each remote.

git-dedup never saves credentials embedded in a remote URL, such as `https://user:token@host/...`. It strips them before registering the remote, and `store list` shows any older saved credentials as `***`. Fetches from such remotes authenticate through a [Git credential helper](https://git-scm.com/docs/gitcredentials).

`git-dedup store` reports the path, remote count, size, and health of the pool and Git executable. It reads the store without creating or changing it. A missing or invalid pool is reported as a warning and gives a nonzero exit code.

The store defaults to `~/.git-dedup`; set `GIT_DEDUP_STORE` to choose another location before adding a checkout or cloning. Changing this variable later does not rewrite existing alternate paths.

## Containers, sandboxes, and other machines

The alternates path is absolute. A linked checkout breaks wherever that path is missing or unreadable:

- A dev container or Docker bind mount that includes the checkout but not the store.
- A sandboxed coding agent or remote environment that can read the project but not the store.
- A copy of the checkout on another machine, made with `rsync`, an archive, or a synced folder.

Git then reports missing objects. Mount the store at the same absolute path, or grant read access to it. To move or copy a checkout elsewhere, first detach it with `git-dedup store remove <path>`, which copies the objects it needs back into the checkout.

## Stop using git-dedup

`git-dedup store remove <path>` is the way to stop using git-dedup for a checkout. Under the store lock, it copies every object the checkout needs from the pool into the checkout's own object directory. It then removes the pool line from `objects/info/alternates` and keeps any other alternates. It verifies the result with `git fsck --connectivity-only` and restores the alternate if verification fails. It then deletes the checkout's git-dedup metadata and its consumer refs in the pool.

Linked worktrees share the main repository's object directory, so removing one worktree detaches all of them. Initialized submodules are detached too. A checkout that is not linked is left unchanged, and the command exits successfully. The output reports the bytes each detached object directory now uses. After you remove every linked checkout, you can delete the store.
