### Added

- **Units inventory and registration (Qunsultant/cfagent#4178):** the capability registry gains the `enrich` and `analyze` stages plus 19 entries (18 shipped, 1 planned) covering the canonical flow's provider adapters, per-family dataset stores, and the ScheduledAgent executors; `src/agentic/unitDrivers.ts` binds every shipped canonical-flow entry to its executable driver, pinned by `tests/unit_drivers_4178.test.ts` in both directions (entry resolves to a driver; driver resolves to a registry entry).
