---
title: Development
---

The repository is a pnpm workspace with a small CLI layer, a core package that owns the Git and storage behavior, and this Docusaurus site.

```text
packages/
  core/       mirror, clone, and storage operations
  cli/        command parsing and process behavior
  website/    documentation and project site
```

Run the checks from the repository root:

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm docs:build
pnpm test:proof
```

The core uses Vitest. CLI command tests use `vitest-command-line` so they exercise the actual executable, process output, and exit codes. The documentation site uses Docusaurus and can be developed locally with `pnpm --filter @bhouston/gitx-website dev`.

`pnpm test:proof` creates temporary remotes served through a loopback Git daemon, makes concurrent clones into a shared store, checks object sharing, clears the store, verifies clone history, and rebuilds a mirror. See [the implementation plan](https://github.com/bhouston/gitx/blob/main/docs/PLAN.md) for milestones and validation.
