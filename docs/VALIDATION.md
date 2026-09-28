# Storage validation

The initial validation passed 30 Vitest tests, eight release/workflow tests, the storage proof, package tarball checks, and the Docusaurus build.

The implementation was exercised on macOS with Node 26.3.0, Git 2.55.0, and pnpm 11.1.3. CI also runs the suite on Linux and macOS with Node 22 and 26.

## Reproduce the independent storage proof

```sh
pnpm install --frozen-lockfile
pnpm test:proof
```

The script creates two disposable repositories and serves them over a Git daemon bound to loopback. This exercises the remote-clone path while keeping all repository data local. It uses isolated Git configuration and a temporary consolidated store.

The proof checks:

1. Three concurrent clones complete, including two consumers of the same remote.
2. The two consumers' base packs have identical device and inode IDs, with at least three hard links (mirror plus both consumers).
3. Origin URLs and commit IDs match the remotes. Consumers have no alternates file.
4. Running Git garbage collection in the consumers preserves the shared base pack.
5. Deleting the store leaves every consumer passing `git fsck --full`, retaining its full history and a clean working tree.
6. Another clone reconstructs the missing store and passes `git fsck --full`.

A successful run prints `"result": "PASS"`, two mirrors, three consumers, and the shared pack's link count. Inode numbers and byte counts vary between runs. Fixtures and the daemon are cleaned up afterward.

## Submodule and adoption regressions

The Vitest integration tests additionally cover automatic initialization after `gitx worktree add`, nested and relative submodules, hard-linked packs in a worktree's private submodule gitdir, and `--no-checkout` behavior. After store deletion, the worktree, superproject, and submodule all pass `git fsck --full`.

Adoption tests check shared pack inodes, preservation of commits unique to the consumer, recursion through named submodule directories, and common object storage when adopting a linked worktree. Maintenance tests refresh and expire mirrors, then verify existing consumers. Local LFS objects copied during adoption remain in the original repository after clearing the store.

## Optional storage reports

`gitx --stats clone` and `gitx cache --stats` use file sizes and hard-link identities for `.pack`, `.idx`, and `.rev` files. Regression tests check mirror reuse, estimated duplicate packed bytes avoided, and the reduction in consumer-private packed bytes after adoption. Default invocations do not request these measurements. These are logical byte estimates, not filesystem-wide measurements of reclaimed space; loose objects and LFS are excluded.

## Other gates

`pnpm check` validates formatting, lint, TypeScript, runtime tests, release policy, npm tarball contents, and the Docusaurus production build. CLI tests use `vitest-command-line` and exercise Git argument forwarding, nonzero status, explicit `gitx` invocation, disabled mode, nested command discovery, and clidoc export. npm publishing is configured but is not performed by these checks.

Browser interaction was unavailable in the initial development session; the website was verified through its production build and source checks. Cross-filesystem physical savings, SSH host aliases, and every possible Git option combination are not claimed by the local proof. Unsupported invocations pass through to Git.
