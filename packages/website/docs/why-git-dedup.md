# Why git-dedup?

git-dedup is for machines that hold many checkouts of related repositories: coding agents that start a fresh clone per task, editors that clone on your behalf, and developers who keep forks and review copies side by side. Git normally gives each clone its own object database, so the same history is stored once per checkout. git-dedup puts objects from every remote into one local pool that supported checkouts borrow through Git alternates.

```sh
git-dedup clone https://github.com/you/project.git project
git-dedup clone https://github.com/you/project.git project-review
git-dedup store add ./existing-project --stats
```

## Compared with the alternatives

Git already has two good ways to save space. Use them when they fit.

- **`git worktree`** shares one object database between several checkouts of the same repository. If every checkout starts from one clone you control, worktrees already avoid the duplication.
- **Partial clones** (`git clone --filter=blob:none`) skip historical file contents until they are needed. They also save a lot of space, at the cost of fetching blobs from the remote later.

git-dedup helps where those stop:

- **Forks and independent clones share one pool.** Objects are keyed by hash, so a fork, an upstream clone, and an unrelated second clone of the same project reuse the same objects, even when their remotes have different owners or names.
- **Clones made by agents and editors.** Tools that run `git clone` for each task create independent clones, not worktrees. Pointing them at `git-dedup` makes those clones share the pool without changing how the tool works.
- **Repositories you already have.** `git-dedup store add` adopts existing checkouts, including local commits and submodules, and removes their private copies of objects already in the pool.

Each checkout keeps its real `origin` URL and a complete local history, and ordinary Git commands keep working. You can build the same setup by hand with `git clone --reference`; git-dedup manages the pool, remote namespaces, checkout adoption, and submodule setup for you.

Linked checkouts depend on the pool; see [storage dependency](safety.md).
