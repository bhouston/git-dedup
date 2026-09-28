# Releasing

Releases are manual and maintainer-only. Merging to `main` never publishes.

```sh
gh workflow run release.yml --ref main                 # publish
gh workflow run release.yml --ref main -f dry_run=true  # preview only
```

The workflow refuses refs other than `main`, reruns CI, verifies that `main` has not moved since dispatch, builds the packages, and runs semantic-release. Conventional Commits since the last `v*` tag determine one shared version: `feat` is minor, `fix`/`perf` are patch, and a breaking change is major. Without release-worthy commits, the run is a no-op.

The release configuration publishes `@bhouston/gitx-core` first, then `@bhouston/gitx`. `pnpm publish` resolves the CLI's `workspace:*` core dependency to a concrete version range. The website is private. Each GitHub Release contains generated notes and both package tarballs. Git tags and npm versions are the released version of record; source manifests are development snapshots. Do not manually bump versions, edit a changelog, or push release tags as part of a normal release.

## One-time activation

1. Create or claim both npm package names under the `bhouston` npm account. For first publication, npm trusted publishing may require a package to be created through npm's initial publishing flow before the trusted publisher can be configured. Check the current npm instructions for scoped package creation.
2. On npmjs.com, configure **Trusted Publisher** for `@bhouston/gitx-core` and `@bhouston/gitx`. Choose GitHub Actions, GitHub user `bhouston`, repository `gitx`, workflow filename `release.yml`, and environment `npm`. Enable direct `npm publish` as an allowed action. The workflow uses OIDC (`id-token: write`), not `NPM_TOKEN`. [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) describes these settings.
3. Create the GitHub `npm` environment and restrict it to `main` and authorized maintainers. Enable Pages with GitHub Actions as its source and set its custom domain to `gitx.ben3d.ca` to deploy at `https://gitx.ben3d.ca/`.
4. Protect `main` with PRs and the passing checks the four `ci` matrix checks (macOS/Linux with Node 22/26) and `contribution` once the initial bootstrap is pushed.
5. Before the first actual release, run a dry run and `pnpm package:check`. Confirm the proposed version does not already exist on npm.

## Recovery

After a repository rename, check the trusted publisher for both npm packages before releasing. The GitHub repository must be `bhouston/gitx`; replace any connection that still names `gix` while retaining workflow `release.yml` and environment `npm`.

Publishing two npm packages is not atomic. If the workflow fails part way, compare npm versions, the `v<version>` Git tag, and the run log. Finish only the missing package from the same release commit after identifying the cause. If npm publishing succeeded but the GitHub Release failed, create the release from the existing tag; never republish an existing npm version.
