# gitx website

Docusaurus documentation and project site for gitx.

```sh
pnpm --filter @bhouston/gitx-website dev
pnpm --filter @bhouston/gitx-website build
```

The default production URL is `https://gitx.ben3d.ca/`. The site is served from the domain root (`baseUrl: /`). Override `SITE_URL` and `BASE_URL` for another host.

GitHub Pages deploys through `.github/workflows/pages.yml` after changes merge to `main`. In the repository Pages settings, use GitHub Actions as the source and `gitx.ben3d.ca` as the custom domain.
