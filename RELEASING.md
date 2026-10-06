# Releasing

Releases are manual and maintainer-only. Merging to `main` never publishes.

```sh
gh workflow run release.yml --ref main                 # publish
gh workflow run release.yml --ref main -f dry_run=true  # preview only
```

The workflow refuses refs other than `main`, reruns CI, verifies that `main` has not moved since dispatch, builds the packages, and runs semantic-release. Conventional Commits since the last `v*` tag determine one shared version: `feat` is minor, `fix`/`perf` are patch, and a breaking change is major. Without release-worthy commits, the run is a no-op.

The release configuration publishes `git-dedup-core` first, then `git-dedup`. `pnpm publish` resolves the CLI's `workspace:*` core dependency to a concrete version range. The website is private. Each GitHub Release contains generated notes and both package tarballs. Git tags and npm versions are the released version of record; source manifests are development snapshots. Do not manually bump versions, edit a changelog, or push release tags as part of a normal release.

## One-time activation

1. Publish `git-dedup-core` and `git-dedup` once through an authenticated npm account to establish ownership of the unscoped names. Publish the core package first. Then configure trusted publishing for later releases.
2. On npmjs.com, configure **Trusted Publisher** for `git-dedup-core` and `git-dedup`. Choose GitHub Actions, GitHub user `bhouston`, repository `git-dedup`, workflow filename `release.yml`, and environment `npm`. Enable direct `npm publish` as an allowed action. The workflow uses OIDC (`id-token: write`), not `NPM_TOKEN`. [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) describes these settings.
3. Create the GitHub `npm` environment and restrict it to `main` and authorized maintainers. Enable Pages with GitHub Actions as its source and set its custom domain to `git-dedup.ben3d.ca` to deploy at `https://git-dedup.ben3d.ca/`.
4. Protect `main` with PRs and the passing checks the six `ci` matrix checks (macOS/Linux/Windows with Node 22/26) and `contribution` once the initial bootstrap is pushed.
5. Before the first actual release, run a dry run and `pnpm package:check`. Confirm the proposed version does not already exist on npm.

## Recovery

After the repository rename, check the trusted publisher for both npm packages before releasing. The GitHub repository must be `bhouston/git-dedup`; replace any connection that still names `gitx` while retaining workflow `release.yml` and environment `npm`.

Publishing two npm packages is not atomic. If the workflow fails part way, compare npm versions, the `v<version>` Git tag, and the run log. Finish only the missing package from the same release commit after identifying the cause. If npm publishing succeeded but the GitHub Release failed, create the release from the existing tag; never republish an existing npm version.

## Native binaries (not yet part of the release workflow)

`.goreleaser.yaml` builds the Go binary for Linux, macOS, and Windows on x64 and arm64, plus the archives, checksums, SBOMs, `.deb`/`.rpm`/`.apk`/Arch packages, a Homebrew cask, a Scoop manifest, and a winget manifest. CI runs it in snapshot mode on every change (the `native packages` job) and installs each Linux package in its distribution. The release workflow does not run it yet; when the native port reaches parity, add a step after `pnpm release` that runs `goreleaser release --clean` on the new tag (`release.mode: append` adds the artifacts to the GitHub Release that semantic-release created).

Each channel publishes only when its credentials are present:

| Channel                                                                      | One-time setup                                                                                                                                                                                           | Secret(s)                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Homebrew (`brew install bhouston/tap/git-dedup`)                             | Create the public repository `bhouston/homebrew-tap`.                                                                                                                                                    | `HOMEBREW_TAP_GITHUB_TOKEN`: a fine-grained token with contents write access to the tap.                                                                                                                                      |
| Scoop (`scoop bucket add bhouston https://github.com/bhouston/scoop-bucket`) | Create `bhouston/scoop-bucket`.                                                                                                                                                                          | `SCOOP_BUCKET_GITHUB_TOKEN`                                                                                                                                                                                                   |
| winget (`winget install bhouston.git-dedup`)                                 | Fork `microsoft/winget-pkgs` to `bhouston/winget-pkgs`. GoReleaser opens a pull request upstream; Microsoft reviews the first submission.                                                                | `WINGET_GITHUB_TOKEN`: a classic token with `public_repo` scope, since the pull request targets another owner's repository.                                                                                                   |
| apt/dnf/apk repository                                                       | Not configured. Upload the packages from `dist/` to a hosted repository such as Cloudsmith (free for open source) or packagecloud, or publish a signed repository with `aptly`.                          | Depends on the host.                                                                                                                                                                                                          |
| macOS signing and notarization                                               | A Developer ID Application certificate exported as `.p12`, and an App Store Connect API key.                                                                                                             | `MACOS_SIGN_P12` (base64 of the `.p12`), `MACOS_SIGN_PASSWORD`, `MACOS_NOTARY_ISSUER_ID`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_KEY` (base64 of the `.p8`).                                                                    |
| Windows signing                                                              | An Azure Artifact Signing (formerly Trusted Signing) account and certificate profile. `scripts/sign-windows.sh` signs with [jsign](https://ebourg.github.io/jsign/), which the release job must install. | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, and `AZURE_SIGNING_TOKEN` (from `az account get-access-token --resource https://codesigning.azure.net`, ideally through OIDC with `azure/login`). |
