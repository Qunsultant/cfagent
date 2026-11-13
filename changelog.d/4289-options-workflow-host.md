### Options screen on the durable workflow host (#4289)

- The options steps compose into the workflow residency's registry
  (`createJobPipelineWorkflowDeps`) and dispatch through the existing
  `JobPipelineWorkflow` — no second engine, no new workflow class, no
  new binding. The resolving steps read the dispatch request back out
  of the stored job definition and rebuild the stage ports per
  invocation (the #4066 control rebuild, now shared in
  `optionsStepPorts.ts`), over a stage storage adapter backed by the
  engine's artifact store, so a resumed run reads earlier stages'
  artifacts from the durable store and a workflow replay re-uses
  journaled step results instead of re-executing stages.
- `startOptionsScreenWorkflow` defines the per-run job
  (`options-screen:<runId>`, or `strategy-screen:<runId>`) in the D1
  residency and creates the workflow instance; the acting login rides
  the definition's raw config beside the request. `readOptionsWorkflowRun`
  surfaces the run's state, per-stage statuses, and the shapeReport
  artifact. Both refuse by name when the residency is not configured.
- Unrebuildable shapes refuse by name through the host: goal
  (`#4290` owns the goal-screen host) and comparison runs refuse
  `stage_port_unavailable`, as do manual-shape shapeReport/deliver
  (the delivery builders need the manual route's `getScreenerAgent`).
  The sync/in-process dispatch is kept for the manual route and the
  goal leg, which cannot move yet; new callers must dispatch through
  the host.
