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

git-dedup is written in Go. Install the Go version in `go.mod` (for example `winget install GoLang.Go`, `brew install go`, or `sudo apt install golang`), plus the Node version in `.nvmrc` and the pnpm version in `package.json` for the test suites, the npm package, and the website.

```sh
pnpm install --frozen-lockfile
pnpm build            # the binary for this machine, into packages/cli/native/
pnpm typecheck        # go vet
pnpm lint
pnpm format:check
go test ./...
pnpm test             # behavior suites in test/ against the binary
pnpm test:proof
pnpm package:check    # every target, packed into the npm package
pnpm docs:build
pnpm test:workflow
```

`pnpm test:coverage` runs the behavior suites against a coverage-instrumented binary and writes `coverage/native.out`. To build every release archive and package locally without publishing, install [GoReleaser](https://goreleaser.com/install/) and run `pnpm go:release:snapshot`.

The pre-commit hook formats and lints staged files and runs `go vet`. CI runs the checks on Linux (x64 and arm64), macOS, and Windows. Tests use temporary repositories and isolated Git configuration. Tests that inject failures through a shell-script Git wrapper run only on Linux and macOS, because Windows starts only `.exe` files without a shell. Keep storage logic in `internal/core`, command-line presentation in `internal/cli`, the npm launcher in `packages/cli`, and site content in `packages/website`. [docs/native-port.md](docs/native-port.md) describes the on-disk store format, which must stay compatible. Preserve native Git argument semantics by forwarding unsupported invocations. Linked consumers depend on the shared object pool. Never delete unrelated directories.

## Releases

Merging to `main` never publishes. A maintainer dispatches the release workflow when accumulated changes should ship:

```sh
gh workflow run release.yml --ref main
gh workflow run release.yml --ref main -f dry_run=true
```

The workflow requires `main`, reruns CI on the selected commit, and uses semantic-release to select the version from Conventional Commits. It builds the native binaries with that version, publishes `git-dedup` through npm trusted publishing, and attaches archives and Linux packages to the GitHub Release. The website is private. See [RELEASING.md](RELEASING.md) for one-time activation and recovery.

## Security

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/bhouston/git-dedup/security/advisories/new), as described in [SECURITY.md](SECURITY.md). Do not disclose exploit details in a public issue.
