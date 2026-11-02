# Observability

Issue #257 (Assessment P1, part of #143). Two complementary telemetry
channels; neither duplicates the other.

## 1. Workers Logs (platform invocation logs)

Configured explicitly in `wrangler.jsonc` under `observability.logs`:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "invocation_logs": true, "head_sampling_rate": 1 }
}
```

- Captures one log per Worker invocation: request/response metadata plus
  `console.*` output. View under **Cloudflare dashboard > Observability >
  Logs** after a deploy (a config change requires redeploy to take effect).
- `head_sampling_rate: 1` = 100% of invocations sampled.
- No external destinations are configured: no OpenTelemetry `destinations`
  block is present because no destination exists in the dashboard. Adding
  one requires a dashboard-side destination first, then the names go here.

## 2. `mas_events` — structured audit sink (SQLite, per-tenant)

Schema: `src/orm/index.ts:462`
(`id, session_id, type, agent, payload, created_at`). Writes are best-effort
and never fail the operation they instrument. Verified writers:

| Writer | Type values | Where |
|---|---|---|
| Orchestrator routing/jobs | varies | `src/agents/orchestrator.ts` (`audit()`) |
| Scheduled tasks | varies | `src/services/scheduledTasks.ts` |
| Storage retention pass | `storage.retention` (per-run summary) | `src/security/storageRetention.ts` (issue #255) |
| TradingView webhook | provider event | `src/services/tradingWebhooks.ts` (`processTradingViewAlert`) |
| E*TRADE broker webhook | `ETRADE_<eventType>` | `src/services/tradingWebhooks.ts` (`processETradeBrokerWebhook`) |
| NLQ execution seam | `nlq.executed` / `nlq.error` | `src/agents/nlq.ts` (`auditNlqExecution`, issue #257) — one row per execution; payload carries domain/count/duration/source only, never the raw query text |
| Agent scheduling actions | `schedule.created` / `schedule.cancelled` | `src/agents/nlq.ts` (`executeSchedulingAction`) |

Query the sink via the orchestrator's `query_table_data` operation or the
MCP observability tooling (`src/mcp/commands.ts`).

## 3. Free-tier budgets (issue #329)

The plan this Worker is on has **two 100,000/day ceilings that are spent the
same way**: one Workers request, one KV read per request. They fail hard, not
softly, and reset at **00:00 UTC**.

| Resource | Free tier | On exhaustion |
| --- | --- | --- |
| Worker requests | 100,000 / day | 429 at the edge |
| KV reads | 100,000 / day | every `get()` throws |
| KV writes / deletes / lists | 1,000 / day each | the operation throws |
| KV storage | 1 GB | writes fail |

**Where state lives now.** Sessions, E*TRADE credentials and the x402 replay
guard are in the `SessionStore` Durable Object (`src/security/sessionStore.ts`),
addressed through `createStoreKv` / `consumeStoreKey`. KV is a migration source
only, and `SESSIONS_KV_FALLBACK=off` switches even that off. The DO has no daily
read cap; its cost is one request per operation, so the same "call it less"
instinct still applies.

**Rules**

1. **No new KV read on a per-request path.** New hot-path state belongs in the
   DO. KV is for cold, migration-shaped data.
2. **Never poll KV to measure KV.** Dashboard and `wrangler kv` operations count
   against the same budget; a monitor that reads KV spends what it measures.
3. **Alert on level *and* rate.** 50% plus a rate-of-change signal; hourly
   75/90% checks leave too few observations between "fine" and 429.
4. **Treat quota errors as degraded, not fatal.** `createResilientKv` turns them
   into a miss behind a breaker, and `withErrorBoundary` converts anything
   escaped into a 503/500 — the 1101 path from issue #329 is closed by those two,
   not by the quota never running out.

**What "normal" costs.** After #418 an idle dashboard tab is ~5,760 requests/day
(20 s `/api/jobs` when idle, 60 s `/api/screener/latest`, both paused while
hidden), so the request budget holds ~17 concurrently open tabs. A regression
here — a new 4 s poller, a missing `visibilityState` gate — is the most likely
cause of a quota alert, and it shows up as request volume, not KV volume.

## 4. SessionStore data-plane records (issue #910) — evaluating the #789 sharding triggers

Every op against the SessionStore Durable Object emits exactly one
structured record from the client funnel in `src/security/durableKv.ts`
(sink: `src/security/storeMetrics.ts`). The record is a bare JSON
`console.log` line, so Workers Logs (§1, `head_sampling_rate: 1` — nothing
is sampled away) lifts the fields out of the message and no free-text
parsing is needed:

```json
{"event":"store_op","v":1,"ns":"sessions","op":"get","instance":"kv","outcome":"ok","latencyMs":3,"ts":1760000000000}
```

| Field | Meaning |
| --- | --- |
| `ns` | Bucket: `sessions`, `etrade`, `api_keys`, `payments` |
| `op` | `get` / `put` / `delete` / `consume` / `list` |
| `instance` | DO instance addressed (`kv` — the single instance #789 is about) |
| `outcome` | `ok` (store answered per contract) · `miss` (`get` found nothing — **not** a failure) · `failed` (non-200 incl. platform *overloaded*, exception, or the 2,000 ms client timeout; `httpStatus` is present for the non-200 case) · `unavailable` (no `SESSION_STORE` binding, op never attempted) |
| `latencyMs` | Client-observed round-trip latency (0 when `unavailable`) |

Emission is best-effort and cannot fail the op it observes (the sink is
isolated; pinned by `tests/store_op_metrics.test.ts`), and it adds no store
round-trip. Records are client-side by design: a server-side counter inside
the DO could never see the timeouts and overload rejections that trigger T2
exists to catch, because those requests never land.

**Evaluating the #789 triggers.** Export the matching records (Workers
Logs → filter on the structured field `event` = `store_op`, or a Logpush
job on the same field) as newline-delimited JSON, then:

T2 — failures >0.1% of ops in 24 h (per bucket/op, and overall):

```bash
# per bucket/op failure rate over the exported window
jq -s 'group_by([.ns, .op]) | map({
  ns: .[0].ns, op: .[0].op, ops: length,
  failed: (map(select(.outcome == "failed" or .outcome == "unavailable")) | length)
} | . + {failure_rate: (.failed / .ops)})' store_ops.ndjson

# T2 fires when this overall 24 h rate exceeds 0.001
jq -s '{ops: length,
        failed: (map(select(.outcome == "failed" or .outcome == "unavailable")) | length)}
       | . + {failure_rate: (.failed / .ops)}' store_ops.ndjson
```

T1 — >250 ops/s sustained, or >500 ops/s averaged over an hour, on the
`kv` instance:

```bash
# per-minute rate: T1 (sustained) fires on any run of >=5 consecutive
# minutes each above 250 ops/s
jq -s 'map(select(.instance == "kv")) | group_by(.ts / 60000 | floor)
       | map({minute_epoch: ((.[0].ts / 60000 | floor) * 60),
              ops: length, ops_per_sec: (length / 60)})
       | map(select(.ops_per_sec > 250))' store_ops.ndjson

# per-hour rate: T1 fires on any hour above 500 ops/s
jq -s 'map(select(.instance == "kv")) | group_by(.ts / 3600000 | floor)
       | map({hour_epoch: ((.[0].ts / 3600000 | floor) * 3600),
              ops: length, ops_per_sec: (length / 3600)})
       | map(select(.ops_per_sec > 500))' store_ops.ndjson
```

Latency sanity (a rising p95 at flat volume is the early-warning shape of
a store under pressure, before either trigger fires):

```bash
jq -s 'group_by([.ns, .op]) | map({ns: .[0].ns, op: .[0].op, n: length,
  p95_latency_ms: (map(.latencyMs) | sort | .[((length * 0.95 | floor) - 1)])})' store_ops.ndjson
```

Volume note: one line per op (~130 bytes). At the #789-measured load
(≪5 ops/s) this is noise-level; if the store ever approaches T1 rates the
lines themselves become the evidence, and in-isolate aggregation behind
the same sink seam is the documented next step — the record shape above is
the contract either way.

## 5. Mesh traces — the trace spine's read surface (issue #2000, Phase 5 slice 3)

One trace spine across doors, workflows, and agents: the W3C trace id
(#1743) minted or continued at ingress, carried on the messaging
envelope and on the workflow command (`WorkflowJobCommand.traceparent`),
and recorded hop by hop into the D1 hop store
(`agent_mesh_trace_hops`, via `meshTraceStoreForEnv` — AGENT_DB bound,
else a per-isolate in-memory store). Every recorded hop is ALSO
forwarded to the #1743 stream as a `mesh.trace.hop` event (the
sink-forwarding store decorator), so the trace is visible both as
rows and as stream events. Workflow step spans are deterministic
(`(jobId, operation)`), so a durable replay re-records the identical
span and the store's conflict rule converges it instead of duplicating.

**Read route — `GET /api/traces?traceId=`** (any signed-in user).
Before this slice no route exposed the hop store; the assembly lived
only behind the MCP `agentdb.trace.get` command. The route returns the
assembly: ordered hops (recorded hops + projection rows folded in),
named breaks, and the mapped jobIds. Decision order: 401 (no session)
→ 405 (non-GET) → 400 (missing/malformed traceId — refused, never
normalized into a lookup) → 503 (AGENT_DB unbound: the durable hop
record requires it, and isolate-local in-memory hops are never served
as a trace) → 404 (no hops survive the tenant filter) → 200.
Tenancy mirrors the MCP read surface: hops recorded under a DIFFERENT
tenant are excluded before assembly; a hop whose tenant is null — an
ingress boundary with no scope — stays visible, since it carries no
tenant material. A trace from another tenant reads as 404 (no
existence leak). The route writes nothing and never fails a run.

**Analytics Engine aggregation.** The `observability` dataset carries
one datapoint per hop event. Blob positions follow
`src/observability/cfAnalyticsEngineAdapter.ts`: blob1 = event type,
blob3 = operation, blob4 = runId, blob6 = traceId, blob8 = fields JSON
(redacted). Dashboard queries over the dataset:

```sql
-- Hops per trace: which runs left the most spans
SELECT blob6 AS traceId, count() AS hops
FROM observability
WHERE blob1 = 'mesh.trace.hop'
GROUP BY blob6 ORDER BY hops DESC LIMIT 50
```

```sql
-- Hops per operation: where the trace volume concentrates
SELECT blob3 AS operation, count() AS hops
FROM observability
WHERE blob1 = 'mesh.trace.hop'
GROUP BY blob3 ORDER BY hops DESC
```

Break detection (a missing step, a missing projection leg) is NOT an
AE query: breaks are computed by the assembly in the route, which sees
the hop kinds and the projection rows together. AE gives volume and
shape; the route gives completeness.

**What the spine does NOT yet cover (honest gaps, not silent ones).**
Service-layer emissions inside a step do not carry the run's trace id:
service call sites carry no request context, so an observability event
emitted from inside a step folds under its own correlation/id, not
under the run's trace. Threading trace context through the service
layer needs orchestrator-door signature changes (an orchestrator.ts
budget decision) and is a follow-up, not this slice. The payment
workflow likewise has no traceparent field and emits no hops yet;
wiring it is a follow-up slice (the saga workflow is out of this
slice's scope by program boundary). The trace spine today covers the
screener workflow (door workflow-start + every step including
fan-out) and the trade workflow.

**Production proof — PENDING the owner run.** The mechanism is
verified by tests; a real staged run has not yet proven it end to
end. The owner run files this record (same shape as the #2129 live
proof):

```text
Staged run jobId:  ________________________
Trace id (D1 console: SELECT DISTINCT trace_id FROM agent_mesh_trace_hops
  WHERE job_id = '<run jobId>'):  ________________________________
GET /api/traces?traceId=<id> → status: ___  hops observed: ___
  operations seen (expect, for a goal run: announce, fan-out-batch-*,
  execute-goal-screen, store-shard, deliver-shard, project-shard,
  project-final, plus the door's workflow-start):  ________________
  breaks reported (expect none for a complete run):  ______________
```

Until that record lands, the slice's acceptance reads: mechanism
verified, production proof PENDING.

## Retention honesty (issue #257)

UI copy must advertise only enforced retention. What is actually enforced:

- `mas_messages`: nightly pruning pass, window default 90 days,
  configurable via `MAS_MESSAGES_RETENTION_DAYS` (`<=0` disables).
  See `src/security/storageRetention.ts` (issue #255).
- `mas_events`: append-only audit ledger. No pruning is enforced; it retains
  full history until R2 archival lands (follow-on — no bucket exists yet).
  Do not advertise a retention window for the ledger.

## Resource event aggregation (#1819)

Phase 5 slice 5 (#2000): the resource event as a #1743 type. The
measurement already existed (`src/telemetry/resourceUsagePorts.ts`
events, `bucketTotals` aggregation, the D1 `resource_sql_ops`
projection and daily rollups); what was missing was the *event* in
the stream: the fold case, the cardinality guard, and the
aggregation treatment. The direct adapter path
(`resourceUsageObservabilityAdapter`, which converts typed
`ResourceUsageEvent`s straight to `ObservabilityEvent`s) is
unchanged — this slice covers the envelope ingestion boundary
(`writeEnvelopeToSink`, e.g. the Q1 consumer path in `server.ts`),
where a producer envelope may carry anything.

### Fold contract (`resource.sql_op`, `src/observability/observabilityPorts.ts`)

Whitelist only. Admitted fields: `ns`, `op`, `rowsRead`,
`rowsWritten`, `caller`, `trigger`, `statement`. Scope:
`tenantId`, `runId`, `sessionRef` (guarded, see below), and the
trace id from the envelope traceparent (`traceOf` — the same design
Slice 3 uses for steps; no Slice 3 code is imported). Level `info`.
Deliberately dropped even when present: session ids, user logins,
bound values, error messages, prompt/thesis text, and any other
user material — the fold admits nothing beyond the whitelist, so a
leaky producer envelope cannot leak through it.

### Cardinality guard (`src/observability/resourceEventGuard.ts`)

- Counts are strict: `rowsRead`/`rowsWritten` must be finite
  integers >= 0, else the whole event is rejected (null, never
  thrown). A malformed count is a producer bug, not a guess.
- `ns` is required (missing/empty rejects); over 64 chars or off
  the `[a-z0-9_-]` charset collapses to `"other"`. `op` must be
  one of `get | put | delete | consume | list`, else reject.
- `caller` (max 128 chars, `[A-Za-z0-9_./:-]`) and `trigger`
  (must be `user | scheduled | tick | manual`) collapse to
  `"other"` when present but unbounded; an absent trigger is
  omitted (the aggregation treats it as `"unknown"`, per
  `bucketTotals`).
- `statement` is the parameterized SQL template only (never bound
  values); it is whitespace-fingerprinted and dropped when over
  256 chars. Counts survive a statement drop.
- `sessionRef` is accepted ONLY as the #1743 correlator (exactly
  12 lowercase hex chars, what `sessionRefFor` produces). A raw
  session id is dropped, never laundered into a scope field.
- `tenantId` (max 128) and `runId` (max 256) drop when over cap,
  never truncated into a new id.
- All caps above are working defaults (pinned by test), not
  rulings; changing one is a one-line constant edit plus its test.

### Aggregation treatment

- The single aggregation definition stays `bucketTotals`
  (time-bucketed totals by ns/op/caller/trigger) — this slice
  reuses it, it does not redefine it.
- `capBucketGroups` bounds the index: it keeps the top groups by
  rowsRead (default cap 500, a working default) and folds the
  overflow into per-(bucket, ns, op) `"other"` rows. Grand totals
  (ops, rowsRead, rowsWritten) are preserved exactly — the cap
  bounds the index, never the numbers.
- Analytics Engine totals query (blob positions per
  `cfAnalyticsEngineAdapter.ts`: blob1 type, blob2 level, blob3
  operation, blob4 runId, blob5 sessionRef, blob6 traceId, blob7
  errorCode, blob8 fields JSON):
  filter `blob1 = 'resource.sql_op'` for event counts and
  totals. Per-dimension rowsRead breakdowns are NOT groupable in
  AE SQL from this mapping — the dimensions live in the blob8
  fields JSON, not in blob positions. The per-dimension query
  surface is the D1 rollup projection (`resource_sql_ops` →
  daily rollups, `buildComparisonReport`), and AE totals must
  agree with D1 totals in magnitude under the same agreement
  criteria as the comparison report. Promoting ns/op to blob
  positions would be a schema change beyond adding type values
  (blob positions are shared across all types) and is out of
  scope for this slice.
- Live proof is PENDING an owner run (same posture as Slice 3):
  a `resource.sql_op` envelope folded through the Q1 consumer
  path and visible in the stream, with AE totals agreeing with
  the D1 rollup. Not fabricated here.
