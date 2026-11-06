# Publish stage

**Status:** Design — build in progress · 2026-11-06 · Traces to
#3527 (supersedes #3526), under #1169 · Evidence: the #3527 step-1
survey (code-verified against origin/main) · #CDO-mha7

> This doc describes the design as filed in #3527, with the survey's
> verified account of today's state. Slices S1–S5 land in order;
> until a slice merges, the "today" section is the operative truth
> for that part of the system.

## Today: publishing is glued, not staged

There is no publish step a caller can invoke. Reports reach their
stores through best-effort hooks scattered at generation and store
seams, and the two canonical store seams in
`src/services/scheduledReports.ts` **diverge**:

- `storeReportAtGeneration` (inline seam) writes the row with the
  body inline and fires the index legs — it writes **no R2 body**.
- `storeReportAtGenerationWithR2` (WithR2 seam) additionally puts
  the body JSON to R2 (`reports/<reportId>.json`, `screener` bucket,
  through the BlobStore port) **before** the insert; a failed put
  falls back to the inline row shape and is recorded as such.

Which publish behaviour a report gets is therefore a property of
which seam its producer happened to call. The index legs —
Vectorize embedding (`src/services/reportSemanticIndex.ts`) and the
AI Search items upload (`src/services/reportAiSearchIndex.ts`, the
#2246 hook riding the shared executor `runAiSearchIndexUpload` in
`src/agents/aiSearchPaths.ts`) — fire fire-and-forget from
`fireFanoutIndexLegs` at both seams, fresh and deduped stores alike.
Rendered artifacts (PDF/XLSX/CSV) go to R2 separately at delivery
time via `src/services/reportBlobStore.ts`. Outcomes are recorded
**per document** (`fanout_outcome` JSON on the report row: body,
vectorize, aiSearch statuses) — there is **no per-run record**
anywhere. The corpus upload route chains its index hook inline
after the write; the corpus sync bundles three jobs into one
request, including a reports canonical-index backfill leg that
belongs to the reports workflow (see
[knowledge-corpus.md](knowledge-corpus.md)).

## The stage contract

One operation, callable on any already-stored document:

```
publishDocument(env, doc) -> Promise<PublishOutcome>   // never throws
```

- **Input** — a stored-document reference plus publish metadata:
  kind (`report` | `corpus`), document id, title, source/category,
  and provenance when the caller genuinely has it (owner login, run
  id, stored-at).
- **Targets** — `r2-body`, `vectorize`, `ai-search`. Each target
  resolves content the same way the hooks do today (R2 bodies via
  the BlobStore port), derives index text once, and calls the
  **existing** executors. The stage composes; it reimplements none
  of them.
- **Outcomes** — per target: `published` | `not_attempted` |
  `skipped` | `failed`, carrying the target executor's existing
  stable code where one exists, plus an aggregate catalog code in
  the caller's vocabulary. Callers keep owning their records: the
  report store keeps writing `fanout_outcome`, now from stage
  outcomes; the corpus route keeps rendering its indexing state.
- **Home** — a new module, `src/services/documentPublish.ts`.
  Growing the 1,600-line store module or the Vectorize module would
  deepen the coupling being removed.
- **Never throws** — the best-effort discipline the hooks already
  observe, made explicit as the stage's contract: a publish failure
  is an outcome, never a failed store.

## Call-site migration map

| Slice | Migration |
| --- | --- |
| S1 | Stage core: the four `fireFanoutIndexLegs` firings call the stage for the report index legs |
| S2 | The WithR2 body put becomes the stage's pre-insert `r2-body` target, preserving the atomic-or-honestly-failed contract |
| S3 | Corpus upload route and corpus index backfill call the stage (`kind: "corpus"`) |
| S4 | The corpus sync is unbundled: the reports backfill leg returns to the reports workflow; the sync keeps integrity + corpus publish through the stage |
| S5 | Jobs registered; runs recorded and surfaced (below) |

`discoveryReportPublish` is excluded from v1: it generates its own
artifacts rather than publishing a stored document. Equivalence is
pinned per slice — publish outputs (vector upsert payloads, items
upload id/content/metadata, R2 bytes and keys, `fanout_outcome`
JSON, route response shapes) byte-identical before and after.

## The run-record decision

No new store. The survey found four existing run/outcome
mechanisms, and the design extends two of them:

- **System-surface summary** — the `scheduled_job.outcome` event
  stream (`src/observability/scheduledJobOutcomes.ts`, #2037):
  codes-only outcomes with consecutive-failure streak alerts,
  readable through the existing audit route. Its job vocabulary is
  closed today (three jobs) and the corpus dispatch is not wrapped
  in the tick observer its sibling riders have; S5 extends the
  vocabulary and the observation, gaining streak alerts for free.
- **Per-item detail** — `mas_job_outcomes` (#1333; ports in
  `src/data/jobOutcomePorts.ts`): uniform outcome rows with counts
  and detail, rendered in the Autopilot Control job feed. Run
  records from the stage's jobs land here; the Corpus tab reads the
  same records — one source of truth, two views.

The two mechanisms that were considered and not chosen for this:
`job_run_records` (#2964/#3121) states a hard boundary — Worker
cron triggers never run as jobs — so recording cron riders there
means extending that vocabulary, a ledger-owners' decision, not a
local addition; and `mas_async_jobs` (#2358) is the heavier
queued-lifecycle machinery, reserved for jobs that actually become
async. A run record is written at run start and completed at the
terminal state; an interrupted run resolves to an honest terminal
state under a staleness rule, pinned by tests.
