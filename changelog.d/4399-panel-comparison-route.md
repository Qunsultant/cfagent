### Panel comparison route threaded with the engine comparison job (#4399)

- `POST /trading/options/comparison` now dispatches through the
  engine comparison job (`comparison:<runId>`, one `comparison.run`
  step) over the host DO's SQL handle when available — the #4276
  pattern the NLQ comparison leg already follows: the run has a
  durable pipeline record, the minted run id is shared by the engine
  job and the artifact, and per-stage control resolves the run
  (execution ops refuse `stage_port_unavailable` by name, as for
  NLQ-dispatched comparisons). Without a usable SQL handle the core
  executes directly (the #4069 accepted-absent discipline). The
  route's response envelope and error behavior are unchanged.
