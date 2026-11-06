<p align="center">
  <a href="https://git-dedup.ben3d.ca" target="_blank" rel="noopener noreferrer">
    <img alt="git-dedup logo" src="https://raw.githubusercontent.com/bhouston/git-dedup/main/packages/docs/static/img/icon-512.png" height="96">
  </a>
</p>
<br/>
<p align="center">
  <a href="https://npmjs.com/package/git-dedup"><img src="https://img.shields.io/npm/v/git-dedup.svg" alt="npm package"></a>
  <a href="https://www.npmtrends.com/git-dedup"><img src="https://img.shields.io/npm/dw/git-dedup.svg" alt="npm downloads"></a>
  <a href="https://codecov.io/gh/bhouston/git-dedup"><img src="https://codecov.io/gh/bhouston/git-dedup/branch/main/graph/badge.svg" alt="coverage"></a>
  <a href="https://discord.gg/fwupDN493R"><img src="https://img.shields.io/badge/chat-discord-blue?style=flat&logo=discord" alt="discord chat"></a>
  <a href="https://git-dedup.ben3d.ca"><img src="https://img.shields.io/badge/docs-read-blue?style=flat" alt="documentation"></a>
</p>
<br/>

# git-dedup

> A git wrapper with a shared object store: faster checkouts, less disk.

- 🚀 6x Faster Large Checkouts
- 💾 70% Less Git Data on Disk
- 🔁 Clones, Worktrees, Submodules
- 🔌 Drop-In Git Wrapper
- 🖥️ Native Binary, Every Platform

git-dedup is a wrapper around `git` built for fleets of coding agents. It forwards ordinary Git commands unchanged and automatically keeps one shared copy of Git history, so every new clone, worktree, and submodule reuses what is already on disk instead of downloading it again. Checkouts are normal Git repositories, so `git`, your editor, and your agents work as before.

The 6x figure comes from large checkouts dropping from over a minute to about 10 seconds. The 70% figure comes from 117 checkouts, where Git data dropped from 35.5 GB to 11.1 GB.

[Read the Docs to Learn More](https://git-dedup.ben3d.ca).

## Install and use

```sh
npm install --global git-dedup

# check out a new repo automatically using the dedup store
git-dedup clone https://github.com/you/project.git

# dedup an existing repo into the store
git-dedup store add ./my-existing-repo
```

That's it. git-dedup automatically consolidates the new or existing project's history into a shared store in `~/.git-dedup` or if its history already existed there, it reuses it automatically.

git-dedup is a native binary for macOS, Linux, and Windows on x64 and arm64; it only needs **Git**. The npm package runs the binary for your platform through a small launcher (Node.js 18+). Without Node.js, download an archive, `.deb`, `.rpm`, or `.apk` from [GitHub Releases](https://github.com/bhouston/git-dedup/releases).

**[CLI reference](https://git-dedup.ben3d.ca/docs/cli) · [Agent setup](https://git-dedup.ben3d.ca/docs/agents)**

## Why I built it

I run fleets of coding agents, each in its own checkout. Every task started by cloning repositories and submodules from scratch, so agents sat idle waiting on downloads. Then I started running out of disk space, because every checkout held another full copy of the same history. git-dedup fixed both. We have dogfooded it heavily across our own agent fleets and repositories to make it robust and efficient.

## More commands

```sh
# Worktrees and submodules get their history from the store too.
git-dedup clone --recurse-submodules https://github.com/you/project.git
git-dedup worktree add -b my-task ../my-task
git-dedup submodule update --init --recursive

# Reclaim space from repositories you already have.
git-dedup store add .
git-dedup store add ~/Coding --all

# Inspect the store.
git-dedup store
```

Ordinary commands, such as `git-dedup status`, are forwarded to Git. Unsupported clone forms, such as shallow, single-branch, or partial clones, fall back to plain Git. See the [CLI reference](https://git-dedup.ben3d.ca/docs/cli).

## Configuration

The default store is `~/.git-dedup` (`%USERPROFILE%\.git-dedup` on Windows). Override it with `GIT_DEDUP_STORE`:

```sh
export GIT_DEDUP_STORE="$HOME/my-git-dedup-store"
```

```powershell
$env:GIT_DEDUP_STORE = "$HOME\my-git-dedup-store"
```

Changing `GIT_DEDUP_STORE` selects a different store; it does not move the existing one. git-dedup does not change global Git configuration.

| Setting             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `GIT_DEDUP_STORE`   | Override the store path for an invocation |
| `git-dedup.gitPath` | Select the Git executable                 |

## Keep the store

Your checkouts read their history from the shared store. Deleting it breaks every repository consolidated into it. See the [store guide](https://git-dedup.ben3d.ca/docs/safety) for moving or detaching checkouts.

## Repository layout

| Path                                                                     | Contents                                                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [cmd/git-dedup](cmd/git-dedup), [internal](internal)                     | The Go implementation                                                                                |
| [packages/cli](packages/cli)                                             | The [git-dedup](https://www.npmjs.com/package/git-dedup) npm package: a launcher and native binaries |
| [test](test)                                                             | Behavior suites that drive the binary                                                                |
| [Website](https://github.com/bhouston/git-dedup/tree/main/packages/docs) | Docusaurus documentation and project site; not published to npm                                      |

After installing, the [agent setup guide](https://git-dedup.ben3d.ca/docs/agents) provides instructions to add to `AGENTS.md` or `CLAUDE.md` so agents call `git-dedup` explicitly.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:proof
```

Development needs Go (the version in `go.mod`), Node.js, and pnpm. `pnpm build` compiles the binary for this machine. `pnpm check` runs Oxlint, Oxfmt, `go vet`, the Vitest behavior suites against the binary, workflow tests, npm package checks, and the documentation build; `go test ./...` runs the Go unit tests. The proof script creates temporary loopback Git remotes and verifies that concurrent clones share one object pool and remain valid after pool maintenance.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [RELEASING.md](RELEASING.md) for release setup, and [GitHub Releases](https://github.com/bhouston/git-dedup/releases) for release notes.

## Contribution

See [Contributing Guide](CONTRIBUTING.md).

## License

MIT

## Author

[Ben Houston](https://ben3d.ca), Sponsored by [Land of Assets](https://landofassets.com).
