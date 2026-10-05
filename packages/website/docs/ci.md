---
title: CI setup
---

Network clone and fetch requests with `--depth` (any value), `--single-branch`, `--filter=blob:none`, or `--filter=tree:0` use full history from the shared store. The first request fills a cold store; later requests reuse its objects and still contact the remote for updates. There is no shallow-upgrade opt-out: use native Git when true shallow semantics matter. `--shallow-since` and `--shallow-exclude` pass through unchanged. Sparse checkout still controls which files appear in the working tree. Existing shallow repositories become full on supported fetches; `--deepen` and `--unshallow` impose no restriction on full repositories.

Use [checkout-git-dedup](https://github.com/bhouston/checkout-git-dedup), our fork of `actions/checkout`, to call the installed wrapper directly:

```yaml
steps:
  - uses: bhouston/checkout-git-dedup@main
```

Install git-dedup on the runner once, alongside native Git and Node.js. The action inherits the runner's settings, including `GIT_DEDUP_STORE` and `git-dedup.gitPath`, with no action-specific configuration or `git` PATH shim. It keeps `HOME` intact during credential setup, so the default store remains `~/.git-dedup`. Keep the store between jobs and make it readable and writable by the runner account. Inputs, outputs, authentication, and post-job cleanup follow upstream checkout.

Use a git-dedup build containing pool-backed fetch support ([PR #144](https://github.com/bhouston/git-dedup/pull/144), available on `main`); npm 2.1.0 predates this feature. The action requires git-dedup on `PATH` for checkout and post-job cleanup.

If you keep the standard `actions/checkout`, it invokes `git` directly. A `git` PATH shim installed before checkout remains an alternative; set `git-dedup.gitPath` to the absolute native Git executable to avoid recursion.

For a cache check, run `git-dedup --stats fetch --depth=1 origin` in each of two fresh initialized checkouts of the same remote. The second report should say `reused object pool`; `git rev-parse --is-shallow-repository` should print `false`. This reports pool reuse, not an offline checkout: remote updates still require network access. Linked checkouts depend on the store, so keep it in place.
