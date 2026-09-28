# gitx

gitx is a Node.js wrapper around Git that helps repeated clones share local object storage. It maintains a bare mirror per remote and makes ordinary Git repositories from that mirror. The tool and this repository are named **gitx**; the GitHub repository is [`bhouston/gix`](https://github.com/bhouston/gix).

The current target is Node.js 22+, macOS, and Linux. Git is required. The implementation provides remote cloning, submodule preparation during supported and recursive updates, post-add caching, repository adoption, store commands, diagnostics, and forwarding of other Git commands. `gitx worktree add` uses Git's shared common object database and initializes supported submodules from mirrors. The broader design and implementation stages are in [docs/PLAN.md](docs/PLAN.md).

## Try it from the repository

```sh
pnpm install
pnpm build
node packages/cli/dist/bin.js clone https://github.com/you/project.git
```

To inspect storage sharing for an optimized clone, opt in to a short report:

```sh
node packages/cli/dist/bin.js --stats clone https://github.com/you/project.git
node packages/cli/dist/bin.js cache ./project --stats
```

The report goes to stderr after an optimized clone or cache adoption. It shows whether the mirror was reused or created, bytes shared through hard links, and bytes copied. Clone output estimates duplicate pack bytes avoided, with a first-use caveat: creating the mirror may mean no net space savings versus a plain clone yet. Cache output compares private packed-file bytes before and after adoption. The report counts local `.pack`, `.idx`, and `.rev` files; loose Git objects and Git LFS are excluded. These are logical file-size estimates, not measured disk blocks reclaimed. Reflinks may share physical storage without matching inode IDs. Normal commands skip this extra scan, and a plain Git fallback does not print a stats report.

Set `GITX_STORE` to choose a local store for a single invocation, or explicitly set `gitx.store` in Git configuration:

```sh
git config --global gitx.store "$HOME/.cache/gitx"
```

gitx does not automatically modify global Git configuration. `gitx store set <path>` explicitly writes both `gitx.store` and `lfs.storage`; use it only if you want the global LFS setting. Keep the store on the same filesystem as your working copies to allow Git's local clone to share object files through hard links. A different filesystem may result in copies.

`gitx.enabled=false` disables optimization, `gitx.gitPath` selects the real Git executable, and `gitx.linkMode` accepts `auto`, `hardlink`, `reflink`, or `copy`. Use `GITX_DISABLE=1` for a one-command bypass. The [original overlay design](docs/DESIGN.md) is preserved alongside the [implementation plan](docs/PLAN.md).

## Workspace

| Package                  | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `@bhouston/gitx-core`    | Git operations, mirrors, and storage logic           |
| `@bhouston/gitx`         | CLI parsing, Git forwarding, and command integration |
| `@bhouston/gitx-website` | Docusaurus documentation and project site            |

```sh
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm docs:build
pnpm test:proof
```

The core is tested with Vitest and the CLI with `vitest-command-line`. The proof script uses temporary loopback Git remotes to exercise concurrent clones and store deletion. See the [documentation](packages/website/docs/index.md) for usage, the [safety model](packages/website/docs/safety.md), and [development notes](packages/website/docs/development.md).

After installing gitx globally, use the [agent setup guide](packages/website/docs/agents.md) for copyable `AGENTS.md` and `CLAUDE.md` instructions. Agents call `gitx` explicitly; no separate clone or submodule helper is needed.

## Safety

The clone's object directory is independent of the mirror and does not use Git alternates. Removing the mirror leaves already cloned Git objects intact. Git LFS storage is separate: `gitx store clear` removes stored LFS objects too, which may require fetching them again. Unsupported clone forms, including local paths and shallow or partial clones, use ordinary Git behavior.

gitx marks its store with `.gitx-store`. `gitx store clear` refuses unmarked directories and directories containing unrelated files. Store mutations are serialized so clearing cannot race an active mirror update.
