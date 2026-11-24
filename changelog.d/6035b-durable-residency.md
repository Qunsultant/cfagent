### The OODA run dispatches through the job-pipeline workflow residency (#6035 b)

- `dispatchResearchEngineRun` now defines the same `research:<runId>` job in the durable residency and starts one `JobPipelineWorkflow` instance (attach-to-in-flight on re-dispatch), then awaits settlement — each stage node is a durable step, so a restart resumes at the last completed stage.
- The in-process sync invocation remains the explicit local/test path; an unbound deployment keeps today's behaviour.
- `stageVisibility` is read from the same job view shape on both paths, and `durableResidency` / `workflowInstanceId` say which path ran.
