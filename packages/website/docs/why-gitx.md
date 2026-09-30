# Why gitx?

Git normally keeps a separate object database for each clone. Even forks with common history can occupy duplicate disk space. gitx puts objects from many remotes into one bare Git pool and lets supported checkouts borrow them through Git alternates.

```sh
gitx clone https://github.com/you/project.git project
gitx clone https://github.com/you/project.git project-review
gitx cache ./existing-project --stats
```

The pool uses Git object hashes, so identical objects share storage even when their remotes have different owners or names. The same pool supports submodules and submodules in new worktrees. The checkout keeps its real `origin` URL and ordinary Git commands continue to work.

You can reproduce the mechanism manually with `git clone --reference`, but gitx manages the pool, remote namespaces, cache adoption, and submodule setup. Cached checkouts depend on the pool; see [storage dependency](safety.md).
