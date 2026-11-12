### Added

- Feed-job timeout bounds are now operator-configurable via env knobs (`FEED_JOB_REFRESH_MS`, `FEED_JOB_FETCH_MS`, `FEED_JOB_CAPTURE_MS`, `FEED_JOB_EXECUTION_MS`); defaults unchanged (30s / 60s / 30s / 240s). A present knob holding a non-positive, non-finite, or non-numeric value is refused by name instead of silently falling back. (#4312)
