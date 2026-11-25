### Added

- **`restartFromStage(jobId, nodePath)` (#6552):** rewinds a live, workflow-hosted run to a stage's first step through the platform's own restart, using the step name this engine assigned. Sharded stages, per-item pacing, non-live runs and hosts with no restart channel refuse by name (`stage_restart_unaddressable`, `job_not_running`, `stage_port_unavailable`), and a platform rejection surfaces as `stage_restart_rejected`.
