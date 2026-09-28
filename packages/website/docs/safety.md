---
title: Safety and limitations
---

gitx is intended to leave ordinary, self-contained Git repositories. A clone made through the mirror has its own object directory and uses the real remote as `origin`. It does not use Git alternates, so the repository remains readable by ordinary Git even if gitx is uninstalled.

Hard links share disk blocks while both links exist. Deleting the mirror removes its links, not the clone's links. Repacking the mirror does not rewrite a clone's existing object files. A clone may take more space after a later repack or fetch, so storage savings depend on the repository and workflow.

To remove the store, delete its directory when no gitx operations are running. Its default location is `~/.cache/gitx`, or the path set by `GITX_STORE`.

Git LFS objects have a separate storage model. `gitx cache` copies existing local LFS objects into the store while retaining the originals. gitx does not change `lfs.storage`. If you configure Git LFS to store objects only in the gitx store, deleting it may require downloading those objects again.

The initial target is POSIX systems with Node.js 22 or newer. Windows, shallow clones, partial clones, and fetch or pull acceleration are outside the current scope. An unsupported clone form falls back to Git rather than attempting to reinterpret it.

When in doubt, inspect a clone before removing a store:

```sh
git remote -v
git fsck --full
git count-objects -v
```
