# Survey — #3527: Publish as its own workflow stage (step 1)

- **Survey base:** `origin/main` @ `646fcffadb7c7f4c4421bdbd87b9a87a3322823c` (2026-11-06, fetched fresh for this survey).
- **Method:** read-only code survey. Every claim in §§1–4 is a verified code fact with `file:line` evidence. §5 and the proposals in §3/§4 are labelled proposals, not facts.
- **Read from:** detached worktree `~/workspace/w1169/survey-3527-wt` at the SHA above.

---

## 1. Report pipeline end-to-end

### 1.1 Generation (who produces a report)

There is no single generator; producers converge on the store seams in `src/services/scheduledReports.ts`:

| Path | Entry | Store call |
|---|---|---|
| Scheduled screens / discovery | `ScheduledTasksService` (`src/services/scheduledTasks.ts:404`), instantiated by the orchestrator (`src/agents/orchestrator.ts:1245`) and by Agents-SDK schedule callbacks (`src/agents/orchestrator/scheduledCallbacks.ts:240`) | `runReportPipeline` (`scheduledTasks.ts:2864-2865`), `storeReportStage` (`scheduledTasks.ts:3662`) |
| Screener / parent-screen / research canonical persists from delivery flows | `src/agents/orchestrator/reportDispatch.ts` | `storeReportAtGenerationWithR2` at `reportDispatch.ts:170`, `:329`, `:512` |
| Options research runs | `src/agents/orchestrator/researchPublish.ts` (`runResearchAndPublish`, called from `orchestrator.ts:798`) | `storeReportAtGeneration` (`researchPublish.ts:110`); PDF via `generateReportStage` (`researchPublish.ts:77-78`) |
| On-demand options screen route | `src/agents/routes/etradeOptionsScreen.ts:373-374` | `runReportPipeline` |
| Recommendation bundles | `src/services/recommendationBundle.ts:741` | `storeReportStage` |

`src/services/unifiedReportPipeline.ts` is the stage vocabulary the producers share (#914, split into stages by #1329 C4 — header, `unifiedReportPipeline.ts:1-27`):

- `generateReportStage` (`:138`) — PDF bytes via the ReportAssetAgent (`generatePdfAsset`), with retry policy; never throws (failure = `pdfStatus:"failed"` in the output).
- `runReportPipeline` (`:210`) — the fused legacy entry; today it is *only* the generate stage.
- `storeReportStage` (`:245`) — delegates to `orm.storeCanonicalReport`, which is `ormFacade.ts:733` → **`storeReportAtGeneration` (the inline variant only)**. The R2-body variant is reachable only by calling `storeReportAtGenerationWithR2` directly (reportDispatch does; the pipeline's store stage does not).

### 1.2 Canonical store

- One canonical copy per report (#308): `mas_reports` table in the tenant's orchestrator Durable Object SQLite, written through the canonical-report store ports (`src/data/canonicalReportStorePorts.ts`); the seam functions are `storeReportAtGeneration` (`scheduledReports.ts:741`, synchronous, body inline) and `storeReportAtGenerationWithR2` (`scheduledReports.ts:892`, async, body to R2). Both are idempotent on `(user_login, generation_id)` and never throw (null on failure, logged with `REPORT_FANOUT_FAILED`).
- Row shape: metadata + summary + search fields, plus either the inline body or a `body_r2_key` pointer, plus a `fanout_outcome` JSON column (§1.4).

### 1.3 Every publish / index action after (or inside) the store

**(a) Canonical body → R2 — inside the store, WithR2 variant only.**
`storeReportAtGenerationWithR2` puts the body to the `REPORTS_BUCKET` (the `screener` bucket) at `reports/<reportId>.json` (`reportBodyR2Key`, `scheduledReports.ts:1318-1321`) through the BlobStore port **before** the row insert (`scheduledReports.ts:957-979`). A failed put falls back to the exact inline row shape and is *recorded* (`body:"inline_fallback"`, §1.4). Trigger: inline at store, fresh writes only (dedupe never rewrites the object). The synchronous seam writes no R2 body at all — **the two store variants have divergent publish behaviour, chosen by the caller.**

**(b) Semantic index → Vectorize — fire-and-forget at every store seam.**
`fireFanoutIndexLegs` (`scheduledReports.ts:327-368`) fires `indexCanonicalReport` (`src/services/reportSemanticIndex.ts:210`) on fresh **and** deduped stores, in both store variants. It builds the searchable text with `buildCanonicalIndexText` (`reportSemanticIndex.ts:141`, per-source formulas), resolves R2 bodies best-effort, embeds via `VectorMemory` (Workers AI `@cf/baai/bge-base-en-v1.5`), and upserts vector id `report:<reportId>` with metadata `{kind:"report", reportId, title (≤200 chars), source}` (`reportSemanticIndex.ts:56-86`). Best-effort: never throws; `retention` source excluded (`INDEX_EXCLUDED_SOURCES`, `reportSemanticIndex.ts:118`); absent AI/Vectorize bindings = silent no-op.

**(c) AI Search index → instance items API — fire-and-forget beside (b).**
The same `fireFanoutIndexLegs` fires `indexCanonicalReportInAiSearch` (`src/services/reportAiSearchIndex.ts:92`, the #2246 hook). Flag-gated by `AI_SEARCH_REPORT_INDEXING_ENABLED` (absence = off). Document id `report:<reportId>`; content = title + the **same** `buildCanonicalIndexText` output the Vectorize leg embeds; metadata `{kind:"report", reportId, source, runId?, ownerLogin?, storedAt?}` (`reportAiSearchIndex.ts:117-139`). The actual upload is the shared executor `runAiSearchIndexUpload` (`src/agents/aiSearchPaths.ts:696`): `env.AI_SEARCH.get(AI_SEARCH_INSTANCE).items.upload(id, content, {metadata})` — namespace binding only, no MCP/REST upload path. Never throws; failure is a `console.warn` with the stable code `ai_search_report_index_failed` plus the outcome recorded per §1.4. **No backfill exists for this leg** (deliberate, `reportAiSearchIndex.ts:41-44`): historical reports are not migrated into the instance.

**(d) Artifact blobs (PDF/XLSX/CSV) → R2 — at generation/delivery time, not at canonical store.**
`putReportPdf` (`src/services/reportBlobStore.ts:107`) writes bytes through the BlobStore port to `REPORTS_BUCKET` under the `r2KeyForStorageKey` layout (`reportBlobStore.ts:74-94`: `screener:`→`stocks/`, `options:`→`options/`, `goal_screen:`→`goals/`, `knowledge:`→`knowledge/`, others passthrough) and writes a small metadata pointer `{r2Key, fileName, storedAt}` to DO storage; with no bucket bound it stores base64 in DO storage instead. `putReportPdf` itself **can throw** (it awaits the put); callers wrap it. Callers: ReportAssetAgent — the single PDF-generation owner — (`src/agents/report-asset-agent.ts:100`), `src/agents/research-agent.ts:691-694,747,770`, `src/agents/screener-agent.ts:2041-2173,2449-2466`, and `generateAndStoreDiscoveryReport` (`src/services/discoveryReportPublish.ts:36`), which generates PDF/XLSX/CSV per format under deterministic keys `discovery:<format>:<runId>`, retries each put, and returns a per-format status outcome — the publish function persists nothing itself; the artifact keys/statuses ride into the canonical body via `buildDiscoveryCanonicalBody` (`discoveryReportPublish.ts:121`).

**(e) Canonical-index backfill — the repair path (Vectorize leg only).**
`runCanonicalIndexBackfillPage` (`reportSemanticIndex.ts:267`) pages `mas_reports` through the read port and calls `indexCanonicalReport` per row. Two callers: the route `POST /trading/reports/index-backfill` (`src/agents/routes/reports.ts:753`) and `runCanonicalIndexBackfillAll` (`src/services/corpusSync.ts:397`) — the latter is how the corpus sync acquired its reports leg (§2.3).

### 1.4 What outcome/run record exists for reports

Per-**document**, yes; per-**run**, no. Every store records a `CanonicalReportFanoutOutcome` on the row (`fanout_outcome` column; type at `scheduledReports.ts:215-225`): `outcome` (`stored_r2 | stored_inline | stored_inline_fallback | deduped`), catalog `code` (`REPORT_FANOUT_STORED` / `REPORT_FANOUT_DEGRADED`), `body` status, and per-leg `vectorize` / `aiSearch` statuses (`pending → indexed | failed | not_attempted`, plus `aiSearchCode`), updated in place as the fire-and-forget legs settle (`recordFanoutLegOutcome`, `scheduledReports.ts:276-298`; read back via `getCanonicalReportFanoutOutcome`, `:301`). A failed INSERT stores no row — the failure exists only as a log line. There is **no run-level record** of a generation→publish batch anywhere.

### 1.5 What "publish reports to R2" concretely consists of today

Exactly two things, both inline in generation/store code, neither a step that can be invoked on its own:

1. the canonical body JSON at `reports/<reportId>.json` — only on the `storeReportAtGenerationWithR2` seam; and
2. rendered artifact blobs via `putReportPdf` under the `stocks/`, `options/`, `goals/`, `discovery…` key families.

Both target the `screener` bucket behind the `REPORTS_BUCKET` binding, through the one BlobStore port. Everything else called "publishing" for reports is indexing (Vectorize, AI Search items), not R2.

---

## 2. Corpus flow

### 2.1 Upload route

`POST /api/knowledge/corpus` → branch in `src/agents/routes/knowledgeCorpus.ts` (validation at `:270-297`; `putKnowledgeDoc` call at `:298`) → `putKnowledgeDoc` (`src/services/knowledgeCorpus.ts:133-196`):

- validates session/title/category/sourceUrl/bytes, computes `sha256Hex`, storage key `knowledge:<category>:<sha256>`;
- idempotent: an existing record with the same hash returns without rewriting;
- puts bytes through the BlobStore port at bucket key `knowledge/<category>/<sha256>` (via `r2KeyForStorageKey`) with custom metadata, then writes the `KnowledgeDocMeta` record to DO storage at the storage key;
- **can fail the caller**: it throws `KnowledgeCorpusError` (no bucket bound, validation) and the route maps that to 400/500 — deliberately unlike the never-throws report seams.

Immediately after a successful put, the route **awaits** `indexCorpusDocInAiSearch` (`routes/knowledgeCorpus.ts:312-315`) and returns its state in the response body (`indexing: { state }`, `:317-326`). The state is persisted nowhere.

### 2.2 The corpus index hook — reuse of the #2246 executor

`indexCorpusDocInAiSearch` (`src/services/corpusAiSearchIndex.ts:161`) is a sibling of the report hook, not a second uploader: it calls the same `runAiSearchIndexUpload` executor (`aiSearchPaths.ts:696`). Corpus-specific parts: document id `corpus:<bucketKey>` (`corpusIndexDocumentId`, `knowledgeCorpus.ts:263`), text derivation `deriveCorpusIndexText` (`corpusAiSearchIndex.ts:124` — title/source/category header + the document's own text, HTML stripped; non-text bytes such as the OCC PDF contribute the header only, no PDF extractor exists in-repo), metadata `{kind:"corpus", key, sha256, storedAt: ingestedAt, title, category, sourceUrl}`, flag `AI_SEARCH_CORPUS_INDEXING_ENABLED`, and the rendered state vocabulary `indexed | not-configured | failed`. Never throws.

### 2.3 Sync route + tick rider

- **Tick:** wrangler cron `*/30 * * * *` (`wrangler.jsonc:185-192`) → Worker `scheduled()` → the tick branch in `src/server/routes/queue.ts`. The corpus dispatch (`queue.ts:314-327`) is a plain `agent.fetch(POST https://agent.internal/knowledge/corpus-sync)` under `waitUntil`. Unlike its sibling riders — research (`:260`), reflection (`:278`), adaptation (`:296`) — it is **not** wrapped in `observeTickDispatch`, and `/knowledge/corpus-sync` is not one of the observed dispatch paths (`scheduledJobOutcomes.ts:93-104`).
- **Route:** `POST /knowledge/corpus-sync` (`routes/knowledgeCorpus.ts:345`). Session-gated. Weekly guard `shouldFireCorpusSyncTick` (`src/services/corpusSync.ts:95`) over the durable marker `corpus_sync_last_run` in `mas_settings`; a skip returns `{skipped, reason, lastFiredAt}` in the response only. On fire it calls `runCorpusSync` (`corpusSync.ts:341`) with three legs:
  1. **Integrity** — `runCorpusIntegrityCheck` (`corpusSync.ts:157`): seed manifest (`docs/knowledge-corpus-seed-manifest.json`, imported at `routes/knowledgeCorpus.ts:80`) vs DO records vs paginated `knowledge/` bucket listing; missing/mismatched/extra by the corpus module's own SHA-256 scheme. Corpus-specific.
  2. **Report backfill** — `runCanonicalIndexBackfillAll(ctx.env, sql)` injected by the route (`routes/knowledgeCorpus.ts:368-374` region): this is **report machinery** (leg §1.3e — it re-embeds `mas_reports` rows into Vectorize) riding inside the corpus sync.
  3. **Corpus index backfill** — `runCorpusAiSearchIndexBackfill` (`corpusAiSearchIndex.ts:261`) injected likewise: enumerates manifest ∪ bucket-listed `knowledge/` keys, hash-verifies record+object, uploads per item through the §2.2 hook.
- The marker is written **only** when `result.completed` (the integrity leg executed). The full result is returned in the POST response; the Corpus tab holds it in component state (`src/client/search/tabs/CorpusTab.tsx:157`, rendered `:304+`). **Nothing about a run — manual or scheduled — is persisted** beyond the last-run timestamp marker. This is the invisibility the owner hit: a completed-or-failed scheduled run leaves no readable trace in the system.

### 2.4 Reuse map (corpus vs report machinery)

| Piece | Shared | Corpus-specific |
|---|---|---|
| Blob storage | BlobStore port + `r2KeyForStorageKey` (`reportBlobStore.ts:74`) | — |
| AI Search upload | `runAiSearchIndexUpload` executor (one implementation) | doc-id scheme, text derivation, metadata, flag |
| Index backfill page fn | `runCanonicalIndexBackfillPage` (reports) injected into the sync | corpus backfill enumeration in `corpusAiSearchIndex.ts:261` |
| Store/write | — | `putKnowledgeDoc` (own validation + record scheme) |
| Integrity | hash scheme helpers from `knowledgeCorpus.ts` | the whole check |

---

## 3. Coupling points and the extraction seam

### 3.1 Where publish is fused to generation/store today (verified)

1. **The store module owns publish orchestration.** `fireFanoutIndexLegs` lives in `scheduledReports.ts` and is invoked from four sites — fresh + dedupe in each store variant (`scheduledReports.ts:808-872` and `:933-1015` regions). Adding or changing an index target means editing the store module twice over; the legs' outcome-recording (`recordFanoutLegOutcome`) is also store-module code writing the store's own row.
2. **The R2 body publish is interleaved with the INSERT.** In `storeReportAtGenerationWithR2` the put must precede the insert and its failure changes the row's shape (inline fallback) — publish and storage are one operation there, while the sibling seam omits the R2 leg entirely, so "which publish happens" is a property of which store function the caller picked.
3. **Text derivation is shared but owned by one leg.** `buildCanonicalIndexText` lives in the Vectorize module; the AI Search hook imports it from there (`reportAiSearchIndex.ts:44-48`). Good reuse, wrong owner: the AI Search leg depends on the Vectorize module for its content.
4. **The corpus route chains publish inline.** The upload handler awaits the index hook after `putKnowledgeDoc` (`routes/knowledgeCorpus.ts:298-315`); publish-after-write policy (fire on replay too, state in response) is route code.
5. **The corpus sync's legs are injected by the route** (`routes/knowledgeCorpus.ts:368-385` region) — already a seam, but the *composition* (which legs, in which bundle) is decided in the route, which is how a reports leg ended up bundled into the corpus job.

### 3.2 Proposed stage contract (proposal)

One stage function, callable on any already-stored document:

```
publishDocument(env, doc, deps?) -> Promise<PublishOutcome>   // never throws

doc = {
  kind: "report" | "corpus",
  documentId: string,            // reportId | corpus storage key
  title: string, source/category: string,
  ownerLogin?: string, runId?: string, storedAt?: string,   // provenance, when the seam has it
  body?: string, bodyR2Key?: string | null,                 // report: inline body or pointer
  meta?: KnowledgeDocMeta, bytes?: Uint8Array               // corpus: record + served bytes
}

PublishOutcome = {
  targets: Array<{
    target: "r2-body" | "vectorize" | "ai-search",
    status: "published" | "not_attempted" | "skipped" | "failed",
    code?: string                  // the target executor's existing stable code
  }>,
  code: <catalog code>             // aggregate, caller's vocabulary
}
```

The stage resolves content (R2 body via the BlobStore port, as both index hooks already do), derives text once, and calls the **existing** executors — `indexReport`/`indexCanonicalReport` internals, `runAiSearchIndexUpload`, the BlobStore put — it does not reimplement any of them. Callers keep owning their records: the report store keeps writing `fanout_outcome` (from the stage's per-target outcomes), the corpus route keeps rendering `indexing.state`.

### 3.3 Natural home (proposal)

A **new module `src/services/documentPublish.ts`** — growing `scheduledReports.ts` (1,616 lines, store-owned) or `reportSemanticIndex.ts` (Vectorize-owned) would deepen the coupling being removed. The credible alternative is `unifiedReportPipeline.ts` beside `storeReportStage` (it already speaks generate/store/serve stages), but that file is the screener-pipeline's home and the stage must serve the corpus equally; a shared module both pipelines import is the cleaner fit. Decision for the build slice, flagged here.

### 3.4 Call sites that migrate (proposal)

- `scheduledReports.ts`: the four `fireFanoutIndexLegs` firings → one stage call per store; `recordFanoutLegOutcome` stays (it owns the row) but consumes stage outcomes.
- `storeReportAtGenerationWithR2`: the body put becomes the stage's `r2-body` target executed pre-insert, returning the body outcome the row records — preserving the #2347 atomic-or-honestly-failed contract exactly.
- `routes/knowledgeCorpus.ts` upload branch: post-put hook → stage call (`kind:"corpus"`).
- `corpusAiSearchIndex.ts` backfill: per-item stage call instead of calling the hook directly (or the hook becomes the stage's corpus adapter — same code, new owner).
- `discoveryReportPublish.ts`: **not** migrated in v1 — it *generates* its artifacts (generation, not publish of a stored document); its `putReportPdf` calls are flagged as a later artifact-target candidate.

---

## 4. Jobs / runs surface today

### 4.1 How jobs are defined, registered, scheduled

There is no job registry for platform jobs. Three scheduling systems coexist (as the Jobs UI itself states, `src/client/JobsPanel.tsx:1-9`):

1. **ScheduledAgent goals** — Agents-SDK goals on the ScheduledAgent DO (own KV store).
2. **Orchestrator schedules** — Agents-SDK schedule table in the orchestrator DO; callbacks execute through `ScheduledTasksService` (`scheduledCallbacks.ts:240`).
3. **Worker cron triggers** — deployment config (`wrangler.jsonc:185-192`: `0 3`, `*/30`, `0 4` UTC); the `*/30` tick branch in `src/server/routes/queue.ts` hand-dispatches internal POSTs to DO routes. Platform jobs (research, reflection, adaptation, corpus sync, digest) are **hand-coded riders in that branch** — "registration" means editing `queue.ts` plus the target route.

`src/services/scheduledTasks.ts` (4,876 lines) is not a registry: it is `ScheduledTasksService` (`:404`), the execution service for autonomous screens/discovery/token-renewal invoked by the orchestrator and schedule callbacks.

### 4.2 What run/outcome recording already exists (do not duplicate)

**(a) Job run records — `job_run_records` (#2964, #3121).** One record per run (`buildJobRunRecord`, `src/services/jobRunRecords.ts:56` — validation is the honesty gate: a failure without error text and a skip without a reason *cannot be constructed*), stored DO-resident via `src/data/jobRunRecordPorts.ts` + `doSqliteJobRunRecordAdapter.ts` (orchestrator table `job_run_records`, cap 100/job) and under the ScheduledAgent's `jobRunRecords` KV key (cap 500). **Hard boundary, stated in the port:** `JobRunSystem = "scheduled-agent-goal" | "orchestrator-schedule"` and *"Worker cron triggers never run as jobs, so they have no records and no value here"* (`jobRunRecordPorts.ts:36-42`). The corpus sync is a Worker-cron rider — it cannot be recorded here without extending the system vocabulary, which is a #3121-ledger design decision, not a local addition. Surfaced by `JobsPanel.tsx` and the consolidated ledger `ScheduleRunLedgerPanel.tsx` via `jobsApi` (`listScheduleRuns` / `listGoalRuns`), with the §4 linkage fields (`trigger`, `scheduleId`, `asyncJobId`, `workflowId` from `src/services/consolidatedScheduling.ts`; tick linkage `WORKER_TICK_CRON = "*/30 * * * *"` at `:184`).

**(b) Scheduled-job outcomes — `mas_events` type `scheduled_job.outcome` (#2037).** `src/observability/scheduledJobOutcomes.ts`: one sink, codes-never-messages payloads `{job, outcome: ran|skipped|failed, traceId, errorCode?, reason?, linkage}`, consecutive-failure streak counting from the sink itself, Slack alerting at streak thresholds, readable through the existing `GET /audit` route. **Closed vocabulary:** `ScheduledJobId = "reflection" | "research" | "adaptation"` (`:45`) and only those three dispatch paths are observed (`:93-104`). Recording happens inside the jobs' routes (`src/agents/routes/scheduledJobOutcome.ts:200`, `screenerResearch.ts:118`, `etradeBrokerLearning.ts:101`) and via `observeInternalDispatch` on dispatch rejection. The corpus sync is in none of this: unobserved dispatch (§2.3), no outcome rows, no streak, no alerts.

**(c) Job outcomes — `mas_job_outcomes` (#1333).** `src/services/jobOutcomes.ts` (shim over `src/data/jobOutcomePorts.ts` / `doSqliteJobOutcomeAdapter.ts`): uniform outcome rows (job id, kind, trigger, status, counts, coded error, artifact links, delivery states), upserted by stable run id, rendered by the Autopilot Control job feed. Producers: job-tree hook, bus subscriber, goal-screen, discovery, manual paths.

**(d) Async jobs — `mas_async_jobs` (#2358, #1976 step 4a).** Ports in `src/data/asyncJobPorts.ts` + `createAsyncJobPorts.ts` + DO/in-memory adapters; runtime in `src/agents/orchestrator/asyncJobs.ts` (1,775 lines): submit → queued/running → completed/failed with stale reaping; capability jobs include `followup.report` (the report serve stage's job form, `asyncJobs.ts:1037+`), `followup.deliver`, `followup.notify`; the already-running gate reads active payloads via `asyncJobGate.ts` / `hasActiveChain`.

**(e) Per-document fanout outcomes** on `mas_reports` (§1.4) — document-level, not run-level.

### 4.3 Precisely what a corpus-sync registration plugs into (proposal, grounded in §4.2)

- **Summary outcome:** extend (b) — add `"corpus-sync"` to `ScheduledJobId`, add `/knowledge/corpus-sync` to `isScheduledJobDispatchPath`, wrap the `queue.ts` dispatch in `observeTickDispatch`, and record `ran|skipped|failed` from inside the sync route (the pattern the other three jobs use). Zero new storage; gains audit readability + streak alerts. The outcome payload is codes-only by design (reason ≤ 64 chars) — it **cannot** carry the per-item detail.
- **Per-item detail:** persist the sync result as a run record the Corpus tab reads on load. Options in order of fit: (i) extend (a)'s `JobRunSystem` with a worker-cron value — contradicts the port's stated invariant; needs the ledger owners' decision; (ii) record a (c) JobOutcome per run (counts + artifact/detail payload fit its shape; rendered in Autopilot Control, not the schedules ledger); (iii) a small corpus-sync run record in the orchestrator DO (new storage — justified only if (i)/(ii) are rejected on the record). The survey's recommendation: (b)-extension for the system surface + (ii) for detail, Corpus tab reading the latest JobOutcome — **no new store**. Flagged as the build's first design decision.
- The manual path returns promptly per #3526's shape: the route records `running`-equivalent state only if the sync becomes an async job under (d) — a heavier step; v1 can keep the inline run but must persist its record before responding (the record, not the spinner, becomes the contract).

---

## 5. Slice plan for #3527 (proposal)

Order is merge-sequenced; each slice is one PR under the gitops policy. Equivalence pins compare publish outputs **byte-for-byte** on fixtures before/after (vector upsert payloads, items-API upload id/content/metadata, R2 object bytes+keys, `fanout_outcome` JSON, route response shapes).

| Slice | Content | Files touched | Equivalence pins | Risks |
|---|---|---|---|---|
| **S1 — Stage core (report index legs)** | New `documentPublish.ts` stage wrapping `indexCanonicalReport` + `indexCanonicalReportInAiSearch`; `fireFanoutIndexLegs` delegates | `src/services/documentPublish.ts` (new), `scheduledReports.ts`, `reportAiSearchIndex.ts` (thin) | fanout_outcome JSON identical across the matrix (fresh/dedupe × inline/WithR2 × flag on/off × bindings absent × excluded source); upload payloads identical | Fire-and-forget timing: stage must stay `void`-shaped at the seams or store latency changes |
| **S2 — R2 body leg** | Body put becomes the stage's pre-insert `r2-body` target; WithR2 consumes its outcome | `documentPublish.ts`, `scheduledReports.ts` | R2 bytes + `reports/<id>.json` key identical; inline-fallback row shape + outcome identical; dedupe never rewrites | The #2347 atomic-or-honestly-failed contract — a put that succeeds while the insert fails strands an object (today's behaviour too; pin it, don't "fix" it silently) |
| **S3 — Corpus onto the stage** | Upload route + corpus backfill call the stage (`kind:"corpus"`); hook becomes the stage's corpus adapter | `documentPublish.ts`, `corpusAiSearchIndex.ts`, `routes/knowledgeCorpus.ts` | items upload payload identical (`deriveCorpusIndexText` output unchanged); upload response `indexing.state` mapping identical; sync result shape identical | Flag semantics: `not-configured` must survive the move exactly (state vocabulary is rendered by the Corpus tab) |
| **S4 — Unbundle the corpus sync** | Report-backfill leg leaves `runCorpusSync` + the route's injection; reports backfill lives on its own route (exists, §1.3e) and, if it needs a schedule, its own tick rider **with** outcome recording | `corpusSync.ts`, `routes/knowledgeCorpus.ts`, `queue.ts`, `CorpusTab.tsx` | Marker semantics preserved (completed = integrity executed); sync response shape change is **breaking** for the tab — tab updated in the same slice; integrity results identical | Behaviour change disguised as refactor: the weekly Vectorize sweep of reports disappears from the corpus cadence — must be an explicit, disclosed decision with its own home, not a side effect |
| **S5 — Registration + surfacing** | §4.3: `ScheduledJobId` + dispatch path + tick wrap + in-route outcome recording; run-detail record per §4.3 decision; Corpus tab loads the latest persisted run on mount and follows it | `scheduledJobOutcomes.ts`, `queue.ts`, `routes/knowledgeCorpus.ts` (+ `scheduledJobOutcome.ts` pattern), `CorpusTab.tsx`, jobsApi/ledger only if §4.3(i) is chosen | outcome-row payload shape pinned; streak counting unaffected for the existing three jobs; tab renders the persisted record identically to today's in-state result | Extending a closed vocabulary touches the #2037 alerting thresholds; per-item detail must not leak into the codes-only outcome payload |

### Overlaps to sequence

- **#3525 manifest slice** — edits `docs/knowledge-corpus-seed-manifest.json`. That file is imported by `routes/knowledgeCorpus.ts:80` and consumed by `corpusSync.ts` / `corpusAiSearchIndex.ts`, but #3527's slices edit the **TypeScript**, not the JSON — file-disjoint. Safe in either order; S3/S4 must not re-derive manifest handling while the manifest's entries change underneath (the neutral order-types replacement changes one entry's sha256/key — the sync/backfill code is entry-agnostic, verified: candidates are built from manifest fields at `corpusAiSearchIndex.ts:271-280`). **CorpusTab.tsx is shared surface**: #3525's client-copy slice may touch it; S4/S5 also touch it — sequence those merges, don't parallel them.
- **#3342 (REST migration)** — its surface is the **search** side of `src/agents/aiSearchPaths.ts` (`runAiSearchPaths`, REST path at `:466`), `src/services/aiSearch.ts` (`AiSearchInstanceService`), `src/agents/mas.ts` `searchKnowledge` (`:38-66`, `searchRaw` leg), `src/agents/routes/searchHub.ts`, `src/mcps/openaimp/commands.ts:367`, and the `AI_SEARCH_ENDPOINT` var (declared in `wrangler.jsonc`, read at `aiSearch.ts:224,261-268`, `aiSearchPaths.ts:466`). #3527's stage depends on the **upload** side of the same file (`runAiSearchIndexUpload`, `aiSearchPaths.ts:696`, flags at `:579-613`). Same file, disjoint regions — but a merge collision is likely if both are in flight; sequence #3342 and #3527-S1/S3 so only one edits `aiSearchPaths.ts` at a time. #3527 never touches `AI_SEARCH_ENDPOINT` (uploads are namespace-only already).

---

## Appendix — key evidence index

- Store seams + fanout: `src/services/scheduledReports.ts:327-368, 741, 892, 957-979, 1318-1321`; outcome type `:215-225`, recorder `:276-298`.
- Vectorize leg: `src/services/reportSemanticIndex.ts:56-86, 141, 210, 267`.
- AI Search report leg: `src/services/reportAiSearchIndex.ts:92-157`; executor `src/agents/aiSearchPaths.ts:579-613, 696-746`.
- Artifact blobs: `src/services/reportBlobStore.ts:74-94, 107`; discovery `src/services/discoveryReportPublish.ts:36, 121`.
- Corpus: `src/services/knowledgeCorpus.ts:133-196, 263`; hook `src/services/corpusAiSearchIndex.ts:124, 161, 261`; sync `src/services/corpusSync.ts:95, 157, 341, 397`; routes `src/agents/routes/knowledgeCorpus.ts:80, 298, 312, 345`; tick `src/server/routes/queue.ts:314-327`; crons `wrangler.jsonc:185-192`.
- Jobs: `src/services/scheduledTasks.ts:404`; `src/observability/scheduledJobOutcomes.ts:45, 93-104`; `src/data/jobRunRecordPorts.ts:30-42`; `src/services/jobRunRecords.ts:56`; `src/services/jobOutcomes.ts:1-76`; `src/data/asyncJobPorts.ts` (#2358); `src/agents/orchestrator/asyncJobs.ts:1037`; UI `src/client/JobsPanel.tsx`, `src/client/ScheduleRunLedgerPanel.tsx`.
