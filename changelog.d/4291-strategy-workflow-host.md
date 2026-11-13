### Strategy-discovery host: dispatch surface over the durable workflow host (#4291)

- `startStrategyScreenWorkflow` pins the strategy job identity
  (`strategy-screen:<runId>`) over `startOptionsScreenWorkflow` and
  validates the request's shape before defining anything: panel and
  scan shapes dispatch; goal, manual, and comparison shapes refuse
  synchronously by name (`stage_port_unavailable`, naming the shape's
  home), with no job defined and no workflow instance created.
- `awaitOptionsWorkflowRun` polls the read-back until a hosted run
  reaches a terminal state and returns the terminal view (a failed
  run returns its view with the stage error, it does not throw); a
  run that never settles throws a named
  `options_workflow_run_timeout` carrying the job id and the last
  observed state. It is the vehicle a future sync-leg cutover awaits
  on; no production caller uses it yet.
- The scan shape now runs end to end through the host with scanner
  ports: all eight stages complete under the strategy job, the
  workflow step is the engine's journal, and the shapeReport artifact
  carries the honest no-store receipt (no `persisted` field; the
  persist artifact names the missing store). No production leg moves
  in this slice: every strategy leg is blocked by a named gap
  (#3960 broker selection, #4453 scan-run store + stage queue in the
  residency, universe deps that do not travel) — the sync dispatch
  stays the live path for those legs until their gaps land.
