### Added

- **One managed access point for report bodies (#6659):** `src/services/reportBodyStore.ts` now owns every read, existence check, backfill write and delete for `reports/<id>.json`. Its policy is externalized (`REPORT_BODY_READ_ATTEMPTS`, `REPORT_BODY_RETRY_BACKOFF_MS`, `REPORT_BODY_NEGATIVE_TTL_MS`, `REPORT_BODY_NEGATIVE_MAX_ENTRIES`), clamped, and falls back to the default on an invalid value. Every call records its caller, outcome, attempts and cache hit. Decision recorded in ADR 0039.

### Fixed

- **A missing report body no longer costs an R2 GET per poll (#6659):** absence is terminal (one GET, no retry) and remembered by report id for a short TTL, so a client polling a report that was never written costs one GET per window instead of one per tick — the ~12,000 failed GETs a week recorded in the issue. A transient read error is now distinguishable from an absent body (`unavailable` vs `absent`) and is retried only within the configured bound.
