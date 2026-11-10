### Changed

- **Lint adopted as a ratchet (#3926):** `eslint.config.mjs` enables defect-class rules only — never style — and `scripts/lint-changed.mjs` lints **only the files a PR changes**, wired into `Fast gates`. A new defect cannot land, and no untouched legacy file can block a PR. The measured backlog at adoption is 31 findings across 23 files (`npm run lint:audit`), left for a dedicated pay-down slice.
- **Coverage adopted as a report, not a gate (#3926):** shard 1 runs with the v8 provider and uploads a `coverage-shard-1` artifact. It is explicitly partial (only what shard 1 executed) and threshold-free until a baseline exists; the merged whole-suite report is the follow-up.
- **The rule for both (#3926):** a gate may never fail a PR for code the PR did not touch — ratchet first, threshold later, baseline recorded in between.
