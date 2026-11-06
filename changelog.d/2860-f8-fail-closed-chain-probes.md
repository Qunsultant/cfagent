### Fixed

- **Sharded-chain submission gate is fail-closed (#2860, Factor 8):** the scheduled-chain lock probe and the active-chain probe in `ScheduledTasksService.autonomousMarketScreenSharded` no longer proceed ungated when they cannot answer — an unanswerable probe now refuses the submission with the skipped shape (`skippedReason: "gate-unavailable"`, audited as `screener.sharded_chain_gate_unavailable`) instead of submitting a possibly-duplicate chain. Per-owner locking still gates execution where the probe answers (`already-running`, unchanged). #clo-arsi
