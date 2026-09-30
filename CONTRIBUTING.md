# Contributing

These rules apply to every contributor, human or AI agent. This is the source of truth for the contribution workflow. `AGENTS.md` and `CLAUDE.md` point here.

## Issue → branch → pull request

1. **Start with an issue.** Describe the problem, motivation, constraints, and testable acceptance criteria. Reuse an existing issue when it covers the work.
2. **Branch from `main`.** Fetch current `origin/main` and name the branch `<type>/<issue>-<short-description>`, such as `feat/42-mirror-refresh`. Use a separate worktree for unrelated local changes.
3. **Commit with Conventional Commits.** Reference the issue in the body where useful.
4. **Run the local checks** below before opening a PR.
5. **Open a PR against `main`.** Use a Conventional Commit title, include `Closes #<issue>` in the body, explain the resulting behavior, and report validation.
6. **Merge on green CI.** Use a merge commit; do not squash or rebase merge. Maintainers choose when to merge.

`main` is the only integration branch. The initial repository bootstrap can land directly on `main`; subsequent tracked changes use PRs.

## Commit format

Use `type(optional-scope): description` in the imperative mood. Allowed types: `feat`, `fix`, `perf`, `docs`, `chore`, `refactor`, `test`, `style`, `build`, `ci`, and `revert`.

- `feat:` produces a minor release.
- `fix:` and `perf:` produce a patch release.
- `!` after the type/scope or a `BREAKING CHANGE:` footer produces a major release.
- Other types do not trigger a release on their own.

After `pnpm install`, Husky runs commitlint on commits. CI checks the PR title and commits; Git-generated merge commits are exempt.

## Local checks

Use the Node version in `.nvmrc` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:proof
pnpm package:check
pnpm docs:build
pnpm test:workflow
```

The pre-commit hook formats and lints staged files and type-checks the workspace. CI runs the checks on Linux and macOS. Tests use temporary repositories and isolated Git configuration. Keep storage logic in `packages/core`, CLI presentation in `packages/cli`, and site content in `packages/website`. Preserve native Git argument semantics by forwarding unsupported invocations. Cached consumers depend on the shared object pool; tests must verify that required objects remain reachable after store maintenance and remote history changes. Never delete unrelated directories.

## Releases

Merging to `main` never publishes. A maintainer dispatches the release workflow when accumulated changes should ship:

```sh
gh workflow run release.yml --ref main
gh workflow run release.yml --ref main -f dry_run=true
```

The workflow requires `main`, reruns CI on the selected commit, and uses semantic-release to select a shared version from Conventional Commits. It publishes `@bhouston/gitx-core` before `@bhouston/gitx` through npm trusted publishing. The website is private. See [RELEASING.md](RELEASING.md) for one-time activation and recovery.

## Security

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/bhouston/gitx/security/advisories/new), as described in [SECURITY.md](SECURITY.md). Do not disclose exploit details in a public issue.
