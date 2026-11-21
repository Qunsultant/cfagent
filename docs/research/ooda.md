# OODA research job — stage, surface and configuration survey

**Status:** survey, 2026-11-21. **Parent:** Qunsultant/cfagent#5973. **Product code changed:** none.
**Scope:** the seven questions on #5973 (per-stage run/status/results, enabled surfaces, `JobPipelineWorkflow` coverage, per-stage mode from the definition page, universes, brokers × modes, externalisation), the run-ledger and one-schedule deliverables, the current state of the two named pages, and the optimisation/consolidation list.

Line numbers are deliberately omitted from this page: each finding names the file and the symbol to grep, which survives refactors. The live issue bodies carry the line-level citations for the commit they were filed against.

---

## 1. Verdict

- One stage **can** be run and its **status** read today (API + UX). Its **result** cannot be read on any surface.
- Of the seven surfaces, **none** is complete: UX and API run/control; MCP runs a stub; Chat has no entry point; Copilot's door is dead code; Webhooks are absent; the schedule is a tick rider.
- **100% of the OODA analysis work runs outside `JobPipelineWorkflow`**, in one synchronous step.
- Per-stage execution mode **cannot** be chosen from the definition page; the only lever is a deployment env var.
- **8 of 22+** universe identities work; an unsupported one produces a published, empty-looking run instead of a refusal.
- **4** brokers are registered; `public` has no paper mode; any mode string is accepted and an unknown one silently reads paper.
- **14** settings are properly externalised; **30** hardcodings remain, **10** of which are strategy rules (12 values) that change investment decisions.
- The run ledger has **no stage rows and no duration**, and `research` is classified **Other**.
- There are **seven** representations of "when OODA runs"; one is user-editable and inert, two disagree.

---

## 2. Method and limits

**Sources.** Source reads on `main` at the commit this page was authored against; GitHub API reads for issues and sub-issue links; two HTTP reads of the two URLs. Nothing was executed against a running deployment; no test was run.

**Evidence tiers.** *Verified* — read from the named symbol or a live API read; every finding here is this tier unless marked. *Inferred* — follows from verified code but not executed; marked where used. *Not obtainable* — the rendered DOM of an authenticated page, which needs an authenticated browser session. §3 is therefore a reading of the render path, not a screenshot.

**Not changed.** No product code, schema, configuration or deployment. This page is the survey record; the work is filed as the sub-issues in §14.

---

## 3. The two pages

### 3.1 What an unauthenticated fetch returns

- https://agent.openaimp.com/?tab=options-screener&view=ooda
- https://agent.openaimp.com/?tab=workflow-catalog&view=define

Both return **HTTP 200 and byte-identical marketing landing content** — "Self-Driving Alpha. Deterministic Risk Gates.", the NAV/drawdown/Sharpe block, a sample strategy table, broker logos, the platform comparison. No OODA content, no workflow catalogue, no definition form, no redirect to sign-in, no view-specific `<title>` or meta description.

The app is a client-rendered SPA behind auth; the Worker serves the static shell for every path. A shared or bookmarked deep link lands a signed-out visitor on the sales page with no signal that the requested view exists. **Recorded, not filed:** it is a shell/routing concern outside OODA's scope and applies to every tab/view; it should be fixed once at the shell (auth-aware redirect, per-view metadata), not per page.

### 3.2 `?tab=options-screener&view=ooda` — what the page surfaces

Render path: `Chat.tsx` (`view=ooda` branch) → `OodaResearchPage.tsx` (shell) → `ResearchRunsPanel.tsx` (body).

| Region | What it shows | Source |
|---|---|---|
| KPI ribbon | `Engine Job = research:<runId>` / `J-stack durable`; `Guard Window = 21:00–21:30 UTC` / `Weekdays`; `Pipeline = 6 stages` / `feed → evaluate`; `Environment = activeEnv` | Three of the four values are **client literals** in `OodaResearchPage.tsx`; only `activeEnv` is real |
| Action row | `Run research now`, `Refresh`, **free-text** `Broker / venue`, **free-text** `Mode (paper / live)`, `Edit filters`, `Evaluate this run (§9)`, `Ask about results` | `ResearchRunsPanel.tsx` |
| Stage control | Six rows (`feed → enrich → analyze → generate → deliver → evaluate`), each with a status badge and status-gated buttons | Statuses from `GET /api/research/runs/:runId/stages`; actions post the per-stage route; the status→action table is a **client literal** |
| Filters & thresholds | The full `ResearchConfig` editor, 23 fields (market cap, price, universe, maxIdeas, freshness, spread, volume, OI, DTE, ownership, PMCC, email, **scheduleCron**, pricing, OODA budget, rules version) | `researchConfig.ts` schema |
| Latest report + history | Latest report and a list of past runs | `GET /api/research/latest`, `/history` |

**Not surfaced:** any per-stage **result** (no artifact, descriptor, output preview or link — the stage read returns status/timestamps/duration only); any per-stage **execution mode**; any indication that **four of the six stages execute nothing**; the stages of a **past** run (history and stages are read from two different sources).

### 3.3 `?tab=workflow-catalog&view=define` — what the page surfaces

Render path: `WorkflowCatalogPage.tsx` → `WorkflowDefinitionFlow.tsx`; specs from `GET /api/job-definitions` ← `jobDefinitionCatalog.ts` (`JOB_DEFINITION_SPECS`).

| Region | What it shows | Meaning for OODA |
|---|---|---|
| Spec list | `research` (`shortId: "oodares"`, "Nightly OODA research") among the specs | OODA is selectable |
| Per-stage editor | Execution mode (4 axes), cadence (cron or interval), parameters, timeout, maxParallel, retry bucket, checkpoint interval; POST assembles `stageModes` / `stageProcessing` | Rendered for `spec.stages` only |
| OODA's stage list | **One row**, labelled `research` | The spec nests all six stages as `children` of a single `kind: "research"` stage; children are not rendered |
| Parameters | No `universe`, `brokerId`, `mode`, `stageModes` parameters exist for `research` | Nothing OODA-specific can be collected |
| Schedule | `schedule: { enabled: false }` | A real generic scheduling mechanism that OODA does not use |
| Page copy | "its runs land in Workflow Runs with per-stage status and times" | True for stages the engine runs; for OODA, six rows of which four did nothing |

The definition page is a working per-stage configurator that **cannot see OODA's six stages**; OODA's one row configures a wrapper that executes nothing.

---

## 4. Running one stage and reading its status and result

| Capability | Status | Evidence |
|---|---|---|
| Per-stage trigger (API) | **Implemented** | `POST /research/runs/:runId/stages/:stageId` with `{op}` — `screenerResearch.ts`; ops `status\|run\|rerun\|stop\|resume\|cancel` (`ResearchStageOp` in `researchScreenEngine.ts`) |
| Per-stage trigger (UX) | **Implemented** | `ResearchRunsPanel.tsx` per-row buttons |
| Per-stage status (API) | **Implemented** | `GET /research/runs/:runId/stages` → `readResearchStages` |
| Per-stage status (UX) | **Implemented** | Badge + status-gated actions |
| Per-stage **results** | **NOT IMPLEMENTED** | `ResearchStageRow` carries `stageId, status, startedAt, endedAt, durationMs` only; `JobStageView.units` has no output; steps emit a `descriptor` (`researchPipelineJobs.ts`) that no read path returns |
| Per-stage run performs real work | **Only `analyze` and `evaluate`** | The other four step bodies return `{status: "completed"}` — `registerResearchSteps` |

```http
POST /api/research/runs/{runId}/stages/{stageId}
Content-Type: application/json

{ "op": "run" }          # rerun | stop | resume | cancel | status

GET /api/research/runs/{runId}/stages
```

- **UX:** `?tab=options-screener&view=ooda` → *Stage control* → per-row buttons.
- **MCP:** `run_research_job` with `{runId, stageId, op}`. In production `run`/`rerun`/`resume` **fail closed** because the command calls the stage control without `researchDeps`; `status` works.
- **Chat / Copilot / Webhook:** no working per-stage entry (§5).

The engine computes `durationMs` and each step returns a descriptor, but neither is written to a row a route can read back per stage. The stage read projects live engine state; the history list projects report summaries — two sources for one run, so a past run's stages are unreachable once its checkpoint is replaced.

---

## 5. Surface matrix

Legend: **✓** works · **◐** present but hollow · **✗** absent.

| Surface | Whole run | Per-stage trigger | Per-stage status | Per-stage results | Config (broker/mode/universe/stage modes) |
|---|---|---|---|---|---|
| **UX** (OODA page) | ✓ `Run research now` | ✓ | ✓ | ✗ | ◐ free-text broker/mode, filters only; no stage modes; guard-window copy hardcoded |
| **Chat** | ✗ no OODA entry in the chat job catalogue; only `Ask about results` (a read prompt) | ✗ | ✗ | ✗ | ✗ |
| **Copilot** (mesh door) | ✗ **dead code** — `meshResearchDoor` imported only by tests; the deterministic `execute` returns a literal | ✗ | ✗ | ✗ | ✗ |
| **API** | ✓ `POST /research/run`, `/research/scheduled-tick` | ✓ | ✓ | ✗ | ◐ `brokerId`/`mode` accepted, **unvalidated**; no stage modes |
| **MCP** | ◐ `run_research_job` returns `{dispatched: true, …}` from a stub execute | ◐ status only in production | ✓ | ✗ | ✗ |
| **Webhooks** | ✗ ingress accepts only `followup.report\|deliver\|notify` | ✗ | ✗ | ✗ | ✗ |
| **Scheduled** | ◐ tick rider POSTs the run every 30 min | ✗ | ✗ | ✗ | ✗ platform default only |

**Two hollow cells.** MCP: the audit trail shows a dispatched research job while nothing quoted anything. Copilot: three exported door functions with **no production import**, and the deterministic path injects a hollow `execute`. Both are the defect class #5287 closed at the default-deps layer; the caller-supplied stubs were outside its fence.

---

## 6. How much still has to use `JobPipelineWorkflow`

**All of it: 6 of 6 conceptual stages, 100% of the analysis work.**

```
POST /research/run                       screenerResearch.ts
 └─ dispatchResearchEngineRun            researchScreenEngine.ts
     ├─ buildResearchJobDefinition(...)  researchPipelineJobs.ts
     ├─ new JobPipelineControl({invocation: "sync"})
     └─ control.runJob(engineJobId)
         ├─ feed    → research.feed    → {status:"completed"}
         ├─ enrich  → research.enrich  → {status:"completed"}
         ├─ analyze → analyze.ooda     → runOodaAnalysis → runResearchAndPublish
         │                               → runResearchPipeline   ← ALL SIX STAGES RUN HERE
         ├─ generate→ research.generate→ {status:"completed"}
         ├─ deliver → research.deliver → {status:"completed"}
         └─ evaluate→ evaluate.apply   → runEvaluateStage
```

`runResearchPipeline` loads config, resolves the regime, fetches the universe, screens candidates, fetches chains per symbol, builds structures, prices, gates, ranks, and returns a report with an in-memory `stageTrace`. It is not resumable, not checkpointed, not sharded, and not durable across a restart. `JobPipelineWorkflow` exists and the pipeline plane can start it (`startPipelineJobWorkflow`), but nothing in production dispatches to it (#4171).

**What that costs each stage's execution mode.** The mode is merged onto every child and validated (#5916), but it only governs how the engine handles that node's **units**:

| Stage | Can the mode change anything? | Why |
|---|---|---|
| `feed`, `enrich`, `generate`, `deliver` | **No** | The body is a stub — nothing to pace, shard or stream |
| `evaluate` | **Partial** | Real step, one unit: `shape: sharded` and `pacing: online` are unexercised |
| `analyze` | **Partial** | Real work inside one step: `concurrency` and `shape` cannot apply; the parallelism that exists is `ResearchConfig.maxParallelCandidates`, a different control |

No OODA stage can be independently made sharded, streamed or async by mode alone.

---

## 7. Choosing the execution mode per stage from the definition page

**You cannot.** Three independent blockers:

1. **The spec nests the six stages under one kind.** `JOB_DEFINITION_SPECS.research.stages` is a single element `{kind: "research", step: "noop", children: [six]}`, and the flow renders `spec.stages` — one row named `research`.
2. **The binder validates stage keys against the top level only.** `bindStageOverrides` builds its map from `spec.stages`; for `research` that is one key, so a POST with `stageModes: {analyze: …}` is refused by name: *"Job definition \"research\" has no stage \"analyze\""*.
3. **The builder reads modes from the environment, not the definition.** `buildResearchJobDefinition` takes `stageModes` from its argument, and its only production caller supplies `resolveResearchStageModes(env)` — the `RESEARCH_STAGE_MODES` JSON env var. The generic define route never reaches that function.

The only lever today is a deployment env edit:

```
RESEARCH_STAGE_MODES='{"analyze":{"pacing":"online"},"deliver":{"delivery":"sync"}}'
```

No UX reads or writes it; it cannot be per-tenant or per-run; a bad value throws at boot, not in a form; and its effect is capped by §6.

---

## 8. Universes

| Registry | Members | Used by OODA? |
|---|---|---|
| `UniverseId` (screener selector) | **8** ids — market-cap slices, keyword filters, and `ALL` (enumerated in `universes.ts`) | **Yes** |
| `IndexId` + `SectorId` (stored lists) | **22** ids — stored index memberships and 11 GICS sector lists (`indexMembership.ts`; refresh `indexListJob.ts`) | No |

`resolveUniverse` switches on the id with **no default branch**, so an unknown id returns `undefined`; the research caller calls `.map` on it → `TypeError` → caught one level up and converted into a **published report** reading *"Universe retrieval failed; no candidates evaluated."* with `universeSize: 0`. The config validator only checks the string is non-empty.

| Requested | Selectable | What happens |
|---|---|---|
| The default and the six other resolved ids | ✓ | Work (market-cap slice / keyword filter) |
| `ALL` | ✓ but hollow | Returns `[]` — "sharded by the caller, never resolved directly"; the research path does not shard it |
| The 14 stored-list ids the selector does not expose (mid-cap, total-market, 11 sector lists), plus any typo/lowercase variant | ✗ | `undefined.map` → "Universe retrieval failed" → empty run |

Even the 8 that work resolve from the **market listings directory by market-cap rank**, not from the stored membership snapshots — a universe label in OODA is a market-cap slice, not the stored list of the same name. #3667 owns integrating the stored lists; the refusal honesty is #6032.

---

## 9. Brokers and modes

| Platform registration | `paperMode` | Mode map shape |
|---|---|---|
| A | true | paper → sandbox API, live → live OAuth |
| B | true | paper → paper API, live → live API |
| C | **false** | preview/read-only; placement refused at the seam |
| D | true | paper + live declared |

The named matrix, with the catalogue ids, is in #6036; the ids are deliberately not repeated here so this page stays platform-neutral (the census in `docs/operations/data/neutrality-census.md` requires it).

The honest matrix is **3 × {paper, live} + 1 × {live, read-only test}**. The research path never consults `paperMode`:
| Check | Present? | Consequence |
|---|---|---|
| Broker registered | ✓ throws by name | Good (`registry.ts`, fail-closed) |
| **Mode ∈ {paper, live}** | ✗ | `"Live"`, `"PROD"`, `"prod"`, `"live "` all take the **paper** branch (`researchProviders.ts` compares to the exact literal `"live"`) while the requested string is what gets recorded |
| **Broker × mode compatible** | ✗ | `public` + `paper` accepted |
| Validated at API edge | ✗ | `screenerResearch.ts` trims and forwards |
| Validated at UX edge | ✗ | free-text input |
| Default when unset | literal `"paper"` | The provider invents a default instead of resolving the tenant binding |

---

## 10. Externalisation inventory

| Class | Count | Examples / disposition |
|---|---|---|
| Properly externalised (env or stored config, validated) | **14** | `RESEARCH_OODA_BUDGET_MS` (90s), `RESEARCH_SCHEDULE_UTC_HOUR` (21), `RESEARCH_SCHEDULE_WINDOW_MINUTES` (30), `RESEARCH_MAX_PARALLEL` (4), `RESEARCH_RETRY_MAX_ATTEMPTS` (2), `RESEARCH_EVAL_LOOKBACK_HOURS` (24), `RESEARCH_STORAGE_MODE`, `RESEARCH_STAGE_MODES`, 23 stored filter/threshold fields, broker/data-provider platform defaults |
| Hardcodings on the OODA path | **30** | grouped below |

| Group | Count | Items | Disposition |
|---|---|---|---|
| Schedule declarations | 4 | fire-hour literal, dispatch-cron literal, dead `research.scheduleCron`, rider ceiling rationale comment | #6029, #6030 |
| Strategy rules | 10 (12 values) | PMCC long-leg DTE 180, target DTE window 30/45, vertical width 5%, PMCC moneyness 0.9, butterfly tolerance 2%, score weights 0.4/0.35/0.25 + non-live and event penalties, thesis ladder 0.4/0.55/0.6/+0.1, track-record thresholds 0.4/0.6, pre-screen multiplier ×3, breakeven tolerance 0.98/1.02 | #6037 |
| Provider resolution | 3 | default-mode literal, `=== "live"` test, report URL fallback | #6036 (first two); the URL fallback should read `APP_BASE_URL` |
| Client copy / state | 5 | guard-window copy, stage count, stage order, status→action table, `?? 6` fallback | #6029, #6034 |
| Spec / ledger structure | 6 | run-body broker/mode default, `step: "noop"` ×5, missing spec parameters, wrapper kind, ledger kind rule, ledger stage fields | #6027, #6028, #6031 |
| Correctly code-pinned | 2 | cadence sample set, retry bucket names | none — configuration primitives, not OODA settings |

**Highest-value UX-manageable set, in order:** (1) schedule hour and cadence, one declaration; (2) the six stage modes on the OODA settings page; (3) the 10 strategy rules as a versioned document; (4) stage/guard copy read from data; (5) the venue pair as a validated enum; (6) the universe as a validated set.

**Correctly code-pinned and should stay so:** `RESEARCH_AOP_RULES` (stored-data-only, owner-scoped, capped parallel, provenance) — policy, not preference.

---

## 11. Every stage in the run ledger, with duration

**Today: no stage has a ledger row, and no ledger row has a duration.**

`job_run_records` stores one row per **run** (`id, system, job_id, operation, started, finished, outcome, triggered_by, trigger_text, schedule_id, async_job_id, workflow_id, error_text, detail, descriptor, artifact_refs_json, broker_id, data_provider_id, mode, mode_source`). No `stage_id`, no `stage_status`, no `duration_ms`, no `result_ref`. `definition_version` exists on the domain type but not in the D1 table, which also lacks broker/mode provenance.

Per-stage timing **is** computed and then discarded: `JobStageView.durationMs` is returned to the OODA page by the live read only. A stage-event table exists — `job_stage_events(run_id, job_id, stage_id, unit_id, action, started_at, ended_at, …)` — written only by the pipeline plane; the research path never writes it.

`RUN_LEDGER_KIND_RULES` matches on operation namespace and **`research` matches none of them**, so OODA lands in the `other` bucket: filtering the runs view for OODA finds nothing.

Fields to add (specified in #6028): `stage_id`, `stage_status`, `stage_started_at`, `stage_ended_at`, `duration_ms`, `definition_version`, `stage_execution_mode`, `result_ref`, `unit_count`, `failed_unit_count`; plus the kind rule. #6034 is the read/UX half.

---

## 12. One schedule program

**Seven representations of "when OODA runs"; one is user-editable and does nothing; two disagree.**

| # | Path | Does it schedule? | Evidence |
|---|---|---|---|
| 1 | Tick rider POSTs `/research/scheduled-tick` every 30 min | **Yes — the only real trigger** | `tickRiders.ts` |
| 2 | Fire/no-fire guard, once per weekday at/after a hard literal `21` | Yes, decides per tick | `researchScheduleGuard.ts` |
| 3 | Guard window from `RESEARCH_SCHEDULE_UTC_HOUR` + window | Yes — a **second** hour declaration | `researchJobConfig.ts`; enforced `meshResearchDoor.ts` |
| 4 | Derived catalogue record `nightly-research` (`0 21 * * 1-5`, `source: "derived-record"`) | Display only — not stored, no alarm | `config/job-catalogue.json`; `unifiedScheduleManagement.ts` |
| 5 | Cron literal `NIGHTLY_RESEARCH_DISPATCH_CRON` | A **third** hour declaration | `researchScheduleGuard.ts` |
| 6 | Definition-spec `schedule.enabled: false` + per-stage cadence support | A real generic mechanism OODA does not use | `jobDefinitionCatalog.ts`; `runPipelineJobSchedule` |
| 7 | `research.scheduleCron` in the filter editor | **Dead** — nothing reads it | `researchConfig.ts` |

The disagreement: set `RESEARCH_SCHEDULE_UTC_HOUR=22` and the guard window moves to 22:00–22:30 while the tick still fires at 21:00; the deterministic door then refuses `outside_guard_window` and the route path keeps firing at 21:00. Two declarations of one fact, no cross-check.

**Target:** one stored schedule record created through the existing `POST /api/schedules` + `runPipelineJobSchedule` path, payload `{jobId: "research:<runId>", trigger: "scheduled"}`, one cadence declaration; the tick rider becomes one of N schedule firings; the guard's hour literal and `research.scheduleCron` both disappear; `nightly-research` becomes a real record, not a derived one.

---

## 13. Opportunities: optimisation, enhancement, consolidation, alignment

| # | Opportunity | Why it matters | Disposition |
|---|---|---|---|
| O1 | Four of six stages are no-ops reporting `completed` | Every status surface inherits the lie | #6027 |
| O2 | No stage rows, no duration, wrong ledger kind | Ledger cannot answer "which stage failed and how long" | #6028 |
| O3 | Seven schedule paths, one inert, two contradictory | One job, seven answers to "when" | #6029 |
| O4 | Fire hour declared twice | Config silently disables a path | #6030 |
| O5 | Definition page cannot address six OODA stages | Per-stage mode is env-only | #6031 |
| O6 | Universe: 8 of 22, `undefined.map`, `ALL` empty | Silent empty run instead of refusal | #6032 |
| O7 | Broker × mode unvalidated; unknown mode = paper | Provenance lie at the head of every run | #6036 |
| O8 | 10 strategy rules are inline literals | A report cannot be reproduced from its rules | #6037 |
| O9 | Per-stage result unreadable on every surface | "Run a stage and see its output" is impossible | #6034 |
| O10 | OODA runs sync in-request, not on the workflow | No durability, no step retry, no resume | #6035 |
| O11 | Three stage vocabularies (6 flat, 8 conceptual, 1 wrapper) | Every surface translates between them | folded into #6031/#6035 |
| O12 | `runResearchPipeline` is one ~400-line function | Cannot shard, resume, retry or observe at stage boundaries | folded into #6035 |
| O13 | History and stages read from two sources | A past run's stages are unreachable | folded into #6028/#6034 |
| O14 | Stage-control op vocabulary duplicated (server enum + client table) | Adding an op means editing two files | folded into #6034 |
| O15 | MCP dispatch and Copilot door are hollow; door is dead code | Two surfaces report success without work | #5976 (existing) |
| O16 | Webhook cannot trigger OODA | Inconsistent job management across entry points | #5977 (existing) |
| O17 | Evaluate does not close the loop into screener gates | The "A" in OODA never feeds back | #773 (existing) |

**Consolidation wins if the above lands:** one stage vocabulary (six ids, no wrapper), one stage read model (status + duration + result), one venue resolver, one rules document with a version, one schedule record, one ledger row per run with its stages, one client source for stage names/order/actions. That removes four duplicate declarations and two hollow surfaces without adding a subsystem.

---

## 14. Filed work — index and sequencing

| Issue | Title | Size | Priority | Depends on |
|---|---|---|---|---|
| #6027 | OODA feed, enrich, generate and deliver are no-op stages that report completed | Medium | High | — |
| #6028 | All OODA stages surfaced in the run ledger with duration | Large | High | — (before #6034) |
| #6029 | One schedule program for the OODA research job (seven paths today) | Large | High | #6030 |
| #6030 | The OODA scheduled run declares its fire hour twice and the two disagree | Small | High | — |
| #6031 | The definition page cannot address the six OODA stages, so per-stage mode is env-only | Medium | Medium-High | #6027 |
| #6032 | OODA universe selection refuses nothing: an unsupported universe publishes an empty run | Medium | High | #3667 for the full set |
| #6034 | A past OODA stage's result is unreadable: the stage read returns status and duration only | Medium | Medium-High | #6027, #6028 |
| #6035 | Run the six OODA stages on JobPipelineWorkflow so every stage's execution mode is real | Large | High | #6027; #4171 seam |
| #6036 | OODA accepts any broker and any mode string: an unknown mode reads paper and public × paper is accepted | Small | High | coordinate #5975 |
| #6037 | Externalize the OODA strategy constants into one persisted, versioned research rules document | Large | Medium | coordinate #5975 |

**Order (four waves):**

1. **Correctness, small:** #6030 → #6032 → #6036 → #6027.
2. **Truth contracts:** #6028 → #6034; #6031 alongside.
3. **Consolidation:** #6029 (after #6030), #6037.
4. **Durability:** #6035 (last; it depends on truthful stages and benefits from #6031/#6028).

**Open siblings already filed:** #5975 (UX/API config), #5976 (chat/MCP), #5977 (webhook).

**Linked, not re-filed:** #4766 (per-stage mode on the record), #5585 (descriptor on the run record), #3667 (index/sector universes), #4171 (workflow-residency activation), #5780 (Workflows programme), #3533 (epic: every job/stage in every mode), #4788 / #5852 (one run-record / one run-ledger store), #773 (close the loop).
