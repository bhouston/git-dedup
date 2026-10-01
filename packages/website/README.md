# git-dedup website

Docusaurus documentation and project site for git-dedup.

git-dedup itself is used like this:

```sh
npm install -g git-dedup

# check out a new repo automatically using the dedup store
git-dedup clone https://github.com/you/project.git

# dedup an existing repo into the store
git-dedup store add ./my-existing-repo
```

To work on the site:

```sh
pnpm --filter git-dedup-website dev
pnpm --filter git-dedup-website build
```

The default production URL is `https://git-dedup.ben3d.ca/`. The site is served from the domain root (`baseUrl: /`). Override `SITE_URL` and `BASE_URL` for another host.

GitHub Pages deploys through `.github/workflows/pages.yml` after changes merge to `main`. In the repository Pages settings, use GitHub Actions as the source and `git-dedup.ben3d.ca` as the custom domain.

Both commands build the CLI and run `git-dedup docgen` to generate `.generated/git-dedup.json`. The `@clidoc/docusaurus` plugin turns it into the CLI reference under `docs/cli/`. Generated files are ignored; update command definitions in `packages/cli/src/commands` instead.
