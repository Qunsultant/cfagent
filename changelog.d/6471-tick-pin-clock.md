### Fixed

- Pin the clock in the mesh identity sweep's scheduled-tick describe block (`tests/mesh_identity_sweep_s3_2327.test.ts`): the fire decision reads the live clock, so the "identity header is honoured" pin failed on weekday runs at/after 21:00 UTC (the tick took the fire path instead of the skip path). Fake timers pinned to a weekday noon UTC make the pin deterministic. (#6471)
