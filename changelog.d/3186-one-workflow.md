### Screens

- **One workflow for all four families — stocks, options, strategy, goal** — every options screen (goal legs, broker, scheduled, manual, NLQ, strategy) now runs through a single staged producer/consumer pipeline with pub/sub persistence, checkpointing, and AOP, instead of the three inline plan sites and direct engine calls (Qunsultant/cfagent#3186).
- **Broker neutral and model-agnostic execution** — the staged pipeline dynamically adapts to any configured tenant broker (Alpaca, E*Trade) and execution model (LIVE, Paper/SANDBOX), normalizing environment configurations and platform chain sources (#3186).
- **Checkpoint/resume proof** — a run stopped mid-pipeline resumes at its next unclaimed stage over the durable `mas_stage_claims` store, and a failed stage's claim is released for retry (Qunsultant/cfagent#3186).
- **15-factor audit + GoF/GRASP/SOLID review** — factor-by-factor evidence and a design review against the #488 anchor, both recorded under `docs/architecture/standards/` (Qunsultant/cfagent#3186).
