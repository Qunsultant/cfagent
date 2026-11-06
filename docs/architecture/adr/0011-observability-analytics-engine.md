# ADR 0011: Aspect-oriented observability to Analytics Engine

- Status: Accepted
- Issue: #1743 (sub-issue of #1736, item 7)
- Supersedes: nothing (consumes ADR 0003 messaging, ADR 0009 telemetry hooks)
- Related: `docs/architecture/code/aop-fit-gap-analysis.md` (625-file audit, 69.3/100 → 93.5/100 target); screener doc §10 join-point inventory (routes, agent firing paths, projection writers)

## Context

Logging was ad hoc per call site (console lines, a single-key
IAAA audit log) with no central stream: no queryable,
cross-cutting view of system behavior, and adding observability
to a new path meant editing that path. The AOP audit's
Foundation-layer gaps are the slice's brief: 388 raw
`console.log`/`console.error` calls vs 12 aspect log calls
(97% unwrapped), no W3C traceparent propagation across
queue/workflow boundaries, metrics un-aggregated across the
Workers edge, correlation ids generated at entry but not
propagated through async context. Re-verified at slice start
(main `3820f77`): 386 raw console calls, 435 raw throws, 340
direct env accesses, 8 aspect call sites outside the aspect
modules — the doc's counts drifted, the shape did not.

## Decision

Port-first observability in `src/observability/`, behind one
port with two adapters and a conformance suite run unchanged
against both:

- **Port** (`observabilityPorts.ts`): one event schema, W3C
  trace context, key-based redaction, envelope folding, and
  the never-throw sink contract. Domain code never imports a
  provider SDK.
- **Cloudflare Analytics Engine adapter**
  (`cfAnalyticsEngineAdapter.ts`): maps events to AE
  datapoints. Exactly ONE index — the docs state a datapoint
  with multiple indexes is not recorded, and the SQL table
  exposes only `index1` — so the index is the tenant (the
  sampling key: one tenant's flood samples only that
  tenant). Doubles `[durationMs, count]`; blobs `[type,
  level, operation, runId, sessionRef, traceId, errorCode,
  fieldsJson]`. `writeDataPoint` is synchronous and
  runtime-buffered — the sink never awaits a network
  round-trip.
- **In-memory adapter** (`inMemoryObservabilityAdapter.ts`):
  test + independence proof. Never a production fallback:
  unbound production degrades to the console sink, not to a
  lie about durability.
- **Composition root** (`createObservabilityPorts.ts`):
  `createObservabilitySink(env)` — AE adapter (Safe-wrapped)
  when `OBSERVABILITY` is bound, console sink otherwise.
  Never null: absence is the normal degradation, not an error.
- **Foundation interceptors** (`aspects.ts`):
  `withObservability` (one completion event with duration, or
  one error event with a code — never a message; result and
  error pass through untouched) and
  `withRequestObservability` (the HTTP boundary: honors an
  incoming traceparent or starts a fresh trace, times the
  request, returns the response unchanged — no injected
  headers, so response-identity pins cannot break).

## Scope boundary (explicit)

This slice owns the Foundation layer ONLY: logging, tracing,
metrics, correlation streamed to Analytics Engine. It
INCLUDES: traceparent propagation contracts (envelope
extension, workflow command field, ingress + aspect paths);
the consumer-side continuation (folding preserves an
envelope's traceparent); the server-boot sink wiring #1741
named (gateway turn emit, telemetry decision emit,
evaluateRun realization emit, delivery-queue tap).

It EXCLUDES (follow-ups, not absorbed): the AOP doc's Phases
2–4 (security/tenancy injection → #1744/IAAA/#1717; guardrails
/ cost rollout → #1742 and later slices; approval/audit
automation → other slices); error-catalog conversion beyond
what observability needs (the top-100-throws item);
tenant-isolation enforcement (§1 identity is CISO #945 —
tenant context is consumed, never built here); legacy aspect
consolidation (the two old modules keep serving their call
sites; folding them into re-export shims is a follow-up, not
a churn event); producer-side envelope stamping and
service-layer workflow stamping (those call sites carry no
request context today — the contract lands, a fake producer
does not); breaker-registry emit wiring (the shared registry
is lazily created without opts — first caller wins, so a
registry emit seam is its own change); judge gateway emit
(same one-line pattern as the orchestrator turn, deferred
for reviewability); SQL-side metric aggregation if volume
grows (a #1742 follow-up); a dashboard UI (queries below are
the queryable surface; the Cloudflare AE explorer is the
dashboard until a UI slice lands).

## Event schema and stream discipline

Every event carries tenant/run/session scope fields (null
when the boundary has no scope — never fabricated). Session
scope rides as `sessionRef`, a truncated FNV-1a hash
correlator, never the session id. Stream payloads carry
counts and ids only. Envelope folding is a WHITELIST:
`telemetry.*` (realization counts, calibration counts —
promptKey, sliceKey/thesis text, and appliedBy identities
dropped even when present), `breaker.state_changed`,
`gateway.*` (model, attempts, duration), `retrieval.completed`
(counts only; the leg carries no tenant context, so null is
honest scope), `screener.completed/failed` (delivery id,
ownerLogin as tenant; error messages dropped). Unknown types
and malformed data fold to null, never throw.

Realization emission is at-least-once with deterministic ids
(`telemetry-realization:<tenant>:<outcomeId>`): the
projection emits per row only when `recorded > 0`, so a pure
re-projection emits nothing, but a partially-new batch may
re-emit an already-seen row. Treat AE realization counts as
approximate — the exact store is D1
`agent_thesis_realizations` (idempotency-keyed); the stream
is the queryable behavior view, not the ledger.

## Production wiring (what flows at launch)

| Source | Path | Content |
|---|---|---|
| HTTP requests | `server.ts` fetch wrapper | `http.request` (method, status, duration, trace) |
| Screener delivery | queue() passive tap (never owns ack/retry) | `screener.completed/failed` folded |
| Actor turn gateway | orchestrator `createActorTurnRunner` emit | `gateway.*` counts |
| Calibration apply | telemetry decision-action route emit | `telemetry.calibration_applied` |
| EvaluateRun projection | research-agent evaluateRun block emit | `telemetry.realization_recorded` |

No new routes (no IAAA catalog change), no D1 tables (no
migration, no retention-contract change — AE retention is
provider-managed), IAAA audit trail untouched.

## Queryable surface (Analytics Engine SQL, dataset `observability`)

Column map: `index1` = tenant, `blob1` = type, `blob2` =
level, `blob3` = operation, `double1` = durationMs,
`double2` = count. Counts use `SUM(_sample_interval)`,
not `COUNT()` — at high volumes AE samples by index, and
the sample interval is the correction (per the AE SQL docs).

Error counts by type:

```sql
SELECT blob1 AS type, SUM(_sample_interval) AS errors
FROM observability WHERE blob2 = 'error'
GROUP BY type ORDER BY errors DESC
```

Latency by operation (sampling-aware average):

```sql
SELECT blob3 AS operation, SUM(_sample_interval) AS n,
  SUM(_sample_interval * double1) / SUM(_sample_interval) AS avgMs,
  MAX(double1) AS maxMs
FROM observability GROUP BY operation ORDER BY n DESC
```

Retry/fallback counts (gateway fallback + breaker trips):

```sql
SELECT blob1 AS type, SUM(_sample_interval) AS n
FROM observability
WHERE blob1 IN ('gateway.fallback', 'breaker.state_changed')
GROUP BY blob1
```

## Activation (no owner step beyond deploy)

The binding is declared in `wrangler.jsonc`; per the AE
docs, the dataset table is created automatically on first
write — no dashboard dataset creation is needed, and no id
is invented or written to `wrangler.jsonc`. Until the first
deploy writes, the sink degrades to local logging;
requests are unaffected either way. Confirm after deploy
with `SHOW TABLES` / a query against `observability` on
the AE SQL API (a follow-up verification, not this PR's
gate — production stream content lands with traffic).

## Rollback

Revert the PR: the fetch wrapper, queue tap, and emit
wirings disappear, and behavior falls back to the pre-change
path (console logging, no stream). No data migration to undo.

## Amendments

### 2026-11-06 — #3515 S2: §2.2 mandatory attributes on the datapoint

The blob order gains the four §2.2 attributes: blobs are now
`[type, level, operation, runId, sessionRef, traceId, errorCode,
actorId, agentId, component, timestampIso, fieldsJson]` (12 blobs,
under the 20-blob cap). Positions 1–7 are unchanged; the fields
JSON moves from blob 8 to blob 12. The event schema gains the same
four fields (`actorId` / `agentId` / `component` nullable,
`timestampIso` derived from `timestampMs`).
