---
title: Safety and limitations
---

gitx is intended to leave ordinary, self-contained Git repositories. A clone made through the mirror has its own object directory and uses the real remote as `origin`. It does not use Git alternates, so the repository remains readable by ordinary Git even if gitx is uninstalled.

Hard links share disk blocks while both links exist. Deleting the mirror removes its links, not the clone's links. Repacking the mirror does not rewrite a clone's existing object files. A clone may take more space after a later repack or fetch, so storage savings depend on the repository and workflow.

Git LFS objects have a separate storage model. `gitx cache` copies existing local LFS objects into the store while retaining the local source. `gitx store set <path>` explicitly sets global `lfs.storage` to `<path>/lfs`. After that, the store may contain the only local copy of later LFS objects. `gitx store clear` deletes that directory along with mirrors, and Git LFS content may need to be downloaded again. Installation and cloning do not silently change global `lfs.storage`.

`store clear` accepts only a directory with gitx's store marker and expected entries. Store mutations hold a lock alongside the store, so a clear waits for active mirror work. This also serializes clones of different remotes in the current implementation; the tradeoff favors store safety over parallel throughput.

The initial target is POSIX systems with Node.js 22 or newer. Windows, shallow clones, partial clones, and fetch or pull acceleration are outside the current scope. An unsupported clone form falls back to Git rather than attempting to reinterpret it.

When in doubt, inspect a clone before removing a store:

```sh
git remote -v
git fsck --full
git count-objects -v
```
