# Alerting runbook — the five-item alerting list (Phase 5, #2000 slice 7)

Every alert on this list delivers through the existing `postSlackText`
channel (webhook first, bot token second) and carries its runbook
section link in the text. No alert on this list introduces a second
channel. Claim-once semantics differ per item (see each section) —
the shared rule is: **one incident pages once**; a delivery failure
is audited, never retried into a duplicate page.

Inventory (single source of truth in code:
`src/observability/alertingList.ts`):

| # | Item | Signal | Claim |
|---|------|--------|-------|
| 1 | DLQ depth | Un-replayed dead-letter rows ≥ threshold | Depth-incident claim in the dead-letter store |
| 2 | Breaker trips | `breaker.state_changed` to `open` | Envelope-id claim |
| 3 | Stuck rows | `running` row older than threshold | `markStuckAlerted` stamp on the job row |
| 4 | Serve-stage failures | Monolithic report job terminal-failed | Structural (terminal job + retry suppression) |
| 5 | Gather misses | Goal gather stored 0 of N requested | One enrich call per runId |

DLQ depth and stuck rows have their own runbooks
(`dlq-replay.md`, `stuck-runs.md`); this doc covers the items
that did not have one, and the list as a whole.

## Breaker trips

**Signal:** a provider circuit breaker transitioned to `open`
(`breaker.state_changed` envelope, Slice 2 subscriber). Only `open`
transitions page; half-open and closed are acknowledgments, not
incidents.

**What it means:** calls to that provider are rejected instantly
until the reset timeout elapses; the provider is down or
rate-limiting, and fallbacks (if any) are carrying the load.

**Diagnosis:** check the trip count and fallback count in the alert;
confirm whether the provider is a live source (E*TRADE) or a
complement (Yahoo) — a Yahoo trip degrades enrichment, an E*TRADE
trip changes which rows a run can store.

**Safe intervention:** none required — the breaker resets on its
own timeout. Do not force-close a breaker mid-outage; if trips
repeat, the provider outage (not the breaker) is the incident.

**Claim note:** a re-delivered envelope claims nothing (the
envelope id is the claim). A failed page consumes the claim —
the trip stays visible in the store and in snapshots, but no
re-page fires for it.

## Serve-stage failures

**Signal:** a `followup.report` job (the serve stage — report
generation) reached terminal `failed` with **no chain identity**.
This is the monolithic serve path: the legacy report job planned
without a stage chain.

**What it means:** the run's report was not generated, and no
chain exists to resume from. Nothing downstream was scheduled.

**What does NOT page (by design):** chained serve failures
(stage `serve` + chain id) never page here — they are visible in
the stage feed and retryable per stage via `retryAsyncJob`.
A retry's own failure never re-pages — the incident was paged
on the original failure.

**Diagnosis:** the failure state is a first-class record, not a
silent job-row state — find the `serve/failed` stage transition
in the screening activity feed and the `async_job.serve_failed`
audit row for the job id, which names the failure reason.

**Safe intervention:** retry the failed report job via
`retryAsyncJob` (a fresh job id; the original row stays failed
as the record). If the retry also fails, the report-generation
path itself — not the run — is the incident.

## Gather misses

**Signal (page):** a goal gather stored **0 of N requested**
symbols (N > 0) — the run has no dataset to evaluate. The page
carries run id + counts only, never symbol lists.

**Event (no page):** any gather run with missing symbols emits
`goal.gather.missed` (counts only: requested, stored, missing)
into the #1743 stream. A **partial** miss (some symbols stored,
some missing) is event-visible only — the run proceeds on honest
partial coverage, with missing symbols ledger-rejected per symbol.

**What counts as a miss (per the #2056 gather rule):** live alone
supplies rows; Yahoo complements columns only and never stores a
row. So a Yahoo-only symbol IS a miss (its live side failed), a
symbol served by neither side IS a miss, and a live row with
Yahoo-complemented columns is SUCCESS, not a miss. A
legitimately empty universe (0 requested) is neither event nor
page.

**Diagnosis:** the miss event's counts say how much is missing;
the gather's per-symbol `missingFields` (in the run's capture
record) say why per symbol: `quote` (neither side served it),
`quote:live` (Yahoo-only — the live source failed for it),
`provider` (no quotes route to attribute a live provider to).

**Safe intervention:** if the live source is down, the scheduled
stock fallback (labeled Yahoo fallback, scheduled stocks only,
auth-dead only) is the safety net — it does not change what this
gather stored. Re-running the goal screen after the live source
recovers re-gathers under a new run id. Do not hand-fill rows:
a symbol with no valid stored row is missing, never zero-filled.

**Claim note:** one enrich call per runId per run (runId is the
gather's idempotency key). A manual re-enrich with the same runId
would re-page — re-run the screen instead, under a new run id.
