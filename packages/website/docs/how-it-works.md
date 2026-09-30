# How gitx works

gitx maintains one bare SHA-1 Git repository at `<store>/pool.git`. It fetches branches and tags from each registered remote into separate `refs/gitx/remotes/…` namespaces. Git's content hashes deduplicate identical objects across repeated checkouts, forks, and unrelated repositories automatically.

Supported `gitx clone` commands fetch into the pool, then run native `git clone --reference <pool>` using the real remote as `origin`. The checkout's `objects/info/alternates` file points to the pool. Later clones borrow its existing objects. The pool can be on another filesystem.

`gitx cache` imports an existing checkout's refs and HEAD into immutable pool refs, fetches its origin, installs the alternate, and repacks the checkout to remove private copies of objects already in the pool. Local branches and commits remain available. Linked worktrees use their shared common object directory. The same process visits discoverable submodules.

Pool refs pin consumer history so `gitx store fetch` and `gitx store gc` do not discard commits still needed after a remote force push. `store gc` compacts without pruning unreachable objects. These retained snapshots can make the pool grow over time.

Supported `submodule update --init` commands prepare missing submodule Git directories with the same pool as reference. Recursive updates cover nested modules, including in new worktrees. Other Git commands and unsupported clone forms pass through to native Git, including local source paths, shallow or partial clones, explicit reference options, and SHA-256 repositories.

The checkout depends on the pool. See the [storage guide](safety.md) before moving or deleting it.
