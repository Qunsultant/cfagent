### Added

- **Durable event-wait stage (#3955):** a `wait.event` step waits for one named event and resumes on it, with an optional declared `timeoutMs` whose expiry resolves as `{outcome: "timeout"}` — a declared outcome the job can branch on, never a failed run.
- **Event delivery on the control plane (#3955):** `JobPipelineControl.sendEvent(jobId, event, payload)` reaches the run's own workflow instance through the one instance seam; refusals are coded (`job_not_running`, `stage_port_unavailable`) instead of silent drops.
- **`sendManagedWorkflowEvent` (#3955):** the workflow-instance seam now addresses instances for delivery as well as for starts, refusing `send_event_unsupported` when an instance cannot receive events.

### Changed

- **A wait bounds itself (#3955):** a stage that contains a `wait.event` step is bounded by the wait declaration (or the host maximum), not the stage deadline — a 600s stage default would otherwise kill an approval wait at ten minutes.

- **The platform's wait timeout is a declared outcome (#3955):** `waitForWorkflowEvent` / `isWorkflowWaitTimeout` classify the `step.waitForEvent` timeout throw once, so it becomes `{outcome: "timeout"}` while every other platform error still fails the run.
- **The workflow residency wires both halves (#3955):** `JobPipelineWorkflow` builds the wait channel from its own step object and the delivery channel from its `JOB_PIPELINE_WORKFLOW` binding; a host that wires neither keeps the refusal by name.
