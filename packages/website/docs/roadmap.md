---
title: Roadmap
---

The [original overlay design](https://github.com/bhouston/gix/blob/main/docs/DESIGN.md) describes the intended Git wrapper. The [implementation plan](https://github.com/bhouston/gix/blob/main/docs/PLAN.md) records current behavior and refinements. The implementation is staged so each step can be tested with local repositories before expanding command interception.

1. **Foundation and clone flow — implemented.** A POSIX Node.js CLI, a configurable local store, remote normalization, mirror creation and refresh, per-mirror locking, clone fallback, and ordinary Git passthrough.
2. **Existing repository and store commands — implemented.** `cache` seeds or refreshes a mirror and relinks eligible packs. `store` reports usage, refreshes, removes unused mirrors, or clears the store. `doctor` reports setup checks. These flows need continued testing on varied Git versions and filesystems.
3. **Submodule and worktree flow — implemented.** Supported updates prepare missing submodule Git directories from mirrors before running Git, including recursive updates and `clone --recurse-submodules`. `submodule add` runs Git and then caches the added module. `worktree add` uses Git's shared common object database and initializes supported submodules from mirrors, except for `--no-checkout`.
4. **Further validation — ongoing.** Exercise additional submodule option combinations and Git versions, plus explicit link modes on different filesystems.
5. **Later work.** Evaluate fetch acceleration, partial clones, Windows, and LFS working file optimizations.

The current commands are useful on their own. The planned stages are design targets, not promises that every Git invocation is already optimized.
