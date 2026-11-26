### Added

- **Per-stage replay of a past run (#6400):** `replayStage(jobId, runId, stage)` mints a new `kind: "replay"` run that executes ONE stage of a settled run — on that run's recorded definition version, from that stage's recorded hand-off. The stages after it do not re-execute, and a node that owns downstream stages refuses by name (`replay_stage_composite`) with the stages that can be replayed instead. Carried by the existing `POST /api/jobs/:id/runs/:runId/replay?stage=job:2`, so the surface gains a selector, not a second endpoint.

### Fixed

- **A stage action feeds the stage what the run fed it (#6400):** the recorded-input read now follows the engine's own sequencing — child i>0 of a sequential parent consumes child i-1's hand-off, not the parent's — so re-running or replaying a later chain stage runs from the same input the run did.
