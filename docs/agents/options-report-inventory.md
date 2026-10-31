# Options screening reports: inventory, failure diagnosis, and the report-scope program

**Status:** v1, 2026-10-31. Branch `fix/2577-options-report-scope`.
**Scope:** every options screening report surface in this repository — how many exist, how
they reach the user, why the recent runs produced short or failed reports, and what this
branch changes so a report's coverage is configuration, not code.

**Evidence base:** `origin/main` at `0e368866`; code paths cited by file and line at that
commit. Production run records are not readable from this workstation — §3 therefore names
each failure class with the exact code path that raises it and the run-record field that
distinguishes it, instead of asserting which one fired.

---

## 1. How many options screening reports exist

Six **report types** carry options content. They are produced by five generator
implementations in three formats, so the stored surface is **18 artifact kinds**
(6 types × PDF/XLSX/CSV).

| # | Report type | Generator(s) | Formats | Key family | Served by |
|---|---|---|---|---|---|
| 1 | Options **contract screen** (screened contracts, Greeks, filters) | `src/trading/optionsReportPdf.ts` (`generateOptionsPdf`), `optionsReportXlsx.ts` (`generateOptionsXlsx`), `screenerReportCsv.ts` (`generateOptionsCsv`) | PDF, XLSX, CSV | `options:pdf:` / `options:xlsx:` / `options:csv:` | `/api/options/report.{pdf,xlsx,csv}` |
| 2 | Options **opportunity scan** (fit matrix + ranked trades) | same three generators; the scan result is adapted by `adaptOpportunityScanToOptionScreenResult` and the matrix sections by `optionsReportMatrix.ts` | PDF, XLSX, CSV | same family | `/api/options/report.*` |
| 3 | **Strategy screen** (`strategies`, `best-trade`, `compare`, `llm_ideas`, `llm_evaluate`) | `src/trading/strategyReport.ts` | PDF, XLSX, CSV | `options:{pdf,xlsx,csv}:strategy:<id>` | `/api/options/report.*` (links from `strategyReportArtifactLinks`) |
| 4 | **Strategy discovery** | `discoveryReportPdf.ts`, `discoveryReportXlsx.ts`, `discoveryReportCsv.ts` | PDF, XLSX, CSV | discovery family | `/api/options/discovery/report.{pdf,xlsx,csv}` |
| 5 | **Options research run** | `researchReportPdf.ts`, `researchReportXlsx.ts`, `researchReportCsv.ts` | PDF, XLSX, CSV | `research:pdf:` | `/api/research/report.pdf` (+ XLSX/CSV seams) |
| 6 | **Goal screen** (its options leg) | `src/services/goalScreenReports.ts` — a self-contained renderer that bypasses the unified pipeline | PDF, XLSX, CSV | `goal_screen:{pdf,xlsx,csv}:<id>` | `/api/screening/goal-screen/report.{pdf,xlsx,csv}` |

Two further surfaces carry options results but are **not** stored artifacts: the Copilot
structured options card (`src/client/chat/OptionsStrategyCard.tsx`) and the client-side run
export bundle (`src/client/runExport.ts`, JSON/CSV/ZIP). Treating them as reports is how a
"missing report" investigation goes wrong — they are views over the same run data.

### 1.1 Channels

Seven delivery paths exist, and each formats its own message:

| Channel | Mechanism | Where |
|---|---|---|
| UI download | `reportUrl` / `xlsxUrl` / `csvUrl` in the run response | `src/agents/routes/etradeOptionsScreen.ts`, `etradeOptions.ts` |
| Docs & Reports | canonical `mas_reports` row + `/reports` browse + semantic search | `src/services/scheduledReports.ts`, `reportSemanticIndex.ts` |
| Slack | file upload (PDF plus any `delivery.files`) and Block Kit message | `src/services/screenerSlackDelivery.ts` |
| Email | attachment through `cfpaySendEmailWithAttachments` | `src/services/screenerFollowupDelivery.ts` |
| Webhook | outbound payload with artifact links | `src/services/tradingWebhooks.ts` |
| MCP / A2A | structured response + A2A file delivery | `src/agents/optionsRpc.ts` bindings, `screenerA2aDispatch.ts` |
| Chat / Copilot | structured options card | `src/client/chat/OptionsStrategyCard.tsx` |

The consolidation problem in one line: **6 report types × 3 formats × 7 channels = up to 126
format/channel combinations, but only 5 generators and 7 hand-written channel formatters.**
The combinatorics are why the same run looks different in Slack, in email, and on the Docs
page.

---

## 2. The failures: why a "full report" was not produced

Each class below is a code path that ends a run (or truncates a report) without asking the
operator. The distinguishing fields are named so a run record answers "which one was it".

### F1 — The options auth guard fails the run before any scan (most common)

Options runs have **no fallback**: the stock path degrades to Yahoo, the options path blocks
hard with `AUTH_003` (`scheduledTasks.ts`, guard block; `etradeAuthPreflight.ts`). A dead or
expired E*TRADE token therefore produces a failed options run — not a partial report. One
alert per episode, further runs quiet (`options.scheduled_analysis_blocked_quiet` audit).
*Confirm:* audit event `etrade.auth_blocked` / `options.scheduled_analysis_blocked_quiet`,
error code `AUTH_003`.

### F2 — Assembly refuses to publish when nothing was evaluable

The sharded chain's assemble stage throws when every per-symbol feed shard failed, and again
when `coverage.evaluated === 0` (`shardExecutors.ts:409`, `:416`). No artifact is written —
by design ("no partial report" for an empty result), but the report is simply absent.
*Confirm:* the assemble job's error text names the first symbol and its reason, or the top
skip reason.

### F3 — The subrequest budget caps how many symbols one invocation can cover

Measured cost is ~12 chain fetches per symbol against a 35-subrequest budget
(`DEFAULT_SUBREQUEST_BUDGET`), so `floor(35/12) = 2` symbols fit one invocation
(`scheduledTasks.ts:2103`). Scheduled runs above two symbols auto-shard; a symbol with an
unusually wide expiry window can still overrun its own shard and be skipped. This is the
documented "exactly 3 of 100" symptom class (#1785).
*Confirm:* `coverage.truncated`, `partial.topSkipReason`, per-symbol `skipped[]` reasons.

### F4 — The PDF leg is fatal to the whole generate stage

`generatePdf` throws when the pipeline reports `pdfStatus !== "generated"`
(`shardExecutors.ts:460`). The pipeline's own contract is per-format and non-fatal (#1278),
and the strategy path honors it (`strategyReport.ts` records a failed leg and keeps the
others). The sharded options path does not: one fragile renderer takes down a run whose
XLSX and CSV were generated successfully.
*Confirm:* generate-stage failure with `REPORT_001`/`REPORT_002` on the pdf shard while the
xlsx/csv shards completed.

### F5 — The monolithic path treats "nothing evaluated" as failure

`evaluatedCount === 0` throws in the monolithic branch (`scheduledTasks.ts`, coverage check
after `execute`). Same policy as F2, different code site — and the same blind spot: an empty
result and a broken provider look alike unless the skip reason is read.

### F6 — Report scope drifted between the sharded and monolithic paths (fixed here)

Before this branch the sharded per-symbol executor **hardcoded** `maxPlannedLoss: 1000`,
`minRewardRisk: 1.5` and **dropped** `minDte`/`maxDte` entirely
(`shardExecutors.ts:354-356`). A schedule that declared a different risk gate or expiry band
silently got different candidates depending on whether the run sharded (symbol count > 2) or
ran monolithically. Two runs of the same schedule could therefore disagree, and only one of
them was the one the operator configured.
*This branch forwards the band and the gates; the values now come from the report scope.*

### F7 — Long-horizon strategies can never be evaluated at the default band

The fetch band is thesis-gated (`etapiConfig.ts`, `dteWindows`: 14–60 DTE), while the
catalog's largest horizon is 550 DTE (LEAPS: `minDte 365`, `searchMaxDte 550`). Any strategy
whose required expiry was not fetched is reported "not evaluated" — correctly, but the
default run can never cover calendars, diagonals or LEAPS. Widening is a subrequest budget
decision, not a bug; §4 makes it an explicit preset (`all-chains`) instead of a hidden
limitation.

### F8 — The options PDF truncates every line at 120 characters

`optionsReportPdf.ts` `text()` renders `str.slice(0, 120)` with no wrapping. Legs and
rationales longer than 120 characters are silently cut. A report can be "complete" in row
count and still be unreadable — the failure the owner reported as "not a full report".

---

## 3. "Only 3 strategies were evaluated" — three distinct causes

`evaluateAllStrategies` sounds like it means "evaluate all 74". It does not. Reading the
engine explains the observation exactly:

1. **The wanted set is a filter, and it is the one that was small.**
   `strategyEngine.ts:986-987`:
   ```ts
   const wanted = new Set(registry.resolveMany(request.allowedStrategies).ids);
   const selectedDefs = registry.list().filter((def) =>
     wanted.has(def.id) && (request.evaluateAllStrategies === true || def.theses.includes(request.thesis)));
   ```
   `evaluateAllStrategies` only lifts the **thesis** clause. A schedule whose
   `allowedStrategies` carries three ids evaluates exactly those three, no matter what the
   flag says. The schedule form is a free-text comma-separated field
   (`DiscoveryFormSections.tsx:233`), so a leftover `long_call, put_credit_spread, iron_condor`
   from an earlier experiment is enough to produce a three-strategy report forever.

2. **"Evaluated" in the report means "built a candidate".**
   `buildMatrixCells` creates one cell per strategy type **that produced candidates**
   (`opportunityScanner.ts:938`, populated at `:1216`), and `buildStrategyCoverage` counts
   the matrix's cell types as the evaluated set (`optionsReportMatrix.ts`). A strategy that
   was judged on a thin chain and built nothing is listed under "not evaluated: built no
   candidate". So a report saying "3 strategies evaluated" can mean 74 were judged and 3
   yielded candidates — a labelling defect, not a scope defect.

3. **The ranked list is truncated before it reaches the report.**
   `recommendationKernel.ts:1324` slices `rankedAll` to `candidateLimit`, and
   `strategyReport.ts` renders only `ranked` ∪ `bestTrade`. A small `candidateLimit` (the NLQ
   default is 10; the panel sends a user-typed number) produces a short report even when the
   engine judged everything.

**How to tell them apart from a run record:** `requestSnapshot.template.allowedStrategies`
(cause 1), `evaluations[].status` per strategy (cause 2), and `candidateLimit` plus the
report's row count (cause 3). This branch puts the answer on the document itself.

---

## 4. What this branch changes

### 4.1 The scope is data

`config/options-reports.json` declares every axis:

| Axis | Keys | Values |
|---|---|---|
| Theses | `theses` | `bullish`, `bearish`, `range_bound`, `large_move` |
| Strategies | `strategies` | `"all"` (74 registry entries) or a list of ids/aliases |
| Chains | `chains.symbols`, `chains.universe`, `chains.maxSymbols`, `chains.dte` | `dte: null` keeps the engine's thesis band |
| Gates | `gates.maxPlannedLoss`, `gates.minRewardRisk`, `gates.eventPolicy` | 1000 / 1.5 / warn by default |
| Formats | `formats` | `pdf`, `xlsx`, `csv` |
| Channels | `channels` | `ui`, `slack`, `email`, `webhook`, `mcp`, `a2a` |
| Content | `content.*` | coverage sections, candidate limit, row caps, PDF truncation |

Presets: `full` (every thesis, every strategy, every format — the owner's ask), `thesis`
(the historical single-thesis default), `quick` (three strategies, PDF only), `all-chains`
(every expiry the catalog needs; costs one extra chain fetch per expiry per symbol).

Precedence: **request > `OPTIONS_REPORT_CONFIG` / `OPTIONS_REPORT_PRESET` > preset > built-in**.
A bad value never fails a run: unknown strategy ids, out-of-vocabulary theses/formats/channels
and malformed env JSON are dropped with a structured warning, and the resolver reports what it
ignored.

### 4.2 The resolver

`src/trading/optionsReportScope.ts` — pure, no I/O, injectable registry:

- `resolveOptionsReportScope(input, registry?, config?)` → the resolved scope, warnings, and
  provenance (`request` / `env` / `builtin`).
- `thesisRunPlan(scope)` → one execution per thesis (the multi-thesis fan-out contract).
- `horizonLimited` → the strategies the configured band cannot reach, **named before the run
  starts** instead of discovered in an empty report.
- `describeReportScope(scope)` → one ASCII line for audit rows, report headers and run records.

### 4.3 The report states its own coverage

`strategyReport.ts` now derives a `StrategyReportCoverage` for every strategy report:

- PDF: a `Scope:` line, `Coverage: n of m wanted strategies reported`, and up to 12 named
  not-reported strategies with the reason (skipped by the engine, not thesis-aligned,
  horizon-limited, evaluated-but-unranked, or never evaluated).
- XLSX: a `Coverage` sheet (one row per wanted strategy, `reported: yes/no`, reason) and a
  `Coverage Summary` sheet.
- CSV: unchanged — its column contract is pinned by tests.

### 4.4 Wiring

- `scheduledTasks.ts` resolves the scope once per run from the schedule plus env, passes the
  wanted set and gates into both the sharded chain and the monolithic scan, and stamps
  `describeReportScope()` into `options.sharded_chain_submitted`.
- `shardExecutors.ts` forwards `minDte`/`maxDte`/`maxPlannedLoss`/`minRewardRisk` into every
  per-symbol shard (F6).
- `types.ts` carries those fields on the chain's options block.

---

## 5. What is still open (consolidation program)

The inventory's 126 combinations are not reduced by this branch; the scope makes them
addressable. Sequenced next, each independently shippable:

| Phase | Work | Why it matters |
|---|---|---|
| P2 | Multi-thesis fan-out: execute `thesisRunPlan(scope)` per symbol and merge into one report with a per-thesis section | "All theses" currently names all four in the scope but executes the first; the report says so, which is honest but not the ask |
| P3 | Make the PDF leg non-fatal in the shard generate stage (per-format failure contract, #1278 parity) | F4: one renderer currently takes down a run whose XLSX/CSV succeeded |
| P4 | One options section model behind the three PDF renderers (`optionsReportPdf`, `strategyReport`, `discoveryReportPdf`), with the old exports kept as deprecated wrappers | Removes the 120-char truncation (F8) and the duplicated print machinery without deleting public functions (§22) |
| P5 | Route discovery and goal-screen artifacts through `unifiedReportPipeline` | R-2 in the duplicates scan: a fourth self-contained renderer is the reason goal reports behave differently |
| P6 | Channel matrix from `scope.channels` — one formatter, per-channel adapters | 7 hand-written channel formatters for the same run |
| P7 | Rename the coverage vocabulary: "evaluated" = engine judged; "reported" = reached the page | Cause 2 of the three-strategy confusion |

Non-goals, stated so they are not re-litigated: no deletions (the policy gate forbids them —
consolidation is deprecate-in-place with a named successor), and no change to the thesis's role
in scoring — the thesis orients ranking, it does not decide inclusion in a report scope.
