# Storage overlay design

This document records the overlay design, updated to use only the explicit `gitx` executable. See [PLAN.md](PLAN.md) and the user guide for implemented behavior and refinements, particularly locking and Git LFS retention.

## Goal

Supported `gitx clone`, `gitx submodule update`, and `gitx worktree add` commands use a global store automatically. You never pass a flag or configure a repo. Deleting the store at any time is harmless, and the next clone rebuilds what it needs.

**Non-goals for v1:** speeding up fetch and pull, shallow and partial clones, and Windows.

## Core terms

| Term           | Meaning                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Store**      | Root directory for everything gitx manages, e.g. `~/.cache/gitx`.                                                   |
| **Mirror**     | A bare repo in the store, one per remote, holding all heads and tags.                                               |
| **Mirror key** | The normalized remote identity: `github.com/mrdoob/three.js`. The SSH and HTTPS forms of a URL map to the same key. |
| **Consumer**   | Any normal repo, worktree, or submodule gitdir whose packs are hard-linked from a mirror.                           |
| **Base pack**  | A mirror pack hard-linked into a consumer and marked with `.keep`, so it's shared and never rewritten.              |
| **Local pack** | Packs a consumer creates itself (your commits, later fetches). These are small and unique to that repo.             |

## Configuration

Git already accepts arbitrary config keys, so gitx doesn't need its own config system:

```
git config --global gitx.store ~/.cache/gitx
git config --global gitx.linkMode auto      # auto | reflink | hardlink | copy
git config --global gitx.enabled true
```

`gitx store set <path>` can exist as sugar, but it only writes that key. Environment overrides: `GITX_STORE`, and `GITX_DISABLE=1` for a one-off bypass. For LFS, gitx sets `lfs.storage` globally to `<store>/lfs`, so LFS lives in the same store.

## Store layout

```
<store>/
  mirrors/github.com/mrdoob/three.js.git/   bare mirror
  mirrors/github.com/you/three.js.git/
  lfs/                                      global LFS objects
  locks/                                    one lock per mirror key
  tmp/                                      staging for atomic mirror creation
```

## Dispatch: how gitx works

1. **Installation**: install the `gitx` executable globally and invoke it explicitly. Git remains installed separately. gitx finds Git on `PATH`, or from `gitx.gitPath`. Agent instructions should recommend `gitx` for repository operations.
2. **Parsing**: skip Git's global options (`-C`, `-c k=v`, `--git-dir`, …) to find the subcommand, and keep them so they can be forwarded.
3. **Routing**:
   - `clone`, `submodule update|init`, `submodule add`, `worktree add`: handled.
   - `cache`, `store`, `doctor`: gitx's own commands.
   - Everything else: passthrough. gitx replaces its own process with real Git, so exit codes, signals, TTY, and pagers behave identically.
4. **Bailing out**: a handled command falls back to plain passthrough when it sees anything unsupported, such as `--depth`, `--filter`, `--mirror`, `--reference`, `--no-hardlinks`, a local-path URL, or a SHA-256 repo. Doing the plain Git thing is always a correct result.

## Flow 1: clone

1. **Normalize** the URL into a mirror key.
2. **Lock** the mirror key. This matters because parallel agents will clone the same repo at the same moment.
3. **Ensure the mirror**:
   - If it's missing, bare-clone the remote into `tmp/` with heads and tags only (no `refs/pull/*`), then rename it into place atomically.
   - If it exists, `git fetch --prune` in the mirror.
4. **Release the lock.**
5. **Clone from the mirror's local path.** Git hard-links object files for local clones by default and falls back to copying across filesystems, so gitx doesn't implement linking itself.
6. **Rewire**: set `origin` back to the real URL, then run one cheap `git fetch origin` so remote-tracking refs are accurate. The objects are already present.
7. **Mark** every linked pack with a `.keep` file.
8. **Finish** the checkout (`-b`, etc.). If `--recurse-submodules` was given, run Flow 2.

## Flow 2: submodules

This is the flow that fixes your original worktree pain.

1. Read `.gitmodules` and resolve relative URLs against the superproject's remote.
2. For each submodule without an existing gitdir: ensure its mirror (Flow 1, steps 1–4), then local-clone the mirror directly into the gitdir location. That's `.git/modules/<name>`, or `.git/worktrees/<wt>/modules/<name>` inside a worktree. Add the `.keep` files.
3. Pass through to real `git submodule update`. Git finds an existing gitdir, reuses it, and only checks out.

Every agent worktree then gets its submodules as hard links in milliseconds, with no `--reference` and no alternates.

## Flow 3: `gitx cache [path]`: adopt an existing repo

This is idempotent, so it doubles as "relink after the mirror has changed."

1. Get the key from `origin`. If the mirror doesn't exist, seed it from this repo first with a local bare clone, then point the mirror at the real remote and fetch. That saves re-downloading.
2. Hard-link the mirror's packs into the repo and mark them with `.keep`.
3. Run `git repack -a -d` without bitmaps. Kept packs are excluded, so the new pack contains only objects unique to this repo, and the old duplicate packs are deleted.
4. Recurse into submodule gitdirs.
5. Move `.git/lfs/objects` into the global LFS store.

## Store commands

- `gitx store` prints the path, size, and mirror count.
- `gitx store refresh` fetches all mirrors and runs `git repack --geometric=2`, so big packs stay stable.
- `gitx store gc --unused 30d` removes mirrors not touched recently. gitx updates a timestamp file on each use.
- `gitx store clear` deletes the store entirely. This is safe by design.
- `gitx doctor` checks:
  - the store and your code directories are on the same filesystem;
  - reflink support;
  - `lfs.storage` is set;
  - the Git version.

## Self-healing matrix

| Event                 | Result                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Store deleted         | Consumers keep working, because their hard links hold the data. The next clone rebuilds the mirror.   |
| Mirror repacked       | Consumers keep their old base pack (it's still valid). Running `gitx cache` relinks them for sharing. |
| Store on another disk | Git copies instead of linking. Everything still works, just without dedupe. `doctor` warns.           |
| gitx uninstalled      | Everything is plain Git. No repo depends on gitx.                                                     |

That last row is the key property. Unlike alternates, no repo ever depends on gitx or the store existing.

## Risks to verify in an early spike

1. That `git submodule update` reliably reuses a pre-populated gitdir, including inside worktrees.
2. That `git repack -a -d` excludes kept-pack objects in your Git version. Writing bitmaps can override this, hence "without bitmaps" in Flow 3.
3. Lock behavior when many agents clone the same repo at once.
4. Correctly mapping URL variants (SSH aliases, `insteadOf` rewrites) to a single mirror key.

## Milestones, working backwards from the end state

1. **Passthrough, config, clone flow.** This alone gives useful behavior.
2. **Submodule flow.** This fixes the worktree pain.
3. **`gitx cache` adoption and LFS migration.**
4. **Store maintenance and `doctor`.**
5. **Later:** fetching through the mirror, partial-clone support, and reflinked LFS working files.
