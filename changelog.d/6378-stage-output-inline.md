### A stage's output, inline on the OODA page (#6378)

- Each stage row on the OODA page now has **View output**: the stage's persisted step output renders in place — record lists as tables with the artifact's own headers (first 50 rows / 12 columns, with the remainder named rather than dropped), nested objects as key/value rows, scalars as text.
- The read is the **same** stage read (`GET /research/runs/:runId/stages?includeOutput=<stageId>`), under the same owner scoping: only the stage the operator opened carries its `output`, so six stages' artifacts never ride one page load. No new route, no new store, no second read.
- Honest by construction: a stage with no artifact says so; a zero-row artifact reads "0 rows recorded"; a step that recorded `not_configured` names that verb above the artifact instead of showing an empty table.
- Per-stage bespoke render models (the report row models named in the issue) stay with #6356 — this renders what the engine persisted rather than summarizing on the stage's behalf.
