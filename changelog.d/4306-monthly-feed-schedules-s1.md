### Added

- Feed-job schedules are now monthly: `FEED_JOB_DEFAULTS` cadence 60 → 43200 minutes (exactly the Agents SDK 30-day interval cap) with the staleness threshold moving 180 → 44640 minutes, so datasets stay fresh for the full month instead of reading STALE after 3 hours. Per-job stored schedules are unchanged by this change and are rewritten by the audited schedule route as the follow-up data step. (#4306)
