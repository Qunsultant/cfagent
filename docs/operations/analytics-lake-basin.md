# Analytics lake (Basin SQL) — operating the technicals archive

The lake is an **analytics tier**, not a database. D1 keeps OLTP; Durable Object
SQLite keeps per-object transactional state. The lake receives an append-only
copy of selected feed artifacts and answers historical questions the pruned
tables cannot. It is derived, best-effort and lossy by design.

Write path: `src/data/analyticsLakePorts.ts` (port), `basinLakeAdapter.ts`
(transport), `src/aspects/analyticsLakeAspect.ts` (the archiving aspect),
`src/data/createAnalyticsLakePorts.ts` (the one composition root).
Design and slice map: issue #5813.

---

## 1. Provision (once per account)

```bash
# Bucket + Iceberg catalog
npx wrangler r2 bucket create cfagent-analytics
npx wrangler basin catalog enable cfagent-analytics      # note Warehouse + Catalog URI
npx wrangler basin catalog compaction enable cfagent-analytics --token $WRANGLER_BASIN_SQL_AUTH_TOKEN

# Stream — this schema matches what the adapter posts
cat > analytics_events_schema.json <<'JSON'
{ "fields": [
  { "name": "table",   "type": "string", "required": true  },
  { "name": "eventId", "type": "string", "required": true  },
  { "name": "asOf",    "type": "string", "required": true  },
  { "name": "payload", "type": "string", "required": false }
] }
JSON
npx wrangler basin pipelines streams create analytics_events \
  --schema-file analytics_events_schema.json --http-enabled true --http-auth true
# → note the ingest endpoint

# Sink + pipeline
npx wrangler basin pipelines sinks create analytics_sink --type "basin-catalog" \
  --bucket cfagent-analytics --roll-interval 30 \
  --namespace market_data --table technicals_bars \
  --catalog-token $WRANGLER_BASIN_SQL_AUTH_TOKEN

npx wrangler basin pipelines create analytics_pipeline \
  --sql "INSERT INTO analytics_sink SELECT * FROM analytics_events"
```

`payload` is a **JSON string by contract**: a Basin stream schema is
scalar-typed (`string | int64 | float64 | bool`), so the adapter serialises the
event body before posting. Do not declare it as an object.

## 2. Configure the Worker

Non-secret settings go in `wrangler.jsonc` `[vars]`; the token is a secret.

| Setting | Default | Meaning |
| --- | --- | --- |
| `ANALYTICS_LAKE_MODE` | `off` | `off` or `basin`. `basin` without endpoint+token resolves to `off` **with a reason**. |
| `ANALYTICS_LAKE_STREAM_ENDPOINT` | — | the stream's HTTP ingest endpoint |
| `ANALYTICS_LAKE_TOKEN` | — | ingest token (`wrangler secret put`) |
| `ANALYTICS_LAKE_DATASETS` | `technicals` | comma list of datasets to archive |
| `ANALYTICS_LAKE_TABLE` | `market_data.technicals_bars` | Iceberg table the pipeline writes |
| `ANALYTICS_LAKE_GRANULARITY` | `dataset` | `dataset` = one event per artifact (counts + provenance); `bars` = one event per (run, symbol) carrying the series |
| `ANALYTICS_LAKE_MAX_EVENTS` | `500` | events per artifact ceiling; the excess is dropped **and logged** with `analytics_lake_max_events` |

```bash
npx wrangler secret put ANALYTICS_LAKE_TOKEN
```

Enabling bar-level history:

```
ANALYTICS_LAKE_MODE=basin
ANALYTICS_LAKE_GRANULARITY=bars
ANALYTICS_LAKE_DATASETS=technicals
```

## 3. Produce a run

Any of these fires the technicals feed job; the archive runs **after** the
dataset write succeeds and never affects the run:

- Chat: *"run the NASDAQ100 technicals feed job"*
- MCP: `run_feed_job` with the technicals job id
- UI: `?tab=schedules&view=goals` → the technicals goal → **Trigger Now**
- The chain: `run_pipeline_chain`

## 4. Verify — three checks, in order

1. **Worker logs**: no `analytics_lake_archive_failed` for that run. If present,
   it names `jobId`, `dataset`, `runId` and the reason (`analytics_lake_max_events`,
   `analytics_lake_off`, or the transport error). With `granularity=bars`, one
   line per dropped symbol appears when the ceiling binds.
2. **Pipeline metrics**: Basin Pipelines → Pipelines shows the batch accepted by
   the stream.
3. **The table**: after the sink's roll interval (30s above), the row exists.

## 5. Query it

```bash
# dataset granularity — run history
npx wrangler basin sql query "$WAREHOUSE" \
  "SELECT eventId, asOf, payload FROM market_data.technicals_bars ORDER BY asOf DESC LIMIT 20"

# bars granularity — market history per symbol
npx wrangler basin sql query "$WAREHOUSE" \
  "SELECT asOf, payload FROM market_data.technicals_bars WHERE payload LIKE '%\"NVDA\"%' ORDER BY asOf DESC LIMIT 5"
```

`payload` is JSON text: parse it in your query engine of choice, or promote
fields to columns in a later sink (`INSERT INTO bars_sink SELECT … FROM …`).

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Ingest 401 | token missing/wrong | `wrangler secret put ANALYTICS_LAKE_TOKEN`; redeploy |
| Ingest rejects the batch | a declared field is missing, or `payload` was sent as an object | the schema above; the adapter serialises it |
| Nothing in the table, stream is receiving | sink namespace/table ≠ `ANALYTICS_LAKE_TABLE`, or roll interval not elapsed | align the names; wait the interval |
| `dropped > 0` in the log | lake off or misconfigured | the log line names the reason; `analytics_lake_not_configured` names the missing setting |
| Archive never fires | `ANALYTICS_LAKE_DATASETS` does not include the dataset | add `technicals` |
| Run failed while the lake was down | should be impossible | treat as a bug: the aspect is best-effort by contract |

## 7. Cost and volume

Per run at `granularity=bars`: one event per symbol with a full series
(~250 rows, ~10–15 KB of JSON). A 100-symbol universe is ~100 events and
roughly 1–1.5 MB per run. Multiply by runs per day before enabling, and record
the measured number on issue #5816. R2 storage and Basin ingest/query are
billed separately — check the platform pricing page before turning it on.

## 8. Turn it off

```
ANALYTICS_LAKE_MODE=off
```

The archive stops immediately; nothing else changes. Existing lake data stays
in R2 (delete the bucket if that is also wanted).
