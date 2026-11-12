### Options entry points routed through the engine (#4068)

- All 9 `runOptionsScreenWorkflow` call sites now drive the engine-routed
  workflow (`runOptionsScreenViaEngine`); no direct composer call remains
  in production code. The four bypasses are routed too (broker screen
  endpoint, `execute()` screen + opportunities cases, the two
  `runPanelPipeline` call sites) and the bypass functions are retired by
  rename with named successors (`runPanelPipelineRetired4068`,
  `screenOptionsWithSourceRetired4068`, `screenContractsRetired4068`,
  `scanOpportunitiesRetired4068`), recorded in the deprecation ledger.
- The broker screen endpoint now fails closed with a 401 when the
  `x-user-login` header is absent (a screen that writes a run record
  needs an owner). Paid gates unchanged.
- Known remaining direct panel call: `runPanelWithAgents` at the scheduled
  firer (`scheduledTasks.ts:4183`) — follow-up, needs the engine panel
  helper to accept pre-built agents or universe deps.
