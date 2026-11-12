### Added

- **Scheduling consolidation Slice #3394 — internal-callback firing records (#3121):** the B-T2-07 named gap is closed as a joinability proof — the recording itself landed in #3788 (`recordScheduleCallbackRun` wrappers on the four internal-only callbacks); #3394 proves each SDK firing joins to its schedule (scheduleId = schedule id, explicit nulls, manual trigger exactly once) with pins 3394-P01–P04. Out of scope, filed not dropped: `sendScheduledReminder` SDK firings still leave no per-run record (#4186).
