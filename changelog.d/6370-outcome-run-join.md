### The outcome→run join reads a completed research run as completed (#6370)

- The research canonical body now carries the facts the join reads: `success` (already), plus `trigger` and `userLogin` — stamped at persist time, so a completed manual run can no longer read "Not recorded by the source".
- `runSummaryFromReport` reads the recorded trigger (with the nested body as fallback) and exposes the row owner; the report-only run renders that owner as "Triggered by" instead of a hardwired `null`, and its outputs carry the normalised status verb instead of `{ "status": null }`.
- A run with a data refusal still maps to `failed`; legacy rows that recorded nothing keep an honest `null`.
