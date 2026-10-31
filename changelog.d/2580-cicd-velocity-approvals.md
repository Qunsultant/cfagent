### Fixed

- Eliminated environment approval blocks on PR and Merge Queue test shards in `.github/workflows/ci.yml` by removing the `environment:` deployment setting from `test-shard-pr` and `test-shard-mq`. PR and queue tests run as pure unit tests without triggering environment review gates.
- Enforced REBASE merge method in `.github/workflows/auto-merge-trusted.yml` by detecting and resetting any existing non-REBASE autoMergeRequest via GraphQL `disablePullRequestAutoMerge` before enabling `enablePullRequestAutoMerge(mergeMethod: REBASE)`, ensuring full compatibility with repository ruleset 25543527.
- Dampened auto-update storms in `.github/workflows/auto-update-prs-app.yml` by protecting in-flight CI runs (`statusCheckRollup.state === 'PENDING'`) and skipping already clean (`CLEAN` / `MERGEABLE`) or conflicting (`DIRTY` / `CONFLICTING`) pull requests on push to `main`.
- Corrected shell command substitution in `.github/workflows/ci.yml` Step Summary generation to prevent executing backtick Markdown symbols as shell commands.
