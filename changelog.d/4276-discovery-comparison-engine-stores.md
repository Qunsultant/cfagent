### Discovery / comparison legs threaded with engine stores (#4276)

- The discovery leg now threads engine stores from the NLQ turn
  (`engineSql`) through `DiscoveryRunRequest` into each expression's
  engine-routed panel run: a discovery run's panel expressions are
  strategy engine jobs (`strategy-screen:<runId>`) with durable run
  records when the host wires engine SQL, addressable by per-stage
  control. Ranking semantics are unchanged.
- The three-way comparison leg now dispatches as a single-step engine
  job (`comparison:<runId>`, one `comparison.run` step) over the
  caller's engine stores when threaded: the run has a durable
  pipeline record, and the minted run id is shared by the engine job
  and the artifact. Without engine stores the core executes directly
  (the #4069 accepted-absent discipline). Comparison semantics are
  unchanged — the engine path passes the core its identical inputs.
- Per-stage control resolves `comparison:<runId>` jobs and decodes
  the `comparison` request shape: execution ops refuse
  `stage_port_unavailable` by name (a single-step job has no stage
  ports) and stop / cancel refuse the engine's
  `stage_vocabulary_unknown` (no stage node exists).
