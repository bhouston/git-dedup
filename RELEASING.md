# Releasing

Releases are manual and maintainer-only. Merging to `main` never publishes.

## Running a Release

```sh
gh workflow run release.yml --ref main                  # release
gh workflow run release.yml --ref main -f dry_run=true  # preview only, publishes nothing
```

When there are no release-worthy commits since the last `v*` tag, the run is a no-op.

## What the Workflow Does

1. Refuses any ref other than `main`.
2. Runs the full CI workflow on the dispatched commit.
3. Stops if `main` has moved since the dispatch.
4. Installs, builds, and runs `pnpm release`, which is semantic-release.
5. semantic-release computes the next version, creates the `v<version>` tag and GitHub Release, and publishes.

Releases run one at a time and never cancel a publish in progress. npm packages publish through npm trusted publishing (GitHub OIDC), so no `NPM_TOKEN` is stored.

## Versioning

The version comes from the Conventional Commits since the last `v*` tag. The highest change wins:

- `feat` produces a minor release.
- `fix` and `perf` produce a patch release.
- `!` or a `BREAKING CHANGE:` footer produces a major release.
- Other types do not trigger a release.

Everything this repository publishes shares one version. `package.json` versions in source are development snapshots; the Git tag and the registry hold the released version. [GitHub Releases](https://github.com/bhouston/git-dedup/releases) is the changelog of record.

## One-Time Setup

1. On npmjs.com, open each package's Trusted Publisher settings, choose GitHub Actions, and enter:

   | Field                | Value         |
   | -------------------- | ------------- |
   | Organization or user | `bhouston`    |
   | Repository           | `git-dedup`   |
   | Workflow filename    | `release.yml` |
   | Environment name     | `npm`         |

2. Protect `main`: require pull requests and the CI checks, allow merge commits, and block force pushes and deletion.
3. If the repository uploads coverage to Codecov, add the `CODECOV_TOKEN` repository secret.

## Recovery

Publishing is not atomic. If a run fails part way, compare the registry versions, the `v<version>` tag, and the workflow log, then finish what is missing from the same release commit. If publishing succeeded but the GitHub Release failed, create the release from the existing tag. Never republish a version, delete a published version, or move a release tag. Resolve the failure before dispatching another release.

## Repository Specifics

### Published Artifacts

- npm: `git-dedup`, a Node launcher plus prebuilt native binaries for linux, darwin, and win32 on x64 and arm64. The tarball is attached to the GitHub Release.
- GitHub Release assets added by GoReleaser: archives, checksums, SBOMs, and `.deb`, `.rpm`, `.apk`, and Arch packages.
- Homebrew, Scoop, and winget manifests, each published only when its secret exists (see Native Binaries).
- The documentation site at `https://git-dedup.ben3d.ca/`, deployed from the new tag by the `website` job through `pages.yml`. To redeploy the latest release, dispatch `pages.yml`.

### Required Checks

`main` requires the `ci` matrix (`ci (<os>, Node <version>)`), `native packages`, and `contribution`. The `npm` GitHub environment should be restricted to `main` and authorized maintainers. Pages uses GitHub Actions as its source, with custom domain `git-dedup.ben3d.ca`.

### Native Binaries

`scripts/build-native.mjs` runs during semantic-release's prepare step, before any publish. It builds the Go binary for all six npm targets with the released version, so `git-dedup --version` reports it, and the launcher package is then published to npm. After semantic-release creates the GitHub Release, the workflow discards the uncommitted version bump (GoReleaser needs a clean tree) and runs GoReleaser with `release.mode: append`, which adds the archives, packages, and manifests to that release. CI runs `.goreleaser.yaml` in snapshot mode on every change (the `native packages` job).

If only the GoReleaser step failed, check out the tag and run `goreleaser release --clean` with `GITHUB_TOKEN` set; it appends to the existing release.

Each channel publishes only when its credentials are present:

| Channel                                                                      | One-time setup                                                                                                                                                                | Secret(s)                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Homebrew (`brew install bhouston/tap/git-dedup`)                             | Create the public repository `bhouston/homebrew-tap`.                                                                                                                         | `HOMEBREW_TAP_GITHUB_TOKEN`: a fine-grained token with contents write access to the tap.                                                                                             |
| Scoop (`scoop bucket add bhouston https://github.com/bhouston/scoop-bucket`) | Create `bhouston/scoop-bucket`.                                                                                                                                               | `SCOOP_BUCKET_GITHUB_TOKEN`                                                                                                                                                          |
| winget (`winget install bhouston.git-dedup`)                                 | Fork `microsoft/winget-pkgs` to `bhouston/winget-pkgs`. GoReleaser opens a pull request upstream; Microsoft reviews the first submission.                                     | `WINGET_GITHUB_TOKEN`: a classic token with `public_repo` scope, since the pull request targets another owner's repository.                                                          |
| apt/dnf/apk repository                                                       | Not configured. Upload the packages from `dist/` to a hosted repository such as Cloudsmith or packagecloud, or publish a signed repository with `aptly`.                      | Depends on the host.                                                                                                                                                                 |
| macOS signing and notarization                                               | A Developer ID Application certificate exported as `.p12`, and an App Store Connect API key.                                                                                  | `MACOS_SIGN_P12` (base64 of the `.p12`), `MACOS_SIGN_PASSWORD`, `MACOS_NOTARY_ISSUER_ID`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_KEY` (base64 of the `.p8`).                           |
| Windows signing                                                              | An Azure Artifact Signing account and certificate profile. `scripts/sign-windows.sh` signs with [jsign](https://ebourg.github.io/jsign/), which the release job must install. | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, and `AZURE_SIGNING_TOKEN` (from `az account get-access-token --resource https://codesigning.azure.net`). |
