### Fixed

- **The nightly research job runs on the j-stack engine, always (#5915):** the engine path is the default and ordinary configuration cannot turn it off. The old cutover flag is no longer read; the direct path survives only behind an explicitly named emergency flag (esearch_engine_direct_rollback, default off). On that direct path the dispatcher filled six `completed` stage rows without running an engine stage — a `6/6` report for stages that never existed, with no stage control to retry, pause or cancel. #ceo-aimp
