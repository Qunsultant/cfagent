# Workflow Runs — the run ledger and its read surface

The **Workflow Runs** tab (`?tab=workflow-runs`) answers one question
end-to-end: *what did the workflow engine actually do?* It is a read
surface over the run records the platform already writes — no new
writer, no second copy of any run.

## What a "run" is

A run is one recorded execution. The ledger forms runs from two systems
of record:

| Source | Grain | What it contributes |
| --- | --- | --- |
| `mas_async_jobs` (Durable Object SQLite) | one job = one stage; jobs sharing `chain_id` (or a parent) = one run | ordered stages, per-stage status/timing, payload inputs, `result_json` outputs, `error`, job kind, channel, chain/parent identity |
| The engine's stage checkpoint (`job_pipeline_instances.stage_checkpoint_json`, read through the ScheduledAgent's job-status surface) | one engine job = its own definition's stages (a screener job: feed · enrich · analyze · store · serve · deliver) | the run's **real** stages while it runs and after it settles: per-stage status from the recorded unit states, and per-stage start/end/duration from the stamps the engine writes at each unit's start and terminal transition (#4359) |
| `mas_screening_activity`, `kind = "stage"` | one stage transition | the terminal state of a stage — including **skipped** and **held** — with its reason, attached to the job stage it describes or shown as its own `stage-transition` row |
| `mas_job_outcomes` | one run outcome | the recorded trigger, scan counts, coded error, artifact keys, per-channel delivery states, producer origin |

An outcome whose id names one of a run's jobs (directly, or via the
`workflow:<jobId>:<shard>` delivery id) is that run's outcome. An
outcome with no job twin is its own run — a discovery run or a
synchronous screen must not disappear from the ledger just because it
has no job tree.

## What the tab shows

- **One row per run**: start/end, workflow and run id, trigger badge
  plus the evidence text, status, duration, stage progress, and a result
  summary (matched/scanned, artifact count).
- **Run detail dialog**: the recorded failure, the trigger and who/what fired
  it, every stage in execution order (status, recorded-by, timing,
  description, reason, error), the run's normalized inputs and outputs,
  artifact links, delivery states, and a per-stage inputs/outputs
  disclosure. It opens in the shared `Modal` primitive (`size="xl"`):
  Escape, the backdrop, or the close button dismisses it; focus stays
  inside while it is open and returns to the row's Details button on
  close.
- **Filters**: trigger, status (including "in flight"), and free-text
  search across run id, workflow, stage, and error text.

## Trigger classification

`trigger` is `manual`, `scheduled`, `autonomous`, `webhook`, `agent`, or
`unknown`; the detail string names the evidence ("Scheduled — recorded
by job-tree", "Goal goal-42", …). The classification never guesses from
a label: a run whose stores record no trigger renders **Not recorded**.

## Honesty rules

- A field a store does not record is `null` and renders as "Not
  recorded" or "—", never invented.
- A run with no stage records says so; stages are never inferred from a
  family or a title.
- Stage timing is **recorded, never inferred** (#4359): the engine stamps a
  unit's `startedAt` when it starts and `endedAt` on its terminal transition,
  and the surface subtracts them. A stage with no stamps shows no times. A
  checkpoint that belongs to another run is never projected onto this run's
  row; the row keeps an honest empty stage list instead.
- Inputs and outputs are **summaries**: only whitelisted fields are
  surfaced, secret-shaped keys are redacted, long strings are clipped,
  and arrays/objects are bounded. Raw payloads and `result_json` never
  leave the Durable Object.
- Each store is read defensively. A failed store is named in
  `storeErrors` and the rest of the ledger still renders.

## Read surface

`GET /api/workflow-runs?limit=<1..100>` (default 40), forwarded by
`src/server.ts` to the caller's Orchestrator Durable Object at
`GET /workflow-runs`. Response:

```jsonc
{
  "count": 12,
  "runs": [ /* WorkflowRun[] — stages, inputs, outputs, artifacts, … */ ],
  "summary": { "total": 12, "completed": 8, "partial": 1, "failed": 2, "active": 1, "byTrigger": { … } },
  "storeErrors": { "stages": "…" },   // only when a store failed
  "generatedAt": "2026-10-28T09:00:00.000Z"
}
```

The route is session-gated by the generic `/api/` forwarder and
session-scoped in the Durable Object (jobs by session, stage
transitions by the verified login). `workflow-runs` is listed as an
immediate read surface in both the Worker forwarder and the Durable
Object entry, so a GET is never turned into a queued async job.

## Code map

- `src/services/workflowRuns.ts` — the run model, normalizers, trigger
  classification, redaction, merging (pure; unit-tested).
- `src/agents/routes/workflowRuns.ts` — the route: store reads (each
  defended), response shape.
- `src/client/WorkflowRunsPanel.tsx` — the tab, built only from
  `src/client/components/ui/` primitives.
- `src/client/workflowRuns.css` — layout only, token values only.
- Tests: `tests/workflow_runs.test.ts`,
  `tests/workflow_runs_route.test.ts`,
  `tests/workflow_runs_panel.test.tsx`.

## Known limits

- Trade approvals (`TradingTradeWorkflow`) and payment workflows
  (`PaymentWorkflow`) are settled in their own ledgers — Approvals,
  Billing, and the order ledger — and are not duplicated here.
- Runs executed by the separate ResearchAgent are not part of this
  ledger (it keeps its own `research_runs` store).
- A Cloudflare Workflow's internal retries are visible only through the
  stage rows/transitions the flow projects; the ledger does not query
  the Workflows runtime.
- Payload/result summaries intentionally omit fields outside the
  whitelist, so a bespoke job capability may show fewer inputs than it
  stored. The raw record remains the source of truth in its home store.
