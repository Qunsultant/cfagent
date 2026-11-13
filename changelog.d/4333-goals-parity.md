### Changed

- **The goals tab matches the schedules tab (#4329 S4, #4333):** goals render as one row each in a table — the schedules list's identity columns (schedule, id, cadence) plus the goal's own (operation, budget, last run, provenance), with Trigger Now, Pause/Resume and Delete on the row. Both lists resolve their columns from one configured vocabulary (`src/config/scheduleRowModes.ts`), so "the same columns plus its own" is a property of the configuration rather than a promise two files repeat.
- **The goals page is sub-tabbed:** Goals · Add goal · Resource goals · Seed built-in goals · Ticks · Goal runs, from `src/config/scheduleSections.ts`, each with a stable deep link (`?tab=schedules&view=goals&section=<id>`) and retained panels, so an in-flight form survives a section switch.
- **The Add-goal form follows the schedules editor:** labelled fields with hints, the catalog-driven operation select, the built-in goal picker, the delegation contract, and the submit as the form's last row.
- **Goal runs are the ledger's:** the Goal runs section reports what is recorded and hands the reader to `?tab=schedules&view=runs&kind=goal`, instead of keeping a second run list on the page.
- The destructive action is **Delete** on both tabs, matching the list's word for it. #autoclaw-001
