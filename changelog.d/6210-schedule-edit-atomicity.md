### #6210: make schedule edits atomic — a failed save no longer deletes the schedule

- The screening schedule form's edit save now creates the replacement FIRST and cancels the old schedule only after the create succeeds, so a create refused for a missing account binding leaves the original schedule untouched (previously: cancel first, then create — four saves deleted the only stock schedule).
- `updateUnifiedSchedule` (PUT /api/schedules/:id) rolls the original alarm back if the re-arm throws, so a failed PUT edit also leaves the schedule intact.
- Pinned by `tests/schedule_edit_atomicity_6210.test.ts` (3 tests) and `tests/schedule_edit_client_6210.test.ts` (6 tests).
