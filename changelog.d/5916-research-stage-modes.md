### Added

- **Per-stage execution modes for the OODA job (#5916):** each of the six stages can override its execution mode per axis (concurrency / pacing / delivery / shape) from one config value, `RESEARCH_STAGE_MODES`, merged onto that stage's node by the definition builder. Unset stages keep the job's mode exactly as before. An unknown stage kind, an unknown axis, a non-string value or invalid JSON refuses by name — a typo never silently falls back to the job mode. #ceo-aimp
