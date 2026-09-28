---
title: How it works
---

## The object flow

```text
remote URL
    ↓
<store>/mirrors/<remote-key>.git   bare mirror
    ↓
working-copy/.git/objects          ordinary Git repository
```

gitx gives equivalent SSH and HTTPS forms of a remote a normalized key where it can do so safely. It serializes store mutations, including updates for different remotes, so clearing the store cannot race a clone or refresh. It stages a new mirror before publishing it and refreshes an existing mirror before a supported clone. Then it makes a local Git clone from the mirror and restores `origin` to the remote URL.

Git's local clone mechanism can hard-link object files when the store and destination share a filesystem. If hard links are unavailable, Git can copy objects instead. These copies work independently of the store. gitx avoids Git's `objects/info/alternates` mechanism, which would leave a clone dependent on another object directory.

## Why a mirror?

The first clone populates the local mirror. Later clones of the same remote can reuse its objects instead of starting with an empty local store. Normal fetches and pulls remain Git operations; speeding those up is outside the initial scope.

The mirror is a cache. A clone's object directory remains usable after the mirror is removed, provided the clone has the objects needed by its refs. See the [safety guide](./safety.md) for the Git LFS distinction.

The optional [`--stats` report](./cli.md#optional-storage-report) scans local `.pack`, `.idx`, and `.rev` files and their filesystem metadata after a supported clone or cache adoption. It estimates shared logical bytes from matching device and inode IDs and the change in consumer-private packed file bytes during adoption. It excludes loose objects and Git LFS, and does not traverse Git objects or measure allocated disk blocks. Copy and reflink modes can have different physical savings from this estimate.

The store contains a `.gitx-store` marker. Commands that initialize the store, including `doctor`, can create this marker, but do not edit global Git configuration. `store clear` requires the marker and refuses to delete a store root containing unrelated entries.

## Fallback behavior

Git has many clone modes. gitx passes unsupported or ambiguous forms to real Git so Git keeps its usual semantics. This includes local source paths, shallow or partial clones, bare or mirror clones, explicit reference options, and unsupported object formats. The current implementation's exact routing is defined by the CLI and covered by command-line tests.

The current CLI also offers `cache`, `store`, and `doctor`. `cache` links or copies mirror pack files into an existing repository and repacks local objects. `store` inspects or maintains mirrors.

For supported `submodule update` commands, gitx reads `.gitmodules`, resolves supported relative URLs against the superproject origin, and prepares missing submodule Git directories from mirrors. It then runs real Git to finish the update and checkout. `--recursive` repeats this in nested submodules. This also works when invoked within a linked worktree. `clone --recurse-submodules` invokes the recursive flow after cloning the superproject. For `submodule add`, Git adds the submodule and gitx then caches it. Unsupported submodule options use Git's normal behavior. `worktree add` first uses Git's shared common object database, then initializes supported submodules through gitx's mirror flow. `--no-checkout` skips that initialization.
