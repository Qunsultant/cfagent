### History is an ordering input for OODA structures (#773 b)

- `TrackRecordSlice` now carries `directionAccuracy`, computed from the recorded direction scores only (an unscored family stays `null`, never a guessed 0) — this is the field the structure reorder was written for and never had, so the reorder had silently never run.
- The rule is now one pure function, `orderStructuresByTrackRecord` (`src/services/researchStructureOrdering.ts`): below the block's weak threshold sorts last, above the strong threshold sorts first, and a family under the 10-evaluation bar is neutral.
- The run says what it did: `evaluationFeedback` records each family's accuracy and appends either "History reordered the structures: …" or "History was read but changed no order: …" — the adjustment is visible, not implied.
