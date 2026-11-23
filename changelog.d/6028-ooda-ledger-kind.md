### Fixed

- **An OODA research run is now a Pipeline row in the run ledger (#6028, sub-issue #6201):** the engine records the definition's root kind as the operation (`research`), which matched no rule in `RUN_LEDGER_KIND_RULES`, so every OODA run classified as `other` and the Pipeline filter found nothing. The existing `pipeline` rule now matches `research` exactly and the `research.` prefix (dotted, so a future `researching.*` family is not swallowed) — no new kind, no new label, and every existing classification is unchanged. Pins in `tests/ooda_ledger_kind_6028.test.ts`. #CAIO-quns
