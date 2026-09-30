# git-dedup-core

[![npm version](https://img.shields.io/npm/v/git-dedup-core.svg)](https://www.npmjs.com/package/git-dedup-core)
[![npm downloads](https://img.shields.io/npm/dm/git-dedup-core.svg)](https://www.npmjs.com/package/git-dedup-core)
[![CI](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/git-dedup/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/bhouston/git-dedup/branch/main/graph/badge.svg)](https://codecov.io/gh/bhouston/git-dedup)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/git-dedup/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-git--dedup-blue)](https://git-dedup.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

**Many coding agents, one copy of Git history.** _The TypeScript storage engine behind [git-dedup](https://www.npmjs.com/package/git-dedup)._

Build agent runners, editors, and other Node.js tools that create many checkouts without storing the same Git history many times. Clones, forks, and worktree submodules share one local object pool and borrow from it through Git alternates. The pool holds objects from different remotes, including forks and unrelated repositories.

The core owns cloning, submodule and worktree integration, repository consolidation, and store maintenance. It invokes native Git; the CLI handles command parsing and presentation.

In one typical local setup spanning 117 checkouts (94 distinct Git object databases, with linked worktrees counted once), git-dedup uses 11.1 GB for Git objects versus 35.5 GB without sharing, saving about 24.4 GB (70%). Checkout is also 6x faster for large repos, dropping from over 1 minute to 10 seconds.

**[Documentation](https://git-dedup.ben3d.ca/) · [Source](https://github.com/bhouston/git-dedup) · [CLI package](https://www.npmjs.com/package/git-dedup)**

## Installation

Requires **Node.js 22+ and Git** on macOS or Linux. The package is ESM and includes TypeScript declarations.

```sh
npm install git-dedup-core
```

## Quick start

```ts
import { createGitDedup } from 'git-dedup-core';

const dedup = createGitDedup({ cwd: process.cwd() });
const exitCode = await dedup.run(['clone', 'https://github.com/bhouston/git-dedup.git', 'git-dedup-checkout']);
process.exitCode = exitCode;
```

`run()` accepts Git arguments and returns an exit code. It optimizes supported remote clones, `submodule update --init`, and `worktree add` with submodules. Recursive updates handle nested submodules. `submodule add` adopts the module after Git creates it. Other commands and unsupported clone forms, including local paths, shallow or partial clones, and SHA-256 repositories, pass through to Git.

## API

### `createGitDedup(options?)`

| Option            | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `cwd`             | Working directory; defaults to `process.cwd()`                       |
| `env`             | Environment overrides for Git operations                             |
| `gitPath`         | Explicit Git executable                                              |
| `onStorageReport` | Opt-in callback for clone and checkout adoption storage measurements |

The returned methods are asynchronous:

| Method         | Result and behavior                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(args)`    | Git exit code; optimizes supported operations                                                                                                                                                        |
| `add(path?)`   | `{ added, skipped, failed, repositories }`; adopts a repository and discoverable submodules, including local commits. Each repository reports its path, status, and any reason or full error detail. |
| `storePath()`  | Resolved store path                                                                                                                                                                                  |
| `storeInfo()`  | `{ path, sizeBytes, remoteCount }`                                                                                                                                                                   |
| `fetch()`      | `{ fetched }`; fetches registered remotes into the pool                                                                                                                                              |
| `gc()`         | `{ compacted }`; compacts the pool without pruning objects                                                                                                                                           |
| `doctor()`     | `{ checks }`; each check has `name`, `ok`, and `detail`                                                                                                                                              |
| `gitVersion()` | Underlying Git version line, such as `git version 2.50.1`                                                                                                                                            |
| `gitPath()`    | Path of the underlying Git executable, honoring the `gitPath` option and `git-dedup.gitPath`                                                                                                         |

### Consolidate an existing repository

```ts
import { createGitDedup } from 'git-dedup-core';

const dedup = createGitDedup({ cwd: process.cwd() });
const { added, skipped, failed, repositories } = await dedup.add('./git-dedup-checkout');
console.log({ added, skipped, failed, repositories });
console.log(await dedup.storeInfo());
```

Checkout adoption imports local refs and HEAD into the pool before repacking the checkout.

### Observe storage sharing

```ts
import { createGitDedup } from 'git-dedup-core';

const dedup = createGitDedup({
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

await dedup.add('./git-dedup-checkout');
```

The callback enables metadata scans after optimized clones and checkout adoption. Without it, these scans are skipped. `StorageReport` also includes optional `beforeUniqueBytes` and `afterUniqueBytes` for checkout adoption. The package exports `GitDedupOptions`, `StorageReport`, `StoreInfo`, `StoreAddResult`, `DoctorCheck`, and `DoctorResult` types. See [storage reports](https://git-dedup.ben3d.ca/docs/how-it-works#storage-reports) for what the estimates measure.

## Configuration

The store defaults to `~/.git-dedup`; `GIT_DEDUP_STORE` overrides its location. Changing the variable does not move existing data. Git configuration supports `git-dedup.gitPath`. The pool can be on a different filesystem from the checkout. git-dedup does not change global Git configuration.

## Store dependency

Linked checkouts depend on the object pool through Git alternates. Deleting or moving the store can make their history unreadable.

Read the [storage model](https://git-dedup.ben3d.ca/docs/how-it-works) and [store dependency guide](https://git-dedup.ben3d.ca/docs/safety) for details.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/git-dedup/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/git-dedup/releases) for release notes.

## License

[MIT](https://github.com/bhouston/git-dedup/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
