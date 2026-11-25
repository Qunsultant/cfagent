### Changed

- **Sharded and per-item stages can be rewound (#6560):** `restartFromStage` now derives its target from the same plan the executor compiles — the first unit's `unitId` and item 0 under `online` pacing — instead of refusing `stage_restart_unaddressable`. A sharded shape with no shard keys keeps the engine's own `job_shards_not_configured` refusal.
