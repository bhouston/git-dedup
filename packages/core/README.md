# @bhouston/gitx-core

[![npm version](https://img.shields.io/npm/v/@bhouston/gitx-core.svg)](https://www.npmjs.com/package/@bhouston/gitx-core)
[![npm downloads](https://img.shields.io/npm/dm/@bhouston/gitx-core.svg)](https://www.npmjs.com/package/@bhouston/gitx-core)
[![CI](https://github.com/bhouston/gitx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bhouston/gitx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/bhouston/gitx/blob/main/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-gitx-blue)](https://gitx.ben3d.ca/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5J5Ur3F6Z2)

_The TypeScript storage engine behind [gitx](https://www.npmjs.com/package/@bhouston/gitx)._

Build Node.js tools that reuse local Git mirrors across independent checkouts. The core owns cloning, submodule and worktree integration, repository consolidation, and store maintenance. It builds on native Git and [simple-git](https://github.com/steveukx/git-js); the CLI handles command parsing and presentation.

Optimized for short-lived repositories in agentic workflows. **Automatically** reuse Git objects across repeated checkouts and worktrees with submodules, reducing repeated downloads and duplicate object storage as agents spin up new workspaces. gitx manages mirror creation, updates, and reuse for you, removing the bookkeeping of maintaining mirrors and passing reference paths to each clone.

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
| `storeInfo()`  | `{ path, sizeBytes, mirrorCount }`                                                              |
| `fetch()`      | `{ fetched }`; fetches and repacks mirrors                                                      |
| `gc(unused?)`  | `{ removed }`; removes old mirrors, default `30d`; accepts ages such as `12h` or `60m`          |
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

Cache adoption is repeatable and preserves local commits.

### Observe storage sharing

```ts
import { createGitx } from '@bhouston/gitx-core';

const gitx = createGitx({
  cwd: process.cwd(),
  onStorageReport(report) {
    console.log({
      operation: report.operation,
      repository: report.repository,
      mirrorReused: report.mirrorReused,
      sharedPackBytes: report.sharedPackBytes,
      copiedPackBytes: report.copiedPackBytes,
      estimatedSavedBytes: report.estimatedSavedBytes,
    });
  },
});

await gitx.cache('./gitx-checkout');
```

The callback enables metadata scans after optimized clones and cache adoption. Without it, these scans are skipped. `StorageReport` also includes optional `beforeUniqueBytes` and `afterUniqueBytes` for cache adoption. The package exports `GitxOptions`, `StorageReport`, `StoreInfo`, `CacheResult`, `DoctorCheck`, and `DoctorResult` types.

Clone estimates count duplicate pack bytes avoided; cache estimates count the reduction in private pack bytes. Counts cover `.pack`, `.idx`, and `.rev` files, excluding loose objects. They measure logical file sizes, not physical disk blocks reclaimed. Creating a mirror on first use may yield no net savings yet.

## Configuration

The store defaults to `~/.cache/gitx`; `GITX_STORE` overrides its location. Changing the variable does not move existing data. Git configuration supports `gitx.gitPath`. gitx hardlinks object files when the store and checkout share a filesystem and copies them otherwise. gitx does not change global Git configuration.

## Storage safety

gitx is safe by default. Every checkout keeps its own complete set of Git objects and uses no Git alternates, so deleting the store never breaks a repository. Keep the store on the same filesystem as your checkouts so objects are hardlinked rather than copied.

Read the [storage model](https://gitx.ben3d.ca/docs/how-it-works) and [safety guide](https://gitx.ben3d.ca/docs/safety) for details.

## Contributing

See [CONTRIBUTING.md](https://github.com/bhouston/gitx/blob/main/CONTRIBUTING.md) for the issue, branch, and PR workflow, and [GitHub Releases](https://github.com/bhouston/gitx/releases) for release notes.

## License

[MIT](https://github.com/bhouston/gitx/blob/main/LICENSE)

## Author

[Ben Houston](https://ben3d.ca)
