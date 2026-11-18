### Added

- `options_copilot_stage_control` now drives stages of workflow-residency
  runs (goal-shape first) through the engine control plane over the D1
  residency stores built from `env.AGENT_DB` — the same record the
  workflow instance drives, with no cross-DO path. The door builds the
  D1 bundle from the turn's env and refuses only when neither the DO's
  SQL handle nor the `AGENT_DB` binding is bound.
- The #4274 goal guard lifts only where the job record resolved over
  the D1 bundle; a goal run whose record lives in the DO stores still
  refuses by name.
- A run carrying a broker stage input resolves its chain source from
  the descriptor through the injected factory (the #3960 residency
  factory at the door), never silently through the turn's default
  client; with no factory bound it refuses by name.
