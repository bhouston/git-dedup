---
title: CI setup
---

Network clone and fetch requests with `--depth` (any value), `--single-branch`, `--filter=blob:none`, or `--filter=tree:0` use full history from the shared store. The first request fills a cold store; later requests reuse its objects and still contact the remote for updates. There is no shallow-upgrade opt-out: use native Git when true shallow semantics matter. `--shallow-since` and `--shallow-exclude` pass through unchanged. Sparse checkout still controls which files appear in the working tree. Existing shallow repositories become full on supported fetches; `--deepen` and `--unshallow` impose no restriction on full repositories.

On a self-hosted runner, [actions/checkout](https://github.com/actions/checkout/blob/main/src/git-command-manager.ts) calls `git init` followed by `git -c protocol.version=2 fetch --depth=1 ...`, rather than cloning. To intercept those calls, install a `git` shim ahead of native Git on the runner's `PATH` before starting the runner service or before the checkout step. For a macOS/Linux runner, provision it once using native Git and the installed git-dedup paths:

```sh
npm install --global git-dedup
native_git=$(command -v git)
dedup_binary=$(command -v git-dedup)
"$native_git" config --global git-dedup.gitPath "$native_git"
mkdir -p "$HOME/.local/git-dedup-bin"
ln -sf "$dedup_binary" "$HOME/.local/git-dedup-bin/git"
export PATH="$HOME/.local/git-dedup-bin:$PATH"
export GIT_DEDUP_STORE="$HOME/.git-dedup"
```

Keep Node.js available on that `PATH`, persist the store between jobs, and give the runner account read/write access to it. Native Git must remain available at the configured absolute path. Checkout-local HTTP and credential settings are forwarded to the pool fetch, including authentication configured by the action.

For a cache check, run `git-dedup --stats fetch --depth=1 origin` in each of two fresh initialized checkouts of the same remote. The second report should say `reused object pool`; `git rev-parse --is-shallow-repository` should print `false`. This reports pool reuse, not an offline checkout: remote updates still require network access. Linked checkouts depend on the store, so keep it in place.
