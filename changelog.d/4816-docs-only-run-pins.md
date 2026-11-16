### Fixed
- `#4816`: Updated `.github/workflows/ci.yml` so docs-only PRs and merge-queue runs still execute `fast-gates` (`npm run test:pins` including `neutrality_census_3525`) while skipping the 4 full test shards and preserving 24h tree-dedup.
