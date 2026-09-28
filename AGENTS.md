# Working on gitx

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and local checks.

Preserve native Git argument semantics by forwarding unsupported invocations. Keep test Git configuration and repositories isolated in temporary directories. A consumer must remain valid after the store is deleted; do not introduce Git alternates.
