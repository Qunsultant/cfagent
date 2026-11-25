### Added

- **Instance control on the one seam (#5783):** `pauseManagedWorkflowInstance`, `resumeManagedWorkflowInstance`, `terminateManagedWorkflowInstance` and `restartManagedWorkflowInstance` sit beside `startManagedWorkflowInstance` and refuse `instance_control_unsupported` when an instance shape cannot apply the control.

### Changed

- **Cancel stops the durable host (#5783):** `cancelJob` terminates a stamped workflow instance (with `rollback: false` — the recorded choice, since no step registers a rollback handler yet) and settles the run itself, so a run parked in a durable wait can actually be stopped instead of sitting "running" forever.
- **Pause and restart stay engine-side, with the reason recorded (#5783):** a platform pause would freeze the flow body before the engine's boundary check while a resume starts a new executor, and a platform restart targets a step name while a rerun is a control op over the engine's artifacts — wiring either would deadlock or double-run.
