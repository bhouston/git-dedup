# How git-dedup works

git-dedup maintains one bare SHA-1 Git repository at `<store>/pool.git`. It fetches branches and tags from each registered remote into separate internal ref namespaces. Git's content hashes deduplicate identical objects across repeated checkouts, forks, and unrelated repositories automatically.

Supported `git-dedup clone` commands fetch into the pool, then run native `git clone --reference <pool>` using the real remote as `origin`. The checkout's `objects/info/alternates` file points to the pool. Later clones borrow its existing objects. The pool can be on another filesystem.

`git-dedup store add` imports an existing checkout's refs and HEAD into the pool, installs the alternate, and repacks the checkout to remove private copies of objects already in the pool. It then refreshes the remote when available. Linked worktrees use their shared common object directory. The same process visits discoverable submodules. git-dedup is not a disposable cache: linked checkouts depend on the store for objects.

The pool records newly seen consumer ref tips during checkout adoption. `store gc` compacts without pruning unreachable objects. Preserving old tips can make the pool grow over time.

Supported `submodule update --init` commands prepare missing submodule Git directories with the same pool as reference. Recursive updates cover nested modules, including in new worktrees. Other Git commands and unsupported clone forms pass through to native Git, including local source paths, shallow or partial clones, explicit reference options, and SHA-256 repositories.

The checkout depends on the pool. See the [storage guide](safety.md) before moving or deleting it.

## Storage reports

`git-dedup --stats clone` and `git-dedup store add --stats` print a storage report to stderr. The report shows whether the pool already existed. Adoption reports compare private pack bytes before and after adoption. Clone reports identify use of Git alternates; they do not estimate disk savings.

Measurement is opt-in and scans local `.pack`, `.idx`, and `.rev` file metadata, without traversing Git objects. It excludes loose objects. These are logical file-size estimates, not measured disk blocks reclaimed. The first use populates the pool and can increase total disk use. Plain Git fallback does not print a report.
