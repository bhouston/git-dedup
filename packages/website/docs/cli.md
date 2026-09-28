---
title: CLI reference
---

`gitx` accepts ordinary Git commands. Supported remote `clone` invocations use the local mirror; other Git commands and unsupported clone forms run through Git.

```sh
gitx clone <remote> [directory]
gitx status
gitx -C <directory> log --oneline
gitx submodule update --init
gitx submodule update --init --recursive
gitx submodule add <remote> <path>
gitx worktree add ../task-branch
```

## Optional storage report

```sh
gitx --stats clone <remote> [directory]
gitx cache [path] --stats
```

Each successful optimized clone or adopted repository writes a line to stderr showing whether it reused or created a mirror, bytes shared by hard links, and bytes copied. Clone output says **estimated duplicate pack bytes avoided**. Cache output shows private packed-file bytes before and after adoption and an **estimated private pack reduction**. A final stderr line totals the estimate. The normal `cache` stdout summary still appears. Plain Git passthrough does not print stats.

The report counts local `.pack`, `.idx`, and `.rev` files by logical file size. It excludes loose Git objects and Git LFS. Shared bytes require equal device and inode IDs in the mirror and consumer. For a clone, the duplicate-byte estimate equals shared bytes; creating the mirror on first use may yield no net space savings versus a plain clone yet. For cache adoption, the estimate is the nonnegative reduction in consumer-private packed file bytes after repacking. The report does not walk Git objects or download data for measurement; it runs only with `--stats`.

These figures do not measure physical disk blocks reclaimed. Compression, copy or reflink modes, and filesystem allocation affect actual savings. Reflinked files have separate inode IDs, so they report zero shared bytes even where the filesystem shares storage.

For supported submodule updates, gitx prepares missing submodule Git directories using mirrors before Git completes the checkout. `--recursive` also prepares nested modules. `submodule add` uses Git, then caches the new module. `worktree add` uses Git's shared common object database and initializes supported submodules through mirrors. With `--no-checkout`, run `gitx submodule update --init` later.

gitx's own commands are:

| Command                      | Action                                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| `gitx cache [path]`          | Adopt or relink an existing repository and its discoverable submodules |
| `gitx store`                 | Print store path, mirror count, and size                               |
| `gitx store set <path>`      | Set global `gitx.store` and `lfs.storage`                              |
| `gitx store refresh`         | Fetch and repack mirrors                                               |
| `gitx store gc --unused 30d` | Remove mirrors unused for the chosen age                               |
| `gitx store clear`           | Remove the store, including its LFS directory                          |
| `gitx doctor`                | Inspect filesystem, Git, and LFS setup                                 |

Use `gitx --help` or a command's `--help` flag for options. The CLI also supports [clidoc](https://github.com/bhouston/clidoc) and can write its command description in OpenCLI format:

```sh
gitx docgen --format json --output gitx.json
gitx docgen --format markdown --output gitx-commands.md
```

For a one-off bypass, use Git directly or set `GITX_DISABLE=1` when invoking gitx.
