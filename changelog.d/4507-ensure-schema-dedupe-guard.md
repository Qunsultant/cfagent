### Ensure schema dedupes legacy duplicate report pairs (#4507)

- The production `ensureSchema` no longer logs and continues without the generation UNIQUE index when legacy duplicate `(user_login, generation_id)` pairs block it: it dedupes the pairs first (newest row survives per pair, the #2863 read rule; NULL pairs never touched), retries the CREATE once, and throws a named error if the schema is still unreconcilable.
- New pin `tests/ensure_schema_dedupe_guard_4507.test.ts` (6 cases) and the updated #2398 test (d); global census adapter count 23 → 25 for the guard's two SELECTs.
