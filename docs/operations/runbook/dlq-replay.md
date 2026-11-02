# DLQ replay — listing, replaying, and the depth alert

Operator runbook for dead-lettered queue messages (screener-events
and screener-events-delivery). Filed under issue #2000, Phase 5
Slice 1. This slice covers application-level terminal drops only;
see "What this store does NOT cover" below for the platform DLQ.

## How a dead letter surfaces

- **Console record (always).** Every terminal drop emits one
  parseable `[dead-letter]` JSON line (reason, queue, message id,
  run/unit ids, actor) through the existing dead-letter sink. This
  record exists even when the store below is unbound.
- **Store row (when AGENT_DB is bound).** The same drop is also
  persisted to the `agent_dead_letter_records` table (migration
  0033), with the full envelope when the drop carried one. The
  operator routes read this store; without it, listing and replay
  answer 503 and the console lines are the only record.
- **Depth alert (the early signal).** When the count of
  un-replayed store rows reaches the configured threshold —
  default **10**, Worker env var `DLQ_DEPTH_ALERT_THRESHOLD`
  (`0` disables the alert) — the next landing raises ONE operator
  alert to the Slack operator channel (the same webhook/bot
  delivery surface as the stuck-run and cap alerts). The alert
  carries the depth and this runbook's path. Exactly one alert
  fires per incident: the claim is a guarded token on the
  `dlq_depth_state` row, so repeated landings and concurrent
  readers cannot re-alert. The incident clears when the depth
  drops below the threshold — a replay that clears the backlog
  clears it promptly, not on the next landing.
  Delivery-failure trade-off (same as the stuck alert,
  claim-first): if the Slack post fails, the incident stays open
  and no second alert fires. Check the Slack webhook/bot
  configuration; the backlog itself is still listable below, so
  nothing is lost — only the notification is.
- **Dashboard-native queue alerts are complementary, not
  required.** The depth alert above counts persisted dead-letter
  records. Platform DLQ depth (messages that exhausted
  max_retries) is visible in the Cloudflare dashboard's queue
  metrics; a dashboard alert on those queues is a useful second
  signal but is not required for this slice's alert to work.

## Diagnosis

1. **List the backlog.** As a store operator, `GET
   /api/ops/dlq/records` returns un-replayed rows, newest first
   (capped at 100). Each row carries queue, reason, message id,
   run/unit ids, actor, detail, and the stored envelope text
   when one exists.
2. **Read the reason first.** The reason decides whether replay
   can help at all (see "What cannot be replayed" below). A
   `no_handler` row means no handler existed at drop time — a
   handler may have landed since, which is exactly what replay
   is for. A `denied` row means the identity rules refused the
   dispatch; replay cannot help and must not be attempted as a
   bypass.
3. **Check whether the backlog is one incident or many.** Many
   rows with one queue + one reason + one time window usually
   share a cause (a missing handler, a bad deploy, a provider
   outage behind a dispatch). Many rows spread across queues and
   reasons is a platform incident, not N dead letters.

## Safe intervention: replay

Replay is an operator-only action: `POST /api/ops/dlq/replay`
with `{ "recordId": "<row id>" }`, as a store operator
(env `COMMERCIAL_STORE_OPERATORS` UNION the store operator
list, same gate as the commercial operator routes).

- **Replayable:** `no_handler` rows carrying an envelope. The
  replay re-sends the identical envelope object to the record's
  source queue (`screener-events` or
  `screener-events-delivery`), so the envelope id — the
  idempotency key — is intact: downstream id-based dedup treats
  the redelivery as the same work, not new work. For a
  `no_handler` original nothing was ever processed, so replay is
  the FIRST processing, not a double-apply.
- **On success** the row is marked replayed (timestamp +
  outcome) and leaves the un-replayed set. A successful replay
  that drops the depth below threshold also clears any open
  depth incident.
- **On a failed send** (the source queue binding errors) the row
  stays un-replayed and the route answers 502: retry the replay
  once the queue is healthy. A failed send never marks the row.

## What cannot be replayed, and why

- **`undecodable`** — no decodable envelope exists to re-drive.
  There is nothing to replay; the console record + store row are
  the evidence. Fix the producer if these recur.
- **`denied`** — the identity rules refused the dispatch, and
  would refuse again. Re-driving past the rules would be a
  security hole, not a recovery. If the denial itself was wrong,
  fix the identity configuration and let the producer re-submit
  through the normal path.
- **`invalid_envelope`** — the stored envelope fails the
  CloudEvents shape check; re-driving it would drop again.
- **`already_replayed`** — the row was already replayed once.
  Replay never runs twice for one row; if the replayed work
  itself dropped again, that is a NEW landing with a NEW row,
  and that row is what you replay.
- **Unknown queue** — the record names a queue with no sender in
  the replay map. The map contains source queues only, never the
  DLQ queues: a record can never be re-driven INTO a DLQ.

## What this store does NOT cover

- **Platform DLQ contents.** Messages that exhausted max_retries
  (3) on a source queue land in the platform DLQ queues
  (`screener-events-dlq`, `screener-events-delivery-dlq`), which
  are consumer-less by design and cannot be peeked from a Worker.
  Those messages are NOT in this store and cannot be replayed
  through the route above. Their visibility is the Cloudflare
  dashboard's queue metrics and retention; a dashboard-native
  alert on those queues is the complementary signal for them.
- **Audit.** Dead-letter rows are operational records, not audit
  records. Stage audit stays in `mas_events`; this store adds no
  audit writes and no second audit system.

## What NOT to do

- Do not replay a `denied` row by editing the store to change
  its reason — that bypasses the identity rules the refusal
  exists to enforce.
- Do not replay the same row twice by clearing its replay mark
  directly in the table — the mark is the no-double-replay
  guarantee; a second processing of the same work is exactly
  what it prevents.
- Do not lower `DLQ_DEPTH_ALERT_THRESHOLD` to chase a noisy day;
  a flood of landings means a missing handler or a platform
  problem — diagnose that instead. Raise it only with a recorded
  reason.
- Do not edit `agent_dead_letter_records` rows directly except
  through the replay route: direct edits bypass the guarded
  replay claim and the depth accounting this runbook relies on.
- Scope boundary: this slice adds no new queue, no new workflow,
  and no binding change. A replay procedure that needs to read
  the platform DLQ queues directly would require a new consumer
  binding — a COO readiness gate, not an operator action.

## Configuration

- `DLQ_DEPTH_ALERT_THRESHOLD` — un-replayed-row count that
  opens a depth incident (default 10, `0` disables). Blank or
  unparseable falls back to the default.
- Store migration: `0033_dead_letter_store`
  (`agent_dead_letter_records` + `dlq_depth_state`), applied by
  the route/queue paths' schema-ensure on first use.
