### Added

- #764 mas_messages retention lifecycle verification (#2928): cutoff-boundary pin in tests/storage-retention.test.ts — a row exactly at the 90d cutoff survives the nightly pass (mutation-checked: the test fails if the selector uses <= instead of <). Verification record at docs/architecture/security/rsi-infosec-764-retention-verification.md (90d policy, nightly enforcement, per-run STORAGE_RETENTION audit evidence, fail-visible failure paths). No behaviour change: the pass already used strict <; R2 archival-before-delete remains a carried follow-on and #237 is not closed.
