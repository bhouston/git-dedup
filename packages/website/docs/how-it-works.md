---
title: How it works
---

For the design tradeoffs against depot_tools and manual Git caching, see [Why gitx?](./why-gitx.md).

## The object flow

```text
remote URL
    ↓
<store>/mirrors/<remote-key>.git   bare mirror
    ↓
working-copy/.git/objects          ordinary Git repository
```

gitx gives equivalent SSH and HTTPS forms of a remote a normalized key where it can do so safely. It serializes store mutations, including updates for different remotes. It stages a new mirror before publishing it and refreshes an existing mirror before a supported clone. Then it makes a local Git clone from the mirror and restores `origin` to the remote URL.

Git's local clone mechanism can hard-link object files when the store and destination share a filesystem. If hard links are unavailable, Git can copy objects instead.

## Why a mirror?

The first clone populates the local mirror. Later clones of the same remote can reuse its objects instead of starting with an empty local store. Normal fetches and pulls remain Git operations; speeding those up is outside the initial scope.

See [Safety](./safety.md) for storage guarantees and cleanup guidance.

The optional [`--stats` report](/docs/cli) scans local `.pack`, `.idx`, and `.rev` files and their filesystem metadata after a supported clone or cache adoption. It estimates shared logical bytes from matching device and inode IDs and the change in consumer-private packed file bytes during adoption. It excludes loose objects and Git LFS, and does not traverse Git objects or measure allocated disk blocks. Copy and reflink modes can have different physical savings from this estimate.

The store defaults to `~/.cache/gitx`. Set `GITX_STORE` to use another location. gitx does not change global Git configuration.

## Fallback behavior

Git has many clone modes. gitx passes unsupported or ambiguous forms to real Git so Git keeps its usual semantics. This includes local source paths, shallow or partial clones, bare or mirror clones, explicit reference options, and unsupported object formats. The current implementation's exact routing is defined by the CLI and covered by command-line tests.

The current CLI also offers `cache`, `store`, and `doctor`. `cache` links or copies mirror pack files into an existing repository and repacks local objects. `store` inspects or maintains mirrors.

For supported `submodule update` commands, gitx reads `.gitmodules`, resolves supported relative URLs against the superproject origin, and prepares missing submodule Git directories from mirrors. It then runs real Git to finish the update and checkout. `--recursive` repeats this in nested submodules. This also works when invoked within a linked worktree. `clone --recurse-submodules` invokes the recursive flow after cloning the superproject. For `submodule add`, Git adds the submodule and gitx then caches it. Unsupported submodule options use Git's normal behavior. `worktree add` first uses Git's shared common object database, then initializes supported submodules through gitx's mirror flow. `--no-checkout` skips that initialization.
