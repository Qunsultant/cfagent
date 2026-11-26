# ADR 0039 — One access point for report bodies

**Status:** accepted (2026-11-26) · **Issue:** #6659 · **Supersedes:** none

## Context

A week of R2 analytics showed ~12,000 failed GETs on `reports/<id>.json`, the same ~40 report ids fetched 200–300 times each, from several callers, with the traffic traced to our own `ai-search-agent` Worker (only script bound to the `screener` bucket, single-region egress).

Two facts made it possible:

1. **The key had one home; the access did not.** `reportBodyR2Key` owns the key shape (`src/services/documentPublish.ts`), but reads happened from `resolveCanonicalReportBody` and its callers (`meshScreenDoor`, `nlqPorts`, `reportDispatch`, `optionsRegenerate`, the reports route), the backfill wrote through `createBlobStore` directly, and the delete path had its own bucket call.
2. **A miss was treated as an event, not a fact.** Every request performed its own GET, so a client polling a report that was never written cost one paid-class GET per tick, forever, with no memory and no bound.

## Decision

**One module owns every report-body operation: `src/services/reportBodyStore.ts`.**

- **Operations:** `read`, `head`, `put`, `remove` — all keyed by report id, optionally with an explicit legacy key so existing rows keep resolving.
- **Policy is externalized, not coded:** `src/config/reportBodyStore.ts` reads `REPORT_BODY_READ_ATTEMPTS`, `REPORT_BODY_RETRY_BACKOFF_MS`, `REPORT_BODY_NEGATIVE_TTL_MS`, `REPORT_BODY_NEGATIVE_MAX_ENTRIES`, clamps each to a sane band, and **falls back to the default on an invalid value** — a typo must not silently disable the protection.
- **Absence is terminal.** A missing object returns `absent` after exactly one GET; it is never retried.
- **Absence is remembered.** A per-isolate negative cache, keyed by report id with a short TTL, makes a polling client cost **one GET per TTL window instead of one per tick**. This is safe because report ids are content-addressed: a body can only appear once written, and a successful write clears the entry.
- **Errors are bounded.** A transient read error is retried within the policy and then reported `unavailable` — a symptom, distinct from the fact `absent`.
- **Every call is measured:** caller, outcome, attempts, whether the answer came from the cache.

Callers migrated in this slice: `resolveCanonicalReportBody` (read), `resolveCanonicalReportBodyWithBackfill` (write), `deleteCanonicalReport` (delete).

## Consequences

- **The storm cannot recur from a new caller**: a new reader that uses the access point inherits the bounds; one that bypasses it is a review defect, and the policy lives in one place.
- **"Absent" and "unavailable" are now different answers**, which is what makes the R2 404 rate a signal again rather than noise.
- **Telemetry archive stays a separate port.** `otelArchive`/`otel-archive/` is a different capability on the same bucket; it follows the same policy contract but is not collapsed into the report-body store. One of everything means one mechanism per capability, not one module for every object.
- **The write path at generation keeps its publish stage** (`publishDocument`'s `r2-body` target) — that is already the single write home; the access point owns the backfill write.

## Alternatives considered

- **Patch each caller** — rejected: seven call sites, seven chances to drift, and the next caller reintroduces the storm.
- **Signal instead of poll** (R2 event → Queue) — right for a reader that must react to a body landing, but it does not remove the need for a bounded read; it is a later improvement on top of this seam.
- **Cache only, no policy** — rejected: a cached miss still costs a GET per TTL, and a transient error would still be unbounded.

## Follow-ups

- `GET /api/ops/reports/:id` — the operator diagnostic (`rowExists`, `inlineBodyLen`, `bodyR2Key`, `r2`) built on this access point, so "why is this report not servable?" needs no deploy.
- Assert the write succeeded at generation and record a named outcome there (issue #6659 scope item 3).
- Key-shape parity between the JSON body and the PDF artifact, pinned by a test.
