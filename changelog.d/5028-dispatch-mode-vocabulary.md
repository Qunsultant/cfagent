### Added

- **Five dispatch modes for job runs (#5028):** `JobRunTrigger` now carries manual, scheduled, triggered (scheduler Run-now), copilot, and autopilot; the ledger vocabulary carries all eight values (the five modes plus worker-cron, async-chain, unknown), and the outcome sink records the run's true mode instead of collapsing new modes to manual.
