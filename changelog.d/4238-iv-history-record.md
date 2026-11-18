### Changed

- **IV history collection is a unified-store record (#4238):** the armed `collectIvHistory` alarm is adopted into the unified store as an `internal`-kind record (seventh kind; system origin `iv-history-collection`, record id = alarm id) on the authenticated maintenance path — record-only, nothing is armed or cancelled. The Schedules home lists it as "Scheduled IV collection" with its cadence (system family), its #3394 ledger runs join by schedule id, and pause/resume/delete/trigger/update work through the one management path. #ceo-aimp
