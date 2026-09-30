# @bhouston/gitx-core

[![npm version](https://img.shields.io/npm/v/@bhouston/gitx-core.svg)](https://www.npmjs.com/package/@bhouston/gitx-core)
[![npm downloads](https://img.shields.io/npm/dm/@bhouston/gitx-core.svg)](https://www.npmjs.com/package/@bhouston/gitx-core)
[![CI](https://github.com/bhouston/gitx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/gitx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/gitx/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-gitx-blue)](https://gitx.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

_The TypeScript storage engine behind [gitx](https://www.npmjs.com/package/@bhouston/gitx)._

Build Node.js tools that share one Git object pool across checkouts. The core owns cloning, submodule and worktree integration, repository consolidation, and store maintenance. It invokes native Git; the CLI handles command parsing and presentation.

Optimized for short-lived repositories in agentic workflows. **Automatically** reuse Git objects across repeated checkouts and worktrees with submodules. The pool holds objects from different remotes, including forks and unrelated repositories. Checkouts borrow from it through Git alternates.

In one typical local setup spanning 117 checkouts (94 distinct Git object databases, with linked worktrees counted once), gitx uses 11.1 GB for Git objects versus an estimated 35.5 GB without sharing, saving about 24.4 GB (69%).

**[Documentation](https://gitx.ben3d.ca/) · [Source](https://github.com/bhouston/gitx) · [CLI package](https://www.npmjs.com/package/@bhouston/gitx)**

## Installation

Requires **Node.js 22+ and Git** on macOS or Linux. The package is ESM and includes TypeScript declarations.

```sh
npm install @bhouston/gitx-core
```

## Quick start

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({ cwd: process.cwd() });
const exitCode = await gitx.run(['clone', 'https://github.com/bhouston/gitx.git', 'gitx-checkout']);
process.exitCode = exitCode;
```

`run()` accepts Git arguments and returns an exit code. It optimizes supported remote clones, `submodule update --init`, and `worktree add` with submodules. Recursive updates handle nested submodules. `submodule add` adopts the module after Git creates it. Other commands and unsupported clone forms, including local paths, shallow or partial clones, and SHA-256 repositories, pass through to Git.

## API

### `createGitx(options?)`

| Option            | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `cwd`             | Working directory; defaults to `process.cwd()`           |
| `env`             | Environment overrides for Git operations                 |
| `gitPath`         | Explicit Git executable                                  |
| `onStorageReport` | Opt-in callback for clone and cache storage measurements |

The returned methods are asynchronous:

| Method         | Result and behavior                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `run(args)`    | Git exit code; optimizes supported operations                                                   |
| `cache(path?)` | `{ cached, skipped }`; adopts a repository and discoverable submodules, including local commits |
| `storePath()`  | Resolved store path                                                                             |
| `storeInfo()`  | `{ path, sizeBytes, remoteCount }`                                                              |
| `fetch()`      | `{ fetched }`; fetches registered remotes into the pool                                         |
| `gc()`         | `{ compacted }`; compacts the pool without pruning objects                                      |
| `doctor()`     | `{ checks }`; each check has `name`, `ok`, and `detail`                                         |
| `gitVersion()` | Underlying Git version line, such as `git version 2.50.1`                                       |

### Consolidate an existing repository

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({ cwd: process.cwd() });
const { cached, skipped } = await gitx.cache('./gitx-checkout');
console.log({ cached, skipped });
console.log(await gitx.storeInfo());
```

Cache adoption imports local refs and HEAD into the pool before repacking the checkout.

### Observe storage sharing

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({
  cwd: process.cwd(),
  onStorageReport(report) {
    console.log({
      operation: report.operation,
      repository: report.repository,
      poolReused: report.poolReused,
      estimatedSavedBytes: report.estimatedSavedBytes,
    });
  },
});

await gitx.cache('./gitx-checkout');
```

The callback enables metadata scans after optimized clones and cache adoption. Without it, these scans are skipped. `StorageReport` also includes optional `beforeUniqueBytes` and `afterUniqueBytes` for cache adoption. The package exports `GitxOptions`, `StorageReport`, `StoreInfo`, `CacheResult`, `DoctorCheck`, and `DoctorResult` types.

Cache estimates count the reduction in private pack bytes. Counts cover `.pack`, `.idx`, and `.rev` files, excluding loose objects. They measure logical file sizes, not physical disk blocks reclaimed. Clone reports do not estimate savings.

## Configuration

The store defaults to `~/.cache/gitx`; `GITX_STORE` overrides its location. Changing the variable does not move existing data. Git configuration supports `gitx.gitPath`. The pool can be on a different filesystem from the checkout. gitx does not change global Git configuration.

## Store dependency

Cached checkouts depend on the object pool through Git alternates. Deleting or moving the store can make their history unreadable.

Read the [storage model](https://gitx.ben3d.ca/docs/how-it-works) and [store dependency guide](https://gitx.ben3d.ca/docs/safety) for details.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/gitx/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gitx/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gitx/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
