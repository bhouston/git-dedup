# Why git-dedup?

I built git-dedup because I run fleets of coding agents, each in its own checkout. Every task started by cloning repositories and their submodules from scratch, so agents spent their first minutes waiting on downloads. Then I started running out of disk space, because every checkout carried another full copy of the same history.

git-dedup fixed both. Every clone, worktree, and submodule now borrows from one shared copy of history in `~/.git-dedup`. My agents start dramatically faster, with large checkouts going from over a minute to about 10 seconds, and my Git data shrank from 35.5 GB to 11.1 GB.

We have dogfooded it heavily across our own agent fleets and repositories to make it robust and efficient.

## Compared with the alternatives

- **`git worktree`** shares history between checkouts of one repository, but every worktree still re-downloads its submodules, and agents and editors that run `git clone` get independent clones anyway.
- **Partial clones** (`git clone --filter=blob:none`) skip file history up front, then fetch it from the remote later when it is needed.

git-dedup shares history across all of these: independent clones, forks, worktrees, and submodules. Each checkout keeps its real `origin` URL and a complete local history, so ordinary Git commands and tools keep working.
