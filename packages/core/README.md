# @bhouston/gitx-core

The Git operations behind `gitx`. This package exposes `createGitx()` for the CLI and other Node programs. It uses a local mirror for supported remote clones, then links packs into independent repositories. Each consumer keeps its own objects and remains readable after the mirror store is deleted.

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({ cwd: process.cwd() });
const exitCode = await gitx.run(['clone', 'https://github.com/example/project.git']);
```

`run()` returns Git's exit code. It accelerates ordinary remote `clone`, `submodule update --init`, and `worktree add` with submodules. Nested submodules are supported. `submodule add` adopts the new module after Git creates it. Unrecognized Git commands and unsupported clone options pass through to Git. Shallow or partial clones, local path URLs, and SHA-256 repositories also pass through.

The API includes `cache(path?)`, `storeInfo()`, `refresh()`, `gc(unused?)`, `clear()`, `setStore(path)`, and `doctor()`. `cache` adopts an existing repository, including its submodules and local commits. The cache operation is repeatable. The CLI package formats these results for users.

Pass `onStorageReport(report)` to `createGitx()` for opt-in measurements after accelerated clones and cache adoption. A report includes the repository, whether its mirror existed, shared and copied pack bytes, and an estimated saving. Clone savings equal the logical size of pack files hard-linked to the mirror. Cache savings estimate the reduction in consumer-private pack bytes before and after adoption. These counts cover `.pack`, `.idx`, and `.rev` files, not loose objects or LFS, and do not claim actual physical disk space reclaimed. Reflinks can save physical space while appearing as copied bytes in this report.

Git config controls behavior: `gitx.store`, `gitx.enabled`, `gitx.gitPath`, and `gitx.linkMode` (`auto`, `hardlink`, `reflink`, or `copy`). `GITX_STORE` overrides the store path, and `GITX_DISABLE=1` bypasses acceleration for one command. `setStore()` also configures global `lfs.storage` at the chosen store. `cache()` copies existing local LFS objects into that store while retaining the originals.

Mirrors and consumers are protected by store locks during clone and maintenance. Consumers never use Git alternates. Clearing the store leaves Git objects in consumers intact; LFS objects kept only in global storage must be fetched again from their LFS remote.
