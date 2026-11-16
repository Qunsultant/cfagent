# 0004. Screener decoupling onto Workflows: port-first, parent/child fan-out, child-owned store/deliver

- Status: accepted
- Date: 2026-10-26
- Deciders: owner, CAIO-quns
- Issue: #1737 (sub-issue of tracker #1736, second in the owner's priority order)
- Implementing PR: (to be filled on merge)

## Context

Screener executions run synchronously inside request handlers:
routes await the full scan and hold the request open, coupling
user-facing latency to scan duration and losing the run if the
request dies mid-scan. The ABoK Target State Blueprint (§19,
Top-10 item 1; `docs/architecture/blueprint/abok-target-blueprint.md`
§12 "Adoption of Cloudflare Workflows for Long-Running Screener
Pipelines", Status Approved — note: this is the blueprint's own
numbering, NOT `docs/architecture/adr/0003-messaging-port.md`
(ADR-0003 in the registry is the queue-backed messaging port;
cite ADRs by full filename, never by number alone) directs
migrating multi-step screening runs to Cloudflare Workflows with
explicit step retries and checkpoints, with the §13 NFRs "Screener
Pipeline Execution 100% Retriable, Max 3 retries per step" and
"Data Integrity Zero Event Loss (at-least-once Queue delivery)".
As with #1739, the blueprint's principle #1 ("Cloudflare Native
First") is SUPERSEDED by owner direction for this program: we
use Cloudflare Workflows, but behind a port, with a second
adapter and a conformance suite as independence proof — the
blueprint is the WHAT, the cloud-agnostic adapter-first rule is
the HOW (same discipline as ADR 0002 and ADR 0003).

The owner stage spec (binding, recorded on #1736) refines the
#1236 stage-layered DAG: Feed (multi-provider collection) and
Gather (combine + enrich) are TWO separate stages; Analysis runs
ONLY on post-gather data; each stage persists its own results
independently so any stage resumes from the prior stage's saved
output; triggers are trigger-agnostic (UX and scheduled events
produce the SAME invocation); stages are resumable, retryable,
async, parallel with configurable parallelism bounded by platform
limits (cf. #1204 subrequest budgeting); any request (one ticker
or all tickers) is sharded into parallel sub-jobs and collated
WITH TIMEOUTS (per-shard timeout → qualified partial results
with audit status, never total failure).

This slice CONSUMES #1739 (messaging port, CloudEvents envelope,
stage-typed eventTypes, slice-2 `agent_shard_jobs` job model)
and does not reinvent any of it. It also decides the design
question #1739 left open (ADR 0003 M10): the collation-state
home for qualified partial results.

## Decision

### W1 — Port-first workflows (non-negotiable)

`WorkflowPort` (`src/workflows/workflowPorts.ts`) with a
Cloudflare Workflows adapter (`cfWorkflowAdapter.ts`) and an
in-memory adapter (`inMemoryWorkflowAdapter.ts`), plus a
conformance suite run unchanged against both
(`tests/screener_workflows.test.ts`). Domain code (flows,
commands, routes) never imports a provider SDK or names a
binding; only the adapter, the workflow class, and the
composition root (`createWorkflowPorts.ts`) touch
`SCREENER_WORKFLOW`. A structural test pins this (no
"cloudflare", `Queue<`, `.ack(`, `.retry(` in the port, flow,
envelope, in-memory adapter, or composition root). The
in-memory adapter is a portability proof and a test double,
NEVER a silent production fallback: the composition root
returns null when the binding or the projection store is
unbound, and callers fall back to the synchronous path.

### W2 — Parent/child fan-out with polling (not waitForEvent)

One parent workflow per job fans out to one child workflow per
shard (same class, role "shard") in batches of
`maxParallelShards` (default 4 — a provider rate-limit guard;
each child has its OWN invocation budget, so fan-out across
invocations IS the subrequest-budget multiplier per the #1785
precedent). The parent polls child statuses on a sleep loop
(poll interval default 15s); it does NOT use `waitForEvent`,
because event-buffering semantics for sends that arrive before
the wait are uncertain, while polling is deterministic. The
parent collects FULL shard results from child instance
`status().output` — summaries + store/deliver flags only, never
bulk data (see W6). Per-shard deadline default 10 minutes;
each shard is marked `timed_out` at ITS OWN deadline, not at
the batch's max deadline. Timed-out children are NOT
terminated: they may still complete and project their own row
(version+1 supersedes the timeout row); the parent collation
stands as the deadline-time truth.

### W3 — Collation-state home: the parent row's resultJson (decides ADR 0003 M10)

The collation lives in the slice-2 projection: the parent
job's `agent_shard_jobs` row (`jobKey = jobId`, chain = jobId)
carries the full `WorkflowCollation` in its capped `resultJson`
(lifecycle, qualified flag, coverage, per-shard outcomes with
stored/delivered flags, store/deliver errors, transitions).
Terminal rails are UNCHANGED (completed/submitted/failed per
leg); "partial" is a RESULT QUALIFICATION on the parent row
(the #462 vocabulary: a qualified partial report is never a
complete screen and never a failure), NOT a rail value and NOT
a new `AsyncJobStatus`. The projection version column is
assigned on write, never carried in messages — resolving both
#1739 M10 mismatches without a contract change. No second job
model is invented: jobId/parentJobId/shardId align with slice-2
(chain/job/leg), and `mas_async_jobs` is NOT written by the
workflow (it is the followup-chain substrate, not the
screen-workflow job substrate). The status surface is the
existing `GET /api/jobs/history?chainId=<jobId>` (+ slice-4 MCP
`agentdb.jobs.history`); both now also return `resultJson`
(additive; the field was already capped, spec-free, and
auth-free per the slice-2 contract). No new status route.

### W4 — Lifecycle as State pattern

Idle → Running → [BudgetConstrained] → Completed | Failed →
ReportGenerated. BudgetConstrained is entered when any shard
failed or timed out but collation still yields a usable
partial (the run continues toward a qualified partial, it does
not fail). Completed = the screen finished (qualified or not);
ReportGenerated = every completed shard stored; Failed = no
shard produced a usable result. The coarser ledger status
(queued/running/completed/failed) is untouched; lifecycle
detail rides in the collation summary. Stage vocabulary is
the owner-spec stages (feed/gather/analysis/store/serve/
deliver) in envelopes, collation, and projection rows; the
legacy `PipelineStage` (feed/generate/store/serve/deliver) is
UNTOUCHED because the workflow writes no `mas_async_jobs`
rows, and `ShardJobRow.stage` is already a free-form string
so gather/analysis values fit without a type change.

### W5 — Idempotency: jobId is the key

`workflowIdForJob(jobId)` derives the instance id
deterministically (`"screen-"` + sanitized jobId); it fails
fast over 100 chars rather than truncating into a collision.
Job ids in this codebase are slot/timestamp keys over a fixed
grammar, so sanitization is injective for them. Duplicate
start adopts the existing instance (create error → get →
existing:true), which also makes retried fan-out steps safe.
A failed JOB is retryable by starting a NEW command with a
NEW jobId; prior partial output is never duplicated (shard
keys + projection replay no-op).

### W6 — Child owns store/deliver (correction of the first design)

The first design had the parent store and deliver from child
outputs. It was WRONG and was replaced before merge: the
parent's child outputs are summaries, and canonical persist
needs the FULL result (opportunities, allStocks, csvKey — a
summary-only persist would have dropped csvKey and broken
#1786 handling). The child therefore owns store and deliver
of its own full result: after executing, it stores (canonical
persist) and, when `command.deliver`, delivers (tracked
pipeline) its full result, records stored/delivered flags +
errors on its output, projects its shard row, and returns the
summary + flags with `full` STRIPPED (claim-check: workflow
outputs and the parent collation never carry bulk data). This
matches the sync path, which already stores and delivers per
shard as they complete. Safety: store is idempotent by key
(canonical generationId `screener:<timestamp>` — a retried
store step overwrites the same row); deliver carries a
deterministic deliveryId (`workflow:<jobId>`, stamped by the
workflow class) so re-delivery converges in the outcome sink
(`recordScreenerRunMainJob` otherwise mints a randomUUID main
job per call — a retried deliver step without the stamp would
fork a second tracked record). Store/deliver errors are
recorded per shard, NOT fatal: a stored-nothing run is
Completed-with-errors, not Failed — the screen itself
succeeded. Residual window, disclosed honestly: a deliver
step retried after the tracked call succeeded but before its
step result persisted can still double-deliver downstream
(the sink converges; the main-job row does not) — a
transactional outbox would close it and is a follow-up, not
this slice.

### W7 — Business vs infrastructure failure

A `runScreen` returning `success:false` is a BUSINESS outcome:
the child completes with a failed output, NO step retry. A
runner THROWING is an infrastructure failure: step retries up
to 3× (blueprint NFR), then the child errors and the parent
marks the shard failed. A failed screen is still stored and
delivered (a canonical record of the attempt, sync-path
parity).

### W8 — Stage honesty

A completed shard ran feed (quotes), gather (technicals/
enrichment), and analysis (screen) inside the delegated
screen, in that order — so the parent records
feed/gather/analysis completed for it. A failed or timed-out
shard records ONLY analysis.failed: how far its internal
pipeline got is unobserved, so feed/gather are left
unrecorded rather than claimed. (In current code the
technicals/grades joining runs after the screen call; the
workflow records stages by the spec's order, with this
honesty rule as the guard.)

### W9 — S5/S6 link, not duplication

#1717 Adapter S6 (#1780, durable-workflow port) covers
trade-approval workflows ONLY; S5 (#1779, actor-gateway
port) covers DO dispatch/RPC, not workflow execution. Both
were open and unimplemented at slice start, so there was no
port to consume. This slice defines the screener
WorkflowPort, LINKS S5/S6 here and in the PR, and leaves
convergence of workflow ports as a future decision — never
forced, never duplicated, never touching their branches.

### W10 — Open screener issues: no regression, no absorption

- #1718 (coverage floor): the collation carries coverage +
  qualified flag and the completion vocabulary carries
  `partial` (#462), so #1748's floor logic applies to
  workflow runs; broadcast wording stays with the delivery
  path + #1748 (CEO lane, untouched).
- #1789 (slot dedup): idempotent start by slot jobId (first
  line) + the screen's own `claimScheduledExecution` inside
  `runScreen` (second line).
- #1786 (webhook csvKey): already fixed on main (73d2937);
  the child store step persists the FULL result including
  csvKey via the existing canonical seam, so the fix cannot
  regress through this path.

### W11 — Scheduled screens are NOT cut over in this slice

The workflow supports scheduled triggers from day one
(`source=scheduled-tasks`, slot jobIds), but
`autonomousMarketScreen`'s post-steps are NOT fully covered
by the workflow path: the `last_runs` UX surface
(`screener:last_runs` in DO storage), the live-client
`market_alert` broadcast, #1355 sharded-chain semantics, and
#1329 stage-chain stamping have no workflow-side equivalent,
and #1499 preset resolution lives inside the service. Cutting
over would silently drop those surfaces. Follow-up: cut
scheduled screens over once last_runs + broadcast have
workflow-side equivalents (or the callback keeps them as
post-completion hooks fed by collation reads), with reason
recorded here rather than absorbed silently.

### W12 — Async start is best-effort, sync is the fallback

Routes take the async path only on an explicit opt-in flag
(query `async=1` / body `async`, stripped before schema
validation). Default is sync, unchanged. If the workflow
port is unavailable (unbound workflow, unbound projection
store) or the start fails for any reason, the route falls
back to sync with a console warning — an opt-in flag must
never 500 a screen the sync path can serve. The async path
audits the enqueue (`etrade.screen_enqueued`,
`market_data.screener.enqueued`); it does NOT persist, publish, or
audit-as-complete inline (the workflow owns store/deliver).
Premium async returns a handle object (the payer polls
job/report paths); premium has no audit in its route context,
so no enqueue audit there. The 202 body is
`{jobId, workflowId, status: "queued", existing?,
statusUrl}` where statusUrl points at jobs/history.

### W13 — ThinkWorkflow base, agent type `any` (not WorkflowEntrypoint)

`ScreenerScreenWorkflow` extends `ThinkWorkflow`, not
`WorkflowEntrypoint`: WorkflowEntrypoint is undefined outside
workerd — the first version of this slice used it and 28 test
files failed to collect with "Class extends value undefined"
(the `cloudflare:workers` stub in vitest carries no such
value). ThinkWorkflow is the repo's real runtime base
(TradingTradeWorkflow proves it, in workerd and in vitest).
The agent type is intentionally `any`: ThinkWorkflow
requires a Think agent, no Think agent exists for screener
(ScreenerAgent is an Agents SDK `Agent`), and this class
never uses agent tracking — runs are tracked via D1
projection rows + instance status, which is the design. The
class is a thin adapter (same shape as
TradingTradeWorkflow): validate userLogin (fail closed,
#1185), build deps, dispatch by role. Step retries carry a
1-second adapter-owned delay (the provider requires a delay;
the flow carries only a limit); sleep ceilings milliseconds
to whole seconds (the provider has no ms label) — poll
granularity only, since deadlines are enforced by the flow's
clock checks.

### W13 supersession — PortThinkWorkflow port base (2026-11-16, issue #4924)

W13's decision stands in substance: ThinkWorkflow remains the runtime
base, the agent type stays `any`, and each workflow class stays a thin
adapter. What changes is the shape: the five workflow classes no longer
extend ThinkWorkflow directly. They extend `PortThinkWorkflow`
(src/workflows/portThinkWorkflow.ts), a thin intermediate base that
forwards the SDK base's generic parameters unchanged and carries no
behavior. The port module is the sole "@cloudflare/think/workflows"
import site in src/; the per-class "foundation adapter" framing in W13
and in the agent-conformance pin is superseded by this single seam.
The port/adapter standard requires external execution surfaces behind
a named seam; the earlier direct-extension convention was a scope
exclusion in the PortThink adoption, not an exemption. No behavior
change, no binding change: `instanceof` chains are preserved and the
wrangler bindings name the classes, not the base.

## Consequences

- Every synchronous screener route (etrade, market-data, premium)
  has an async Workflow path; the request returns 202
  without awaiting the scan. Ticker-level sharding is OUT
  (options world, #1785 territory) — v1 shards are universes
  or explicit symbol sets.
- The parent row's `resultJson` is the collation record; a
  parent that dies before project-final leaves shard rows
  without a parent row (existing `/api/jobs/reconcile`
  covers rails jobs, not workflow parents — follow-up).
- The work-queue consumer that starts workflows from
  run-screen command envelopes is a FOLLOW-UP (ADR 0003
  follow-up, carried forward): in v1, commands travel as
  workflow params (routes start workflows directly) and the
  envelope form (`workflowCommandEnvelope.ts`) makes them
  queue-carriable later. DLQ wiring lands with that first
  job consumer (queue-native dead-lettering + inspection/
  replay on existing audit surfaces, no duplicate store).
- Orchestrator size pin rises 2150 → 2200 lines in this PR
  (two public doors + doc comment; bytes keep 103_300) per
  the §7 pin rule.

## Follow-ups (not absorbed)

- Work-queue consumer starting workflows from run-screen
  command envelopes + DLQ wiring with the first job consumer.
- Ticker-level sharding (options world, #1785 territory).
- Workflow parent-row reconcile from shard rows.
- Scheduled-screen cutover (W11) once last_runs + broadcast
  have workflow-side equivalents.
- Premium async delivery-channel design, if the
  handle-object + poll pattern proves insufficient.
- Durable cross-instance dedup store (from #1739; instance
  seen sets do not span isolates).
- Convergence of workflow ports with #1717 S6's future
  ApprovalWorkflow port.
- Transactional outbox for the deliver retry window (W6).
- Repeated-async-fallback alerting (W12 warns to logs today).
- Full-production run proof: an async screen executed
  end-to-end against live bindings (this slice proves the
  port, flows, adapters, and routes under fakes + the
  in-memory adapter; the provider path is exercised by CI
  build/typecheck, not by a live run).
