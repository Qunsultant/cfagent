### Drizzle query observability (#4933)

- All 56 D1 `drizzle()` construction sites now build their db through one shared wiring point, `createDrizzleD1Db` (`src/data/d1QueryLogger.ts`), which times each query and emits statement + duration through the structured-logging seam (`d1_query` events; warn + `slow: true` at or above the threshold).
- Slow-query threshold from externalized config (`d1.query.slowMs` setting / `D1_QUERY_SLOW_MS` env; default 100ms, clamped 0–120000ms). Statement redaction: param values are never logged (count + types only); string literals in statement text are masked.
- Logging only: query results byte-identical, no behavior change. New pin: every `drizzle()` site routes through the shared wiring point.
