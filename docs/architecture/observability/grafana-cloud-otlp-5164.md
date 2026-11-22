# Grafana Cloud OTLP backend — issue #5164 (S10, observability program #5080)

The Worker’s OTLP export fans out to Grafana Cloud behind the
`backend.enabled` config switch. This document is the decision
record (why Grafana Cloud, what the one secret is and what the
config values are, where they come from) and the operator
runbook (how to turn it on, what happens when it fails, how
Step 5 is verified).

## Status

- **Step 1 (platform/hosting): DECIDED by the owner** — Grafana
  Cloud free tier (comment on #5164). Steps 2–3 are n/a for a
  managed free cloud (no hosting to choose, nothing to deploy).
- **Step 4 (wire the export): BUILT in this slice** — code +
  config + tests + docs, default OFF.
- **Step 5 (end-to-end verification): BLOCKED on an owner step**
  — the one Grafana secret below must be set in GitHub
  Secrets first (then a deploy syncs it to the Worker); the
  endpoint + instance ID are config values, already in
  `config/otel.json`. The build does not wait for it; only
  the live check does.

## Decision: Grafana Cloud free tier (owner, 2026-11-18)

The hosted LGTM stack: Loki (logs), Tempo (traces), Mimir
(metrics), Grafana (dashboards), Pyroscope (profiles). Free
tier: 10,000 metric series, 50 GB each of logs/traces/profiles
per month, 3 users, 14-day retention, $0, no credit card.

Why not the alternatives, as verified at decision time:

- **SigNoz**: the self-hosted path (ClickHouse + a VPS/paid
  host) the issue body originally named. Superseded: Grafana
  Cloud is managed, so there is nothing to host, and OTLP is
  the export format either way — a later switch to SigNoz is
  an exporter endpoint + auth config change, not
  re-instrumentation. Caveat, recorded honestly: dashboards and
  alert rules do NOT port between backends — only the telemetry
  data switches by config; the presentation does not.
- **Prometheus**: metrics-only, and its pull model does not fit
  short-lived Workers with no stable scrape target. Mimir gives
  PromQL-compatible metrics without running a Prometheus server.
- **Docker on Cloudflare**: ADD.md says nothing of the sort —
  it is about our own code being portable. Cloudflare
  Containers run the image but wipe its disk on sleep, so
  Grafana would need an external database and R2-backed
  storage, plus Workers Paid. Not the shape to take.

Stack live at <https://redparsnip2500.grafana.net> (org/stack
`redparsnip2500`, Cloud Free, no card on file; signed in via
the owner’s Google account). A 14-day unlimited-usage trial
auto-attached at creation and ends 2026-12-02; it does not
convert to paid (no card on file). The stack is empty of our
data until this slice’s switch is flipped after the secrets
are set.

## The one secret (owner step)

Only ONE value is a secret. The endpoint + instance ID are
**config values** in `config/otel.json` (owner direction
2026-11-22), not secrets — they carry no credential, so they
live in the repo like every other OTel switch:

| Config key | Value | Where it comes from |
| --- | --- | --- |
| `backend.endpoint` | `https://otlp-gateway-prod-us-east-2.grafana.net/otlp` | Portal, Connections → OpenTelemetry (region us-east-2, verified 2026-11-22). The region is part of the URL — it is NOT guessed in code (the Grafana MCP returns no URLs, so the region cannot be derived from it). |
| `backend.instanceId` | `1929738` | Portal, Connections → OpenTelemetry (the Basic-auth username). |

The API key lives in **GitHub Secrets** and reaches the Worker
through the deploy workflow’s sync-secrets job
(`.github/workflows/deploy.yml`, the “Set core secrets” step,
`optional_secret` — absence is reported in the job summary
and never fails a deploy; the backend stays off and fails closed
with the coded OBS message naming the missing secret). Set it
in the repo (Settings → Secrets and variables → Actions), then
deploy: the sync job pushes it to a Worker secret. `wrangler
secret put` works as a manual fallback, but the sync job is the
path — a deploy is what enables the backend, and no secret value
ever appears in `wrangler.jsonc`, in config, nor in the repo.
The key comes from the Grafana Cloud portal (**Access Policies**,
or the OTel page’s “Create token” button — the token is shown
once). The owner never needs to show the value to anyone; it is
set in GitHub Secrets and synced from there.

| Secret | Value | Where it comes from |
| --- | --- | --- |
| `GRAFANA_CLOUD_API_KEY` | The API token (`glc_...`) | Portal — create an API key with scopes `metrics:write`, `logs:write`, `traces:write` (the Basic-auth password; shown once). |

Commands (manual fallback — the sync job is the path):

```bash
wrangler secret put GRAFANA_CLOUD_API_KEY
```

Also still owed from S1 (separate): `OTEL_INGEST_TOKEN` as a
Worker secret AND the same value as a GitHub secret — it gates
the external HTTP surface of `/api/otel/v1/logs|metrics|traces`
and `/api/otel/v1/alerts`. In-process logging/metrics/spans/
alerting work without it.

## Service name + protocol (externalized)

Nothing in code: every value is externalized, and an invalid
value fails closed to the default, never to a hardcoded literal.

- **Service name** — `config/otel.json` `backend.serviceName`
  (`"ai-search-agent"`, the Worker name in `wrangler.jsonc`),
  env override `OTEL_SERVICE_NAME`, runtime override through
  the S7 config port (`backend.serviceName`). Empty/invalid
  fails closed to `ai-search-agent`. It does NOT need portal
  configuration: it is our label, shown as the service in
  Grafana. `src/observability/otelResource.ts`
  (`otelServiceResource`) builds the resource — the SDK default
  merged with `service.name` — and all three providers
  (logs, metrics, traces) carry it, so every outbound OTLP
  payload names the service: the archive AND Grafana both get
  it. Without it the SDK default names the service
  `unknown_service:node` in Grafana.
- **Protocol** — `config/otel.json` `backend.protocol`
  (`"http/json"`), env override `OTEL_EXPORTER_OTLP_PROTOCOL`,
  runtime override through the S7 config port
  (`backend.protocol`). Values `http/json` | `http/protobuf`;
  invalid fails closed to `http/json` with a coded message.
  The implemented serialization is OTLP/HTTP JSON (the S1/S2/S3
  serializers produce JSON); the portal’s default
  `http/protobuf` is NOT implemented in this slice — the value
  documents the current choice, and protobuf support is a
  follow-up (named here, no new issue filed).

## How the wiring works

- **One module**: `src/observability/otelBackend.ts` —
  credential resolution (`resolveOtelBackendCredentials`),
  the gateway transport, the fan-out transport
  (`createOtelBackendFanOutTransport`), the per-call enabled
  resolution, and the guarded failure naming. No new exporter:
  the S1/S2/S3 OTLP/HTTP exporter transport is reused as-is.
- **Fan-out, per signal**: each of the three providers
  (`createOtelLogging`, `createOtelMetrics`,
  `createOtelTracing`) builds the fan-out over its existing
  archive transport. The archive leg runs first — the
  in-process ingestion handler → R2 — and its status is what
  the exporter sees. The Grafana POST runs second, best-effort:
  `POST <endpoint>/v1/<signal>` with the OTLP/HTTP JSON body
  (the same payload the ingestion route accepts; no serializer
  change) and `Authorization: Basic base64(instance_id:api_key)`,
  bounded by the request timeout (10s default). The POST is
  awaited (no `waitUntil` in the transport), so awaiting it is
  what guarantees the POST lands before the flush returns.
- **Config**: `config/otel.json` `backend` (`enabled: false`,
  `requestTimeoutMs: 10000`) + env vars `OTEL_BACKEND_ENABLED`
  / `OTEL_BACKEND_REQUEST_TIMEOUT_MS` + the S7
  runtime-override allow-list (`backend.enabled`,
  `backend.requestTimeoutMs`). Resolution is run > session >
  user > runtime > env > file > builtin (OFF, 10s); an invalid
  value fails closed with OBS-1001. `backend.enabled` is
  consulted **per export** (like the domain gates), so a flip
  in the config panel (`?tab=observability&view=config`)
  applies on the next export without a redeploy; the timeout
  resolves at provider init. The effective values per key are
  shown by `GET /api/otel/v1/config` (platform-admin).
- **The free-tier path is unchanged**: Analytics Engine + R2
  keep receiving telemetry whatever the backend does. Flipping
  the switch back restores the free-tier-only path. Nothing is
  deleted; both paths live behind the switch (never-either-or).

## Failure behaviour (what the operator sees)

- **Backend disabled (the default)**: no backend attempt at
  all. No message, no audit event — that is the normal off
  state.
- **Enabled but unconfigured** (the API key secret missing,
  or a config endpoint/instance ID missing, or a non-https
  endpoint — Basic auth never goes over plaintext):
  no fetch attempt. The failure is NAMED once per UTC day per
  signal: one coded message (OBS-1002 logs / OBS-1006 metrics /
  OBS-1012 traces, detail naming “Grafana Cloud backend” and
  the missing config key or secret NAME) + one audit event
  (`otel.backend.export_failed`, actor `system:otel-backend`,
  `actorType: service`, `outcome: failed`). The naming never
  carries a credential value.
- **Backend POST fails** (non-2xx, network error, timeout):
  the same naming, once per UTC day per signal. The export
  itself still succeeds — the batch is safe in the archive, so
  the archive status is returned. When the archive itself
  throws, the backend is still attempted (it may be the only
  surviving copy), then the archive error is rethrown so the
  exporter still reports the export FAILED, as before.
- **The once-per-day guard** is the OBS-1007/1013 free-tier
  guard precedent: a down gateway would otherwise emit a coded
  message and an audit event per batch (every ~1s per signal)
  and flood the Analytics Engine sink and the bounded (22,000)
  audit store. The first failure of the day names it; later
  failures the same day are silent; the next UTC day names it
  again while it is still failing.
- **Where to look**: the coded message goes through the
  ingestion log (base sink only — a fallback record never
  re-enters the OTel pipeline), so it lands in Analytics
  Engine / console like any structured-log line; the audit
  event is in the canonical IAAA audit store (the IAAA Admin
  Overview Audit events view).

## Turning it on (operator checklist)

1. Set the one secret above in GitHub Secrets (repo
   Settings → Secrets and variables → Actions).
2. Deploy (the sync-secrets job pushes it to a Worker secret;
   a deploy after setting it is what makes it live).
3. Flip the switch: `?tab=observability&view=config`, set
   `backend.enabled` to `true` (runtime flip, no redeploy),
   or set `OTEL_BACKEND_ENABLED=true` in env and redeploy.
   Leave `backend.requestTimeoutMs` at 10000 unless a reason
   to change it is recorded.
4. Confirm the next exports land: the first failure of the
   day (if any) names itself as above; no naming means the
   POSTs are landing (or the backend is off — check the
   effective value at `GET /api/otel/v1/config`).

## Step 5 verification (after the switch is on)

Verify a log, a metric, and a trace are visible in Grafana
Cloud, linked by trace id:

1. Trigger a J1–J7 run (any scheduled job / pipeline run):
   it emits logs (domain `j1j7`), metrics (`job.runs`,
   `job.stage.steps`), and spans (`job.run.settled`,
   `job.stage.step`) through the same providers.
2. In Grafana Cloud (`redparsnip2500`):
   - **Logs** (Explore → Loki `grafanacloud-logs`): the run’s
     log lines are present.
   - **Metrics** (Explore → Prometheus `grafanacloud-prom`):
     the `job.runs` / `job.stage.steps` series are present.
   - **Traces** (Explore → Tempo `grafanacloud-traces`): the
     `job.run.settled` trace is present, with its step spans,
     and the trace id links the log lines to the spans.
3. The same check can be run through the Grafana Cloud MCP
   (read-only `grafana:read`): `query_loki_logs`,
   `query_prometheus`, `search_tempo_traces` /
   `get_tempo_trace`. Those query tools were untested through
   this connector at build time — each must be added to
   `ALLOWED_TOOLS` in the connector client only after reading
   its input schema from `list-tools` output. If the MCP cannot
   query the data, say so plainly and name exactly what the
   owner checks in the Grafana UI — never fake the proof.

## Residuals

- Step 5 is BLOCKED on the owner step (the one secret,
  `GRAFANA_CLOUD_API_KEY`).
  The build (code + config + tests + docs) does not wait for
  them; only the live check does.
- There is no in-app place to see Grafana data as charts yet —
  that is S8 (#5087, dashboard), discussion-only at build time.
  The R2 archive sub-tab (`?tab=observability&view=archive`)
  and the config panel (`?tab=observability&view=config`)
  stay the in-app surfaces.
- The Grafana Cloud MCP is read-only (`grafana:read`); it
  cannot create dashboards or alert rules. Each MCP-connected
  user counts as an active user on the free tier (3 users).
