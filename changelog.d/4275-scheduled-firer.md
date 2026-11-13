### Scheduled firer routed through the engine panel (#4275)

- The scheduled strategy-discovery firer (`runDiscoveryRequest`) now
  dispatches through the engine-routed panel
  (`runOptionsPanelViaEngineWithAgents`) over its pre-built agents:
  each scheduled screen is a strategy engine job
  (`strategy-screen:<runId>`) with a durable run record when the host
  wires engine SQL, and no scheduled options screen executes outside
  the engine-routed workflow. Snapshot-input mode and feed provenance
  are unchanged (the stored snapshot still replaces the live load
  through the panel's snapshot seam).
- `runPanelWithAgents` is retired by rename to
  `runPanelWithAgentsRetired4275` with a named successor, recorded in
  the deprecation ledger; no production caller remains.
