### Fixed

- **CI/CD merge queue optimization (#2571):** Bypassed stale base reversion check (f) on per-PR evaluation in `merge_group` to prevent spurious queue ejections when `main` advances, preserved integrated branch trees when merging `main` in `resolve_effective_head`, and explicitly enrolled PRs with `mergeMethod: REBASE` via GraphQL in `auto-merge-trusted.yml` to prevent auto-merge stalling in `CLEAN` state.
