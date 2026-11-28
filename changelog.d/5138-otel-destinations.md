### Changed

- **Observability destinations now point at Grafana only (#5138):** the Analytics Engine sink and the R2 export are off in `config/otel.json` (owner directions 2026-11-24/25 — no R2 logging, no Analytics Engine logging), console stays on, and Workers Logs capture is raised to full sampling with persistence on (`wrangler.jsonc` observability `head_sampling_rate` 1, `persist` true) so the sign-in RCA lines are recorded. The destination pins in `tests/otel_destinations_5138.test.ts` match the new switches. Part of the observability program (#5080).
