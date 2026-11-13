### Changed

- **The admin queue is organised into sub-tabs (#4329 S5, #4334):** Queue dump · Cancel all · Wipe · Recreate Track 1, from `src/config/scheduleSections.ts`, each a stable deep link (`?tab=schedules&view=queue&section=<id>`) with retained panels, so a previewed result survives a section switch.
- **Queue rows present like the schedules tab:** the dump resolves the shared column vocabulary (Schedule · Schedule ID · Cadence · Scope · Status) with the schedules list's own naming and cadence sentences, and the Track 1 plan table uses the same cell shapes.
- **The platform-admin gate is unchanged:** the same server probe, the same refusal, and every section still lives inside the gated panel — no action moved out from behind it. #autoclaw-001
