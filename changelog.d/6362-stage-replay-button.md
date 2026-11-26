### Added

- **Per-stage replay on the OODA page (#6362):** a completed or failed research stage now offers **Replay** beside Re-run — that stage of the run on screen executes again as its own new engine run, from the run's recorded input, and the confirmation names the new run id. It calls the existing research stage route with the new `replay` op; no new endpoint, no second control system.

### Fixed

- **A recorded `null` hand-off is input, not a missing one (#6362):** a stage whose predecessor genuinely produced `null` (the research chain's noop root) could not be re-run or replayed at all — `stage_input_missing` fired on a value that *was* recorded. Presence is now answered by the artifact key, so the first stage of a chain replays like any other, and the research re-run route no longer falls back to a whole-job run for that case.
- **A replay never rides the wrapper's default rebuild (#6362, #6398 class):** when no definition is recorded for the run, other stage ops rebuild one from today's defaults (#6401); a replay now refuses by name instead, because reproducing a configuration the run never executed is not a replay.
