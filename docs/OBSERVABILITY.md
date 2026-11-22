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

Note (S5, issue #5084): `mas_events` is the orchestrator's
session-scoped event record, read by the Audit Vault page
(`?tab=audit-vault`). It is NOT the canonical audit store — that is
the IAAA audit store (`recordAuditEvent`, SessionStore DO
`iaaa-audit:` keys), decided with evidence in
`docs/architecture/security/audit-canonical-store-5084.md`. Whether
the Vault should read the canonical store is its own decision
(issue #5264).

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
(sink: `src/security/storeMetrics.ts`). The record rides as the `fields`
of one structured `storeMetrics.store_op` info event (issue #3515 S3
batch 8 — the default sink used to emit the record as a bare JSON
`console.log` line), so Workers Logs (§1, `head_sampling_rate: 1` —
nothing is sampled away) lifts the fields out of the event and no
free-text parsing is needed:

```json
{"type":"storeMetrics.store_op","level":"info","operation":"storeMetrics.store_op","component":"security/storeMetrics","timestampMs":1760000000000,"timestampIso":"2026-10-09T00:00:00.000Z","fields":{"event":"store_op","v":2,"ns":"sessions","op":"get","instance":"kv","outcome":"ok","latencyMs":3,"ts":1760000000000}}
```

The `fields` object above is the record; the envelope carries
`operation` = `storeMetrics.store_op`, `level` = `info`, and
`component` = `security/storeMetrics`.

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
Logs → filter on `operation` = `storeMetrics.store_op`, or a Logpush
job on the same field) as newline-delimited JSON, extract the `fields`
object per line, then run the queries over the extracted records:

```bash
jq -c '.fields' store_ops.ndjson > store_op_fields.ndjson
```

T2 — failures >0.1% of ops in 24 h (per bucket/op, and overall):

```bash
# per bucket/op failure rate over the exported window
jq -s 'group_by([.ns, .op]) | map({
  ns: .[0].ns, op: .[0].op, ops: length,
  failed: (map(select(.outcome == "failed" or .outcome == "unavailable")) | length)
} | . + {failure_rate: (.failed / .ops)})' store_op_fields.ndjson

# T2 fires when this overall 24 h rate exceeds 0.001
jq -s '{ops: length,
        failed: (map(select(.outcome == "failed" or .outcome == "unavailable")) | length)}
       | . + {failure_rate: (.failed / .ops)}' store_op_fields.ndjson
```

T1 — >250 ops/s sustained, or >500 ops/s averaged over an hour, on the
`kv` instance:

```bash
# per-minute rate: T1 (sustained) fires on any run of >=5 consecutive
# minutes each above 250 ops/s
jq -s 'map(select(.instance == "kv")) | group_by(.ts / 60000 | floor)
       | map({minute_epoch: ((.[0].ts / 60000 | floor) * 60),
              ops: length, ops_per_sec: (length / 60)})
       | map(select(.ops_per_sec > 250))' store_op_fields.ndjson

# per-hour rate: T1 fires on any hour above 500 ops/s
jq -s 'map(select(.instance == "kv")) | group_by(.ts / 3600000 | floor)
       | map({hour_epoch: ((.[0].ts / 3600000 | floor) * 3600),
              ops: length, ops_per_sec: (length / 3600)})
       | map(select(.ops_per_sec > 500))' store_op_fields.ndjson
```

Latency sanity (a rising p95 at flat volume is the early-warning shape of
a store under pressure, before either trigger fires):

```bash
jq -s 'group_by([.ns, .op]) | map({ns: .[0].ns, op: .[0].op, n: length,
  p95_latency_ms: (map(.latencyMs) | sort | .[((length * 0.95 | floor) - 1)])})' store_op_fields.ndjson
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

## 6. OpenTelemetry (OTel) — the telemetry library (issues #5081 S1 + #5082 S2 + #2808 S3 + #5083 S4, program #5080)

OTel is the instrumentation library for logs, metrics, and traces
(the S1 slice implements LOGGING; the S2 slice implements
METRICS — issue #5082; tracing spans is S3 — issue #2808, and
#2808's harmonization program stays parked; error-reporting is
S4 — issue #5083, the one alerting port). No SigNoz, no
ClickHouse, no VPS, no Workers Paid features, no D1 for
telemetry. The stack is the stock JS 3.x logs + metrics lines:
`@opentelemetry/api` 1.10.0 + `@opentelemetry/sdk-logs` 3.1.1 +
`@opentelemetry/sdk-metrics` 3.1.1 + `@opentelemetry/otlp-transformer`
0.301.2.

### The five-level on/off mechanism (all externalized)

Every switch lives in `config/otel.json` + env vars and resolves
run > session > user > env > config-file > built-in safe default
(the PAYMENTS_FLOW_MODE pattern, `src/config/otelModes.ts`).
Invalid values fail closed to OFF / none / 0 with a coded
OBS-1001 message. Flipping a switch is a config-file or env-var
change, effective on the next deploy; the runtime flip without a
redeploy (KV/D1 switches + admin UI) is S7/S8.

1. **Global master** — `OTEL_ENABLED` / `OTEL_SDK_DISABLED`
   (the OTel standard kill switch). Master off = nothing emitted,
   nothing exported, no cost. Default: ON (so the J1–J7 domain,
   which is ON, actually emits).
2. **Per-signal** — `OTEL_LOGS_EXPORTER` / `OTEL_METRICS_EXPORTER` /
   `OTEL_TRACES_EXPORTER` (`otlp` | `console` | `none`). `none`
   turns that signal off globally. Logs and metrics are the live
   signals (`otlp`); traces resolves to `none` until S3.
3. **Per-domain** — `OTEL_DOMAIN_<DOMAIN>_ENABLED` / the config
   map `otel.domains.<domain>.enabled`. One AOP gate at the domain
   boundary (`createOtelDomainGate`); domain code calls through
   it and contains no scattered `if (enabled)` checks. J1–J7 is
   ON; Stock Copilot, IAAA, MCP/A2A, scheduler, payments, market
   data, platform are OFF by default and enableable later by
   flipping a switch, without a code change.
4. **Per-domain level + sampling** — the log level
   (`ALL`/`ERROR`/`DEBUG`/`INFO`/`WARN`/`TRACE`/`OFF`) and the
   sampling ratio per domain. Level `OFF` = that domain emits
   nothing.
5. **Per-destination** (issue #5138) — one switch per destination
   (`OTEL_DESTINATION_<NAME>_ENABLED` / the config map
   `otel.destinations.<name>`): `analyticsEngine` (the Analytics
   Engine sink), `r2` (the OTLP export to R2), `console` (the
   console sink). Each is individually on/off; invalid fails
   closed to OFF. Config-file defaults are all ON (preserving
   the current behavior); the built-in safe default is OFF.
   `createObservabilitySink` (the composition root) respects
   them: AE off means never write to it (fall back to console
   only if console is on; if both off, the event is dropped —
   logging never fails the caller). The OTel transport respects
   the R2 switch (R2 off = no R2 write; ingestion falls back to
   the structured log).
6. **External backend** (issue #5164, S10) — one switch for the
   Grafana Cloud destination (`OTEL_BACKEND_ENABLED` / the config
   map `otel.backend.enabled`, default OFF) plus the request
   timeout (`OTEL_BACKEND_REQUEST_TIMEOUT_MS` /
   `otel.backend.requestTimeoutMs`, 10000ms). When ON, each
   signal's export fans out: the archive transport (in-process
   ingestion → R2) runs first and its status is what the
   exporter sees; the Grafana Cloud OTLP POST runs second,
   best-effort (Basic auth: the numeric stack/instance ID + the
   API token, both Worker secrets, never in the repo). A backend
   failure never fails the export — the batch is safe in the
   archive — and is named once per UTC day per signal (coded
   OBS-1002/1006/1012 + one audit event `otel.backend.export_failed`).
   `backend.enabled` flips at runtime through the S7 config port
   (consulted per export); the timeout resolves at provider init.
   Analytics Engine + R2 keep receiving telemetry whatever the
   backend does. The three secrets are `GRAFANA_OTLP_ENDPOINT`
   (the gateway URL from the portal, Connections → OpenTelemetry),
   `GRAFANA_CLOUD_INSTANCE_ID`, `GRAFANA_CLOUD_API_KEY`.

**Workers Logs is NOT a switch in this file.** It is deploy-time
only: `wrangler.jsonc` `observability.enabled` (set `false` to
silence it entirely; currently `true` at 1% sampling,
`persist: false` per #4131). The Worker cannot flip the
Cloudflare platform log pipeline at runtime — no runtime switch
exists for it, and none is pretended here.

### Export: OTLP/HTTP to R2 (archive) + console

The OTel SDK exports OTLP/HTTP (JSON) through a thin exporter
over the official `JsonLogsSerializer`, with an injected
transport. The Worker-side SDK hands OTLP to the ingestion
handler in-process (a real HTTP POST to the Worker's own domain
returns Cloudflare 522). `POST /api/otel/v1/logs` is a real HTTP
endpoint for external OTLP senders; it is disabled (404) unless
the `OTEL_INGEST_TOKEN` secret is set, and requires
`Authorization: Bearer <token>` when it is. The ingestion
handler writes one JSONL object per batch to R2
(`REPORTS_BUCKET`, `otel-archive/<YYYY-MM-DD>/<id>.jsonl`),
falling back to the structured logger (Workers Logs, via the
base sink) when R2 is unbound. The fallback log is injected
(`OtelIngestionLog`, built by `createOtelIngestionLog` over a
structured logger) — the ingestion module never calls raw
`console.*` (the #3515 ratchet pins new files at zero) — and
the logger writes to the base sink only, never the OTel sink
(a fallback record must not re-enter the OTel pipeline). R2
is retention, not observability — no query engine, dashboard,
or alerting on it until the S8 dashboard.

### J1–J7 instrumentation (S1 scope)

The J1–J7 Job Pipeline Engine (Epic #3533) is instrumented
through the engine's existing seams only — the
`runSettledObserver` (chained after the feed-run observer) and
the stage-step `journal` — on the ScheduledAgent host,
emitting `job.run.settled` + `job.stage.step.started` /
`completed` / `failed` through the ONE structured logger with
component `job-pipeline`, via a fan-out sink (Analytics Engine /
console AND OTel). The workflow / options / in-memory hosts are
not yet wired (same helper, later slice). The 242 raw
`console.*` sites outside the structured logger are NOT swept
in this PR (follow-on work).

### Metrics (S2 scope, issue #5082)

One metrics model + one store. The model is the OTel metric
(name, labels, value, timestamp); the store is the existing
Analytics Engine `observability` dataset — the same store S1
uses for logs, reached through the existing
`createObservabilitySink` / Analytics Engine adapter
(`metricEventForSeries` converts one OTel series into one AE
datapoint: type `metric.<name>`, value in `count` for
counters/gauges, sum in `durationMs` for histograms). No second
metrics store, no new backend. The export is the same
OTLP/HTTP pattern as logs: the SDK's `PeriodicExportingMetricReader`
exports aggregated series (one datapoint per series per export,
never one per event) through the thin OTLP/HTTP metric exporter
(`JsonMetricsSerializer` + injected transport) to the in-process
ingestion handler, which archives one JSONL object per batch to
R2 (`otel-archive/<YYYY-MM-DD>/<id>.jsonl`) and writes each
series to the AE sink. `POST /api/otel/v1/metrics` is a real
HTTP endpoint for external OTLP senders, under the same
`OTEL_INGEST_TOKEN` gate as the logs route.

**Free-tier guard.** Analytics Engine Free allows 100k writes/day
and 10k read queries/day; the limits are config values
(`otel.metrics.freeTier.dailyWriteLimit` /
`dailyReadQueryLimit`, env `OTEL_METRICS_FREE_TIER_*`), not
hard-coded. The exporter counts AE writes per UTC day and, when
the limit is reached, drops further AE writes with exactly one
coded OBS-1007 per day (the R2 archive path is NOT guarded — R2
has no per-row quota; a 0 write limit means no AE writes while
R2 still archives). Aggregation (the SDK exports aggregated
series, not per-event points) plus the guard is what keeps the
free tier reachable.

**Instruments (J1–J7 first, others OFF by default).** The
recorder (`src/observability/otelMetricsRecorder.ts`) is the one
model: `job.runs` (Counter), `job.stage.steps` (Counter),
`job.stage.step.duration` (Histogram, ms), `quota.report_runs`
(Counter — one per charged report run, not one per window),
`resource.rows_read` / `resource.rows_written` / `resource.ops`
(Gauges, per rollup row per day), `health.pipeline` (Gauge 1/0),
`slo.resource.rows_read` (Gauge 1/0). The metrics gate does NOT
apply the log level/sampling — a counter sampled at record time
is a corrupted count; volume controls are the export interval
(`otel.metrics.exportIntervalMs`, default 60s) + the free-tier
guard. All recording is best-effort and never throws.

**First metric: the #1819 SessionStore resource rollup.** The
rollup goal hands the same rows it wrote to D1 to the recorder
(`recordResourceRollup`); the rollup is already daily-aggregated
(one gauge value per row per day), so it is the lowest-volume
first metric. Health = the J1–J7 run failure rate vs the
configured max (`otel.metrics.health.pipelineMaxFailureRate`,
default 5%); the SLO = the day's SessionStore rows-read vs the
configured max pct (`otel.metrics.slo.resourceRowsReadMaxPct`,
default 70%) of the free-tier budget (5,000,000). Both are pure
evaluators + a gauge; the dashboard (S8) surfaces them, and the
70% cap-ALERT is S4 (alerting) — S2 instruments the measurement
only.

### Tracing (S3 scope, issue #2808)

OTel span instrumentation only — NOT the #2808 harmonization
program (harmonizing security, workflow, integration, schedule,
login, agent, and action traces into one linked trace model),
which stays parked. One span model + one store: the model is
the OTel span (name, trace/span ids, parent, start/end,
attributes, status); the store is the existing Analytics
Engine `observability` dataset — the same store S1 uses for
logs and S2 uses for metrics, reached through the existing
`createObservabilitySink` / Analytics Engine adapter
(`spanEventForReadableSpan` converts one span into one AE
event: type `span.<name>`, duration in `durationMs`,
trace/span/parent ids in fields, ERROR status → level
"error"). No second traces store, no new backend. The export
is the same OTLP/HTTP pattern as logs and metrics: the SDK's
`TracerProvider` (batch processor in production, simple in
tests) exports finished spans through the thin OTLP/HTTP span
exporter (`JsonTraceSerializer` + injected transport) to the
in-process ingestion handler, which archives one JSONL object
per batch to R2 (`otel-archive/<YYYY-MM-DD>/<id>.jsonl`) and
writes each span to the AE sink. `POST /api/otel/v1/traces`
is a real HTTP endpoint for external OTLP senders, under the
same `OTEL_INGEST_TOKEN` gate as the logs and metrics routes.

**Free-tier guard.** The traces exporter counts AE writes per
UTC day against the configured limit (`otel.traces.freeTier.
dailyWriteLimit`, env
`OTEL_TRACES_FREE_TIER_DAILY_WRITE_LIMIT`, default 100,000)
and, when the limit is reached, drops further AE writes with
exactly one coded OBS-1013 per day (the R2 archive path is
NOT guarded — R2 has no per-row quota; a 0 write limit means
no AE writes while R2 still archives). An empty span batch
exports nothing (no serialization, no transport call).

**Spans (J1–J7 first, others OFF by default).** The observers
(`src/observability/otelJobPipelineTraces.ts`) are the one
span model, wired through the engine's existing seams only —
the `runSettledObserver` (chained after the metrics observer)
and the stage-step `journal` (wrapping the metrics journal) —
on the ScheduledAgent host: one `job.run.settled` span per
terminally settled run (OK for completed, ERROR for failed
with the error, UNSET for cancelled; a zero-duration marker
at the settle moment — the run-settled info carries no start
time, so no duration is invented) and one `job.stage.step`
span per stage step (name, duration, OK/ERROR status, the
error message; the step's error is always rethrown). Nested
steps nest: the AsyncLocalStorage context manager (registered
once per isolate by the traces composition root;
`nodejs_compat` is on) makes a step that calls the journal
again record a child span, and concurrent runs keep their own
active span. The workflow / options / in-memory hosts are not
yet wired (same helper, later slice). Both observers are
best-effort and never throw. The traces gate applies the
domain level (OFF means no spans) + sampling at span start;
a span sampled out is never created. All span recording is
best-effort and never throws.

**Seam honesty.** The engine's journal seam carries no run
context (`JobStepJournal.do` receives only the step name) and
the run-settled info carries no duration or traceparent — so a
step span is a root span (one trace per step) and the run span
is a zero-duration marker at the settle moment. Linking a
run's steps into one trace needs a run-context seam in the
engine (a later slice, not S3). The existing traceparent
discipline (`src/observability/observabilityPorts.ts`,
`meshTrace.ts`) is reused for span ids; S3 does not
harmonize the seven trace kinds.

### Error-reporting (S4 scope, issue #5083)

One owner module + one alerting port — the single path every
error report takes to reach a human:
`src/observability/otelAlerting.ts` (`createAlertingPort`).
Every alert goes to Slack (SCREENER_SLACK_CHANNEL) AND email
(CHANNEL_EMAIL_PRINCIPALS) — both, every alert. Alerts are
notifications, never approval cards: an alert never asks the
recipient to approve anything, and no Block Kit action is ever
attached. Credentials (SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL,
the EMAIL binding) come from GitHub secrets (Worker secrets),
never hardcoded, never in config files.

The port CONSUMES logs/metrics/audit: it reads them to enrich
the alert (trace id / run id / context ride the report) and
records every alert through the structured logger. It does not
replace or duplicate them, and it writes no second store. The
Slack leg reuses the one Slack text route
(`postSlackText` in `src/agents/social/delivery.ts`, moved
there from `src/agents/resourceGoals.ts` in S4 so the port can
reuse it without a circular import; resourceGoals re-exports
it, so its existing callers are unchanged). The email leg
reuses the one `EmailSender` port
(`src/services/emailSenderPorts.ts`); the recipients are the
CHANNEL_EMAIL_PRINCIPALS keys (one email per principal).

The three first consumers (owner decision: ALL wired first):
the sweep stuck-run alert (#3784, orchestrator
`notifyStuckRun`), the 70% SessionStore cap alert (#1819,
`runResourceCapAlert` — the 70% watch and the 90%/100%
tiers), and CI failure alerts (the Workflow Failure Watch
workflow POSTs to `POST /api/otel/v1/alerts` when it files a
new [QA self-heal] issue, under the same OTEL_INGEST_TOKEN
gate as the OTLP routes; the alert is best-effort and never
fails the workflow). What triggers each does not change —
only the delivery path (they now go through the one port).
#3765 S2 alerting is a consumer of this port, not a parallel
alerter.

**Placeholder rules (S7 dependency, option b).** S4 builds
only the owner module + port with PLACEHOLDER rules. The
port accepts a severity + rule id from the caller, but S4
does NOT define the real rule/severity catalog — the values
are placeholders (`ruleId` starts with `placeholder-`,
`result.placeholderRules === true`), clearly marked, to be
replaced by S7 (#5086). No second catalog. The alert-subject
codes OBS-1017 (stuck run), OBS-1018 (cap breach), OBS-1019
(CI failure) are S4 code identifiers; their severity/rule
mapping lands with S7.

**Config.** The `alerting` section of `config/otel.json` +
env vars, resolved through the same five-level mechanism
(run > session > user > env > file > builtin safe default):
master `enabled` (builtin OFF), `slackEnabled` /
`emailEnabled` (each channel individually on/off; builtin ON
when alerting is on), and the free-tier guard
`maxAlertsPerDay` (builtin 100). An invalid value fails
closed to OFF with a coded OBS-1001 message + audit.

**Free-tier guard.** The port counts alerts delivered per UTC
day against `maxAlertsPerDay` (a config value, not
hard-coded) and, when the cap is reached, drops further
alerts with exactly one coded OBS-1016 per day. The guard
state is module-level (shared across every port instance in
the isolate, keyed by UTC day + cap) — a fresh port per alert
must not reset it. A delivery failure on one channel never
blocks the other; the port never throws.

### Audit (S5 scope, issue #5084)

One audit store. The canonical audit store is the IAAA audit
store: the contract in `src/data/auditLogPorts.ts`, the pure
model + single write path `recordAuditEvent` in
`src/security/iaaaAudit.ts`, the wiring `createWiredAuditStore`
in `src/security/iaaaAuditStore.ts`, backed by the SessionStore
Durable Object's `audit-append` op on `iaaa-audit:` keys
(append-only, hash-chained, live cap 2,000 + 10 archive
segments of 2,000 = 22,000 events; reaching the cap refuses
new appends as `AUDIT_STORE_FULL`, never deleting evidence).

S5 eliminated the duplicate client implementation: the
security layer's `createAtomicAuditStore` and the AuditLog
family's `createAuditLogStore` both spoke the same DO op on the
same keys. The audit-append client logic is now single-sourced
in `createAuditLogStore` (`src/data/auditLogStoreImpl.ts`);
`createAtomicAuditStore` is a thin adapter over it. Both
`AUDIT_PORTS_ENABLED` states serve the one implementation — the
flag selects the composition root only, not the implementation.
No file was deleted; no audit event was lost (both compositions
always wrote the same keys with byte-identical behavior, pinned
by the #2435 conformance suite). Audit-before-allow is
preserved (`classifyAuditFailure` / `shouldBlockAction` /
`isAuditedSuccess` in `iaaaAudit.ts`): a consequential action
whose audit write fails BLOCKS.

The canonical audit surface is the IAAA Admin Overview Audit
events view (`src/security/iaaaAdminOverview.ts`), which reads
the one store. Two things S5 deliberately did NOT consolidate,
recorded in `docs/architecture/security/
audit-canonical-store-5084.md`: the #1688 audit REPORT family
(`src/data/auditReportPorts.ts`) is a projection of DIFFERENT
events (agent chain lifecycle rows in D1), not a second IAAA
audit store; and the Audit Vault page (`?tab=audit-vault`)
reads the older `mas_events` record (§2) — whether it should
read the canonical store is its own decision, filed as
[Out-of-Scope] issue #5264. S5 adds no coded messages and no
new config; the catalog lands with S7.

### Recording (S6 scope, issue #5085)

One runs ledger, one source of truth for "did the run happen".
The run-row model is `JobRunRecord`
(`src/data/jobRunRecordPorts.ts`); the one write entry is
`recordLedgerRun` (`src/services/unifiedLedger.ts`); the one
physical ledger is the OrchestratorAgent Durable Object SQLite
`job_run_records` table (`SqlJobRunRecordStore`). The D1
`job_run_records` table is a read replica (projector-fed); the
ScheduledAgent side stores the same shape under its DO KV key
`"jobRunRecords"` (transport fallback, merged on read). A run
with no artifact still records its job/run ids (the #4002 rule).

The three views are reconciled: the runs ledger is the source of
truth; the Audit Vault records who authorised the run (it still
reads `mas_events` — S6 does NOT re-point it, that is #5264's
decision); the Loop status reads the ledger — `lastCycle` is a
projection of the newest copilot cycle ledger row
(`src/services/stockCopilotLedger.ts`), `neverExecuted` is
simply "no ledger row", and the activity table stays as the
"Cycle activity" detail feed. The outcome class rides the ledger
row (the cycle descriptor names traded vs no trade; refusal
classes ride the detail, kept byte-identical for the #3788 pin).

A failed ledger write is named through one shared namer,
`nameLedgerWriteFailure`
(`src/agents/orchestrator/scheduleCallbackRunRecords.ts`): every
`recordScheduleCallbackRun` site wires it (copilot site:
`stock_copilot.ledger_write_failed`; the nine orchestrator
schedule-callback sites + the watchdog sweep's claim and
heartbeat writes: `schedule.ledger_write_failed`). The namer
audits the failure AND logs coded **OBS-1020**. Residuals: no
`job_run_records` DO→D1 projector exists (d1-only runs-view
mode does not show DO-written rows — a separate slice), and the
ScheduledAgent goal-run recording sites do not yet wire the
namer (their KV fallback stands). Full record:
`docs/architecture/observability/recording-one-ledger-5085.md`.

### Coded messages + the config port (S7, issue #5086)

One message catalog (`src/observability/otelMessages.ts`,
`OBS_CATALOG`) and one config port
(`src/config/otelConfigPort.ts`): every log / audit / alert /
trace event carries a coded message from the catalog, and
every threshold, severity, retention, and sampling value lives
in config — no hard-coding at the call sites (owner directive
2026-11-12). The catalog is the single source for message
text: no free-form message strings at call sites
(`formatCatalogMessage` is the only formatter;
`formatOtelMessage` is gone). Codes are stable across releases
and never reused for a different meaning; an unknown code
fails closed (a lookup miss, never a silent pass).

The catalog (code · message · default severity):

`OBS-1001` config invalid (fail-closed) · warning ·
`OBS-1002` export failed · error · `OBS-1003` ingest failed
(R2 write) · error · `OBS-1004` ingest rejected (malformed
OTLP) · warning · `OBS-1005` sink degraded · warning ·
`OBS-1006` metrics export failed · error · `OBS-1007`
metrics free-tier guard (AE write limit reached) · warning ·
`OBS-1008` archive unavailable · error · `OBS-1009`
archive key rejected · warning · `OBS-1010` archive object
not found · info · `OBS-1011` archive forbidden · warning ·
`OBS-1012` traces export failed · error · `OBS-1013`
traces free-tier guard (AE write limit reached) · warning ·
`OBS-1014` alerting send failed · error · `OBS-1015`
alerting destination missing · warning · `OBS-1016`
alerting free-tier guard (max alerts/day reached) · warning ·
`OBS-1017` stuck-run alert · warning · `OBS-1018` cap-breach
alert · warning · `OBS-1019` CI failure alert · error ·
`OBS-1020` ledger write failed (a runs-ledger write failed
and was named) · error · `OBS-1021` alerting rule unknown (an
alert report with an unknown rule id is rejected, never sent) ·
error · `OBS-1022` config forbidden (a signed-in non-admin
was denied the OTel config) · warning.

The S4 placeholder alert rules now resolve through the
catalog: `rule:stuck-run` → OBS-1017 (warning),
`rule:cap-breach` → OBS-1018 (warning), `rule:ci-failure` →
OBS-1019 (error). A rule id that is neither a catalog rule nor
a `placeholder-*` rule is rejected with OBS-1021 and sends
nothing (and consumes no guard budget); placeholder rules still
deliver, unchanged.

The config port: the runtime override store is D1
(`AGENT_DB`, table `otel_config_overrides`, migration 0070) —
the Worker reads it at runtime, so flipping a switch does NOT
need a redeploy. D1 was chosen over KV (no KV namespace is
provisioned for this Worker) and over the DO SQLite settings
store (`mas_settings`, unreadable from a Worker isolate).
Versioned, auditable, reversible (the #2838 / #2842
treatment): the table is append-only — every change INSERTs a
new versioned row with actor + timestamp + reason, clearing an
override INSERTs a tombstone row (value NULL), and every change
also writes a `recordAuditEvent` audit event. Revert = apply an
earlier version's value as a new version. Only keys on the
allow-list (`otelRuntimeOverrideKeys()`, generated from the
catalog for the per-code `catalog.<OBS-code>.severity` keys)
can be overridden; an unknown key or an invalid value is
rejected at write time and never stored. A reason is required
for every change.

Resolution is now run > session > user > **runtime** > env >
file > built-in safe default: the runtime level comes from the
override cache (60s TTL, stale-while-revalidate). The admin
write route force-refreshes the cache, so the writing isolate
applies a flip immediately; other isolates pick it up within
the TTL or on their next alert/admin request. Propagation,
stated honestly: alerting settings, sink destinations, and
archive-route state apply on the next operation; domain
on/off/level/sampling apply on the next event (the gates
consult the cache per event); the master switch, exporters,
batch, and metrics/traces transport settings apply at the next
provider/control init.

The admin surface is `?tab=observability&view=config`
(`OtelConfigPanel`): the catalog, the key allow-list, the
current overrides, and the effective value + winning source
for every key, over `GET / POST / DELETE /api/otel/v1/config`
(platform-admin only, 401 unauthenticated, 403 with OBS-1022
for a signed-in non-admin, 500 when the admin check itself
fails). Full record:
`docs/architecture/observability/message-catalog-config-port-5086.md`.

### Why not the stock exporter or the pydantic package

- The stock `OTLPLogExporter` (`@opentelemetry/exporter-logs-otlp-http`)
  has no public transport injection, so it cannot route to the
  same-Worker ingestion route (the 522 self-fetch rule). The thin
  exporter uses the official serializer + an injected transport
  instead. The same holds for the stock `OTLPMetricExporter`
  (`@opentelemetry/exporter-metrics-otlp-http`) — the thin metric
  exporter uses the official `JsonMetricsSerializer` + an injected
  transport for the same reason.
- `@pydantic/otel-cf-workers` is traces-only (no LoggerProvider /
  sdk-logs) and its `@opentelemetry/core` 2.x conflicts with the
  logs stack's core 3.x. S3 (tracing) evaluated it and did NOT
  adopt it: the thin span exporter (`JsonTraceSerializer` +
  injected transport, sdk-trace 3.1.1 on the same core/resources
  3.1.1 line as sdk-logs/sdk-metrics) keeps one OTel version
  across all three signals.
