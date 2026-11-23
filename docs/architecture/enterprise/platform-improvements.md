# Platform improvements — prioritized survey (not one-off fixes)

**Checked:** Mon 2026-11-23. Every issue below was verified open by GitHub
read-back (search + `issue_read`) on that date unless noted. Scope: open
issues that improve, optimize, or enhance the platform structurally — one
change, many consumers — not single-symptom bug fixes.

**Headline corrections to the prior record:**
- The data-model set is **done, not open**: all 23 sub-issues of #5023
  (including HIGH #5037, payment-confirm) are CLOSED as completed
  2026-11-18, and #5023 itself is closed. #5037 landed via PR #5428
  with a §15. They are in the Excluded section, not the ranking.
- **#5837 and #4467 are done, not open**: #5837 closed completed
  2026-11-20 (the Cancel action was delivered on the same
  `controlJobStage` seam, not via PR #5840, which died empty);
  #4467 closed completed 2026-11-20 via PR #5902 (replay a past run).
- **#3696 and #3697 are closed** (UX harmonization S1/S2 completed
  2026-11-18). #3698 is still open.
- **#3214 is closed and CTO-owned** — excluded, not ours.

## Ranked table

Rank | Issue (parent) | Title | State (checked 2026-11-23) | Size / Priority | What it enables for the user
---|---|---|---|---|---
1 | #3661 (#2764) | MCP trade path has no HITL / proposal gate | open | — / High* | No trade executes without the user seeing and approving it first — the AAPL incident (a queued order narrated as placed, no bracket, no approval) cannot repeat.
2 | #5203 (#3519†) | Route Stock Copilot intents through the proposal queue | open | Medium / High | Every copilot trade waits as a reviewable proposal in the approvals queue before money moves, instead of executing the moment the critic accepts it.
3 | #3542 (#2764) | Delivery as a scheduled job | open | — | "Deliver this report via this channel to this recipient, now or on a schedule" works from chat — deliveries become real jobs with runs, last outcome, and history instead of a stage buried inside a screen run.
4 | #5263 (#4773) | UX control to change a family's default execution mode | open | — | Change how any workflow family runs (sequential/parallel, batch/flow, sync/async) from the UI, instead of needing an MCP-only command nobody can reach from a panel.
5 | #5257–#5262 (#4773) | Declare the remaining job definitions (options, strategy, goal, options-chain, feed; trading/payment/saga decision-first) | all open | — | Every family gets one declared home for its default mode, so the catalog Define view and the #5263 control can cover all families instead of just screener and research. (#5262 is decision-first.)
6 | #5200 (#5199) | Ranked stock setups (Top setups) — the stock-side pick | open | — | A ranked "best setups" view for stocks, like the options picker already has — the user sees the best trade first instead of the loop taking the first signal it finds.
7 | #5502 (#5056†) | Build the Self-RSI sandbox synthesis pipeline (§7) | open | Large / Low | New strategies get researched, synthesized, backtested, and offered as 1-click activation cards, with a human deciding — the copilot starts improving its own strategies instead of only running fixed ones.
8 | #3908 (#3907†) | Paid-job credit/refund path for reaped/failed x402 jobs | open | — | When a paid job fails or is reaped, the user gets their money back (or a credit) instead of paying for work that never ran — today no such mechanism exists at all.
9 | #5216 (#5199) | Per-family pipeline-job schedule tools (enrich / analyze / generate / deliver) | open | — | Read and change a pipeline job's schedule from chat or the UI, the way feed jobs already allow — no more schedules that can only be set at definition time and never changed.
10 | #5208 (#5199) | Proactive hedge check (schedule / on position open / MCP) | open | — | Hedge drafts appear proactively — when a position opens or on a daily check — instead of only when the user happens to open the portfolio panel.
11 | #5205 (#5199) | Surface rebalance proposals (route + panel) | open | — | Drift-rebalance proposals the system already computes become visible, with buy/sell/hold per symbol, so the user can act on a drifting portfolio instead of never seeing it.
12 | #5211 (#5199) | Production trigger for the golden-task eval harness | open | — | The evaluation loop finally gets real evidence: scheduled eval passes score the doors and record results, so proposals and RSI decisions are judged on measured performance.
13 | #5213 (#5056†) | Wire sandbox strategy synthesis into the self-RSI path + activation cards | open | — | The tested strategy-synthesis module gets called by the copilot loop and its results surface as activation cards. Overlaps #5502 (rank 7) — likely folds into it; do not build both separately.
14 | #5212 (#5058†) | Hand introspection proposals to the proposal pipeline | open | — | The copilot's own improvement proposals stop being prose nobody reads and start flowing into the pipeline that files and tracks them.
15 | #5202 (#5199) | LLM-vs-quant comparison track record across runs | open | — | A track record showing, across runs, whether the LLM, the quant, or the hybrid actually wins — so the user can trust (or stop trusting) each approach with evidence.
16 | #5207 (#5199) | Wire goal-scenario discovery triggers (portfolio / regime / events) | open | — | Goals get discovered from the live portfolio automatically — including the "hedge this unhedged delta" trigger — instead of the discovery code never running.
17 | #5204 (#5199) | List pending workflow-backed trade-approval waits | open | — | Approval waits started from chat become visible and actionable; today a started wait is invisible everywhere except the turn that started it.
18 | #5220 (#3122) | Schedule / goal approvals queue in the live approvals tab | open | — | Agent-requested schedules and goals wait in a queue the user can approve or reject from the UI — the human gate on agents scheduling work, finally surfaced.
19 | #5209 (#3695) | Generate the MCP explorer catalog from the live tool list | open | — | All 144 MCP tools become browsable and testable from the UI instead of 37 — the user (and admins) can find and try any tool instead of guessing names.
20 | #3676–#3679 (#3675) | Realtime RSI S1–S4: scoring loop, ticker, paper orders, portfolio | all open | — | A live loop that scores stocks every 30 minutes, shows a ranked ticker, and (paper-first, with a HITL gate) acts on the best — the realtime trading programme the user directed.
21 | #3213, #3217, #3219, #3220, #3201, #3202, #3205, #3206, #3207, #3223 (stage control) | Agentic stage control set: introspection, discrete stages, per-stage params, AOP config, execution-mode UX, queue concurrency | all open | — | Chat can inspect, run, and tune individual workflow stages with per-stage parameters, and stages get proper AOP instrumentation — the "run any stage" control the user asked for, finished end to end.
22 | #5264 (#5080) | Audit Vault vs canonical IAAA audit store — decision owed | open | — | Decides what the Audit Vault actually shows (canonical audit store, orchestrator events, or both) so the audit page never goes empty or misleading after the S5 consolidation.
23 | #3732 (#581) | Enable the specs/ research pipeline for Stock Copilot (FEAT-101–107 + isolation model) | open | — | The whole specified research pipeline — runs, candidate evaluation, decision gates, research cards, outcome evaluation — becomes runnable and visible through Stock Copilot instead of living in a separate system.
24 | #773 (#581) | OODA: feed evaluation outcomes into screener gates | open | — | Screener rankings learn from measured accuracy — poor strategies get down-weighted, good ones up-weighted, and the adjustment is visible in the report. Closes the OODA loop.
25 | #2863 (#2764) | Report replay from persisted data: same report from any given day | open | — | Any past day's report can be reproduced exactly from persisted data — no live re-fetch, no re-charge, with provenance to the original run.
26 | #5214 (#5199) | Select the dataset-backed options-chain source when fresh | open | — | Options chains answer from the persisted feed artifact when it is fresh, so screens stop paying for live broker fetches they already have on disk.
27 | #5215 (#5199) | Wire the per-tenant credential store into resolution + migrate | open | — | Broker credentials stop being shared env-global secrets and become per-tenant, with provenance — one tenant's keys can never leak into another's calls.
28 | #5206 (#5199) | First producer for composition repairs | open | — | Composition-repair options can finally appear in recommendation bundles — the policy exists and is tested, but nothing produces its inputs today.
29 | #5217 (#5199) | Daily QA sweep: implement the sweep or remove the goal | open | — | The daily QA sweep either really runs or stops pretending — today it records "success" every morning while executing nothing.
30 | #5218 (#4174) | Opportunity hunt: implement the hunt or remove the goal | open | — | The every-6-hours opportunity hunt either works and feeds discovery, or the goal goes away — today it fails every firing and stays due.
31 | #5219 (#1819) | Read surface for the resource comparison report | open | — | The daily resource comparison the system already writes becomes readable — the user can see what it found instead of only "comparison complete".
32 | #5221 (#5199) | List / inspect surface for synthesized goal chains | open | — | Synthesized goal chains (legs, firing state) become listable and inspectable instead of visible only as ledger rows.
33 | #2773 (#2764) | Pareto-frontier evaluation for stock screening | open | — | Screens show real multi-objective tradeoffs (no single-score ranker in disguise), so the user picks by tradeoff instead of by one hidden number.
34 | #3698 (#3695) | UX harmonization S3 — platforms.md conformance audit | open | — | Presets, left nav, and top nav get audited against the platform doc so the navigation the user sees stays honest and consistent.
35 | #3998 (#3695) | Enable the remaining GitHub templates & community capabilities | open | — | CONTRIBUTING, issue forms, discussion templates, and releases land — the repo accepts outside contributions cleanly instead of by ad-hoc issues.
36 | #2772 (#2764) | FINRA/SEC applicability assessment and NextGenTP legal platform | open | — | **BLOCKED, do not build:** needs a named human legal authority and qualified counsel review. Listed last for that reason.

\* Priority/size from the issue body template where read; "—" means not
stated in labels and the body was not read for this survey. † Parent is
CLOSED — the sub-issue is orphaned (its parent's work is done or the
parent closed); re-parenting or folding it into a live parent is part
of intake.

## Notes on the top 10

**1. #3661 — the gate.** The body quotes the code comment ("No HITL
gate exists on this path on either surface today") and the AAPL incident
of 2026-11-07, when a queued order was narrated as placed with no
bracket and no approval. The platform already has the proposal flow
(`previewOrder`, "HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION") —
this path bypasses it. Dependency: pairs with #5203 (rank 2), which is
the visible queue the gate would feed; #5203's parent #3519 is closed,
so intake should re-parent it (or fold it into #3661's delivery).

**2. #5203 — the queue (High priority, Medium size).** Same hazard,
surfacing angle: even a read-only pending-intent queue does not exist.
Acceptance criteria require no copilot intent to reach
`placeOrderRemote` without first existing as a proposal/draft row, and
pending copilot trades listable in the approvals queue. Unblocks the
user trusting the copilot loop at all.

**3. #3542 — delivery as a job.** Body verified on main 2026-11-06:
no `delivery` schedule kind exists; delivery only rides a screen run's
`deliver` stage. MCP doors take no caller-supplied webhookUrl (env
config only). Scope: delivery job kind, now + interval/cron/one-time/
delayed, reusing the one delivery bridge + `(runId, destination)`
suppression, status UX, Copilot run/report tools. Implementation not
authorized yet — filing only until now.

**4. #5263 — the UX control.** The mode is displayed but not changeable
through UX; `set_job_execution_mode` is MCP-only and no client code
calls it. Scope is small and precise: add the control reusing the
existing write path + display, pin that it writes exactly what the MCP
tool writes. **Blocker:** it edits a definition's default, so families
without a declared definition (rank 5) have nothing to edit.

**5. #5257–#5262 — the definitions.** Only the screener has a declared
definition (the research definition landed since, per the #4773 record).
Each issue is one family: options-screener (#5257, incl. comparison),
strategy (#5258), goal-screen (#5259, blocker #4290 now closed),
options-chain (#5260, preserves the symbol-count shape derivation),
feed-chain (#5261, values from the current effective default, do not
invent), trading/payment/saga (#5262, decision first). Together they
are the prerequisite for ranks 4 and for Define/schedule UX covering
all families.

**6. #5200 — the stock-side pick.** The options picker is fully
surfaced (`pickBestTrade`, route, NLQ, panel, scheduled discovery);
the stock side has no score, no ranking, no "top setups" view — first
`enter_long` signal wins, fixed qty 10. This is the single most visible
missing stock capability, and it feeds directly into #5203's queue
(ranked setups are what a user approves).

**7. #5502 — the Self-RSI build (Large, Low).** #5056 (AG-2) closed
2026-11-18 as a correction: the §7 pipeline is recorded as
`specified_only`, `self` mode resolves to `governed`, door writes of
`self` are refused. #5502 is the build the gate waits for: research →
synthesis → backtest → `StrategyCard` → 1-click activation, with a
human deciding activation. Low priority is the issue's own label — the
mode gate is deliberate until this lands.

**8. #3908 — the money gap.** Parent #3907 is closed; the fix it
tracked (PR #3913) did not include a credit/refund path. Five paid
jobs failed after 2h11m in that incident; the loss was small, but the
gap is structural: paid work that never completes has no refund
mechanism. Ranks here on hazard/integrity, not size.

**9. #5216 — schedule tools.** Feed already has the full pair
(`get_feed_job_schedule` / `set_feed_job_schedule`); enrich/analyze/
generate/deliver jobs carry stored schedules and the sync set already
names the eight tools — but none are registered, and no route or client
surface reads/writes them. Registration + a UX editor is the missing
step; high leverage (one pattern, four job families).

**10. #5208 — the proactive hedge.** Hedge drafts exist on demand only
(`POST /etrade/hedge/analyze`, panel). No MCP tool, no schedule, no
autopilot loop; the introspection tail-risk hedge is prose naming an
A2A event no code path publishes. Delivers protection the user does not
have to remember to ask for.

## Stock programme slice backlog — verified open, not individually ranked

These are open slices of the #2764 programme (verified open via the
`lane:clo-arsi` search). They are real work, but each needs intake
re-validation before ranking — several predate later work that may have
superseded or absorbed them (e.g. #2863 report replay vs the now-closed
#4467 run replay, which is a different scope but adjacent; #2913's
single delivery bridge vs #3542).

- #2861–#2868 — stock programme slices 3–7, AOP aspects once (#2868)
- #2880 — capability inventory with future extension points
- #2882 — goal-screen translated to StockScreenRunSpec
- #2884 — Patterns tab (read-only stock pattern catalog)
- #2886 — Presets tab (My Presets + proposed starters)
- #2890 — research subtabs migration (7 subtabs to canonical lifecycle)
- #2892 — deprecation/retention register cleanup
- #2910–#2914 — G3–G7 one-engine gaps (canonical rows, generation path, failure-path row, delivery bridge, private/direct callers)
- #2809, #2827 — Phase 2 slices 1–2 (normalized StockScreenRunSpec, ScreenExecutionBroker)
- #2766 — full-stack stock screening consolidation (programme sub-issue; the parent #2764 itself is the programme tracker, not rankable work)

## Cross-lane platform work (verified open, other lanes own it)

Not ranked as ours — listed so the user sees the shared-platform work
happening elsewhere. Verify ownership with the owning lane before
assuming any of it.

- **CEO lane — full-stack queue-workflow programme (#6079–#6086, #6078):**
  FS-1 UX-URL (workflow graph composition + run visibility), FS-2 AOP
  compliance, FS-3 J-stack graph execution, FS-4 canonical workflow
  spec/run API, FS-5 MCP workflow catalog + controls, FS-6 durable
  queue handoff, FS-7 agentic capabilities (bounded Copilot workflow
  composition), FS-8 release/operations + #6078 spec-controlled
  composition. Directly adjacent to ranks 4–5 and 21 (same seams).
- **CFO lane — data-foundation D1-first (#6131–#6139):** envelope +
  foreign keys for D1-native families; D1-first for watchlists/
  categories, memory/messages, marketplace/commercial tables; sessions
  + audit keys to D1. Adjacent to rank 27 (tenant credentials) and the
  closed #5023 set. Also #6056 (why so many job/run tables — 63-store
  inventory) and #6052/#6053 (follow-ups).
- **CTO lane — universal context (#6172–#6174):** validated
  ExecutionContext carried across the API layer, the MCP layer, and
  observability (recorder, log events, SLO endpoint). Adjacent to rank
  21 (stage control needs the same context). Also #6265/#6266 (stamp
  the validated context into queued MCP job payloads; the stalled
  async-job executor bug — the latter is a bug, listed for context).
- **COO lane — #6289:** OODA settings page manages/displays the
  effective execution configuration (#5975 UX slice).
- **Standards programme under #3695 (#3827, #3830–#3837, all open;
  lane not verified):** feature flags as a product, WCAG 2.2 AA,
  HAX Copilot patterns + generative UI, OWASP agentic safety, DTCG
  token tiers + anti-drift CI, AST codemods replacing string-splicing,
  declarative schema-driven views, dual-surfacing handoffs, standards
  checklist as a gate. Large programme work; #3832 (OWASP agentic
  safety) and #3834/#3835 (codemods, schema-driven views) are the most
  structurally leveraged.

## Excluded (one-off fixes / decided-not-to / already done)

- **#5023's 23 sub-issues — all CLOSED completed 2026-11-18**
  (#5025, #5033–#5044, #5055–#5064), and #5023 itself closed. #5037
  (HIGH, payment confirm) landed via PR #5428 with a §15. The
  data-model improvement set is done; nothing here is open work.
- **#5837 — CLOSED completed 2026-11-20.** The Cancel action was
  delivered on the `controlJobStage` seam (comment 7035212675), not
  via PR #5840 (closed unmerged, 0 commits). The earlier "re-create
  or leave filed-only" question is moot.
- **#4467 — CLOSED completed 2026-11-20** via PR #5902 (replay a past
  run as a new run of its definition version), §15 posted.
- **#3696, #3697 — CLOSED completed 2026-11-18** (UX harmonization S1
  left-nav, S2 'None' preset). #3737 closed completed 2026-11-19
  (catalyst feed).
- **#3214 — CLOSED, CTO lane** (`lane:cto-mbshr`). Fully agentic stage
  control via chat is the CTO lane's; not ours.
- **#5834 — decided-not-to** (options chain shares `optionsscr`;
  pinned by a test). Not an open improvement.
- **#5201 — [Fix] judge-score display** (`qualityScore` vs `score`):
  a one-off display bug, not a platform improvement. (Parent #5058
  is closed.)
- **#4961–#4965 — five [Fix] issues under #4935** (d1-only read-mode
  gate, telemetry projection, report-projector stale-guard, audit
  publication logging, tenant threading): single-symptom consistency
  fixes. Real, but fixes — kept out of this ranking.
- **#3909 — provider-level fetch timeouts** (robustness fix);
  **#3914 — paper-mode live test** (a test, not a capability);
  **#3748/#3749 — MCP scoping/security** ("no work now", user
  2026-11-08; #3749 is discussion-needed).
- **#4751 — merged, close parked** (not an improvement to rank; its
  §15/close waits on the user's word). **#5199 — umbrella tracker**
  for the unsurfaced set (parent, not work). **#2764/#2766 — programme
  trackers** (parents, not work).

---

## Verification

**Method:** GitHub `call-read-tool` only (read-only). `search_issues`
for `is:issue is:open label:lane:clo-arsi` (96 open, 4 pages) and
`is:issue is:open label:enhancement` (394 open, first page skimmed for
cross-lane items); `issue_read get` for state/title/labels on the named
issues; `get_sub_issues` for #5023 (23, all closed), #5199 (14, all
open), #4773 (7, all open), #3695 (30, mixed), #581 (3), #4935 (5),
#4930 (1); `get_parent` for #5201/#5209/#5210/#5212/#5213/#5218/#5219/
#5220; `get_comments` for #5037 (PR #5428 + §15), #5837 (Cancel
delivered), #4467 (PR #5902 + §15). Issue bodies read for #5502,
#3542, #5263, #5203, #3661, #5257, #5264, #3732, #2863, #773. The
unsurfaced gaps' evidence comes from
`~/workspace/verify-priority-queue/4774/unsurfaced/gaps-report.md`
(static survey on a 2026-11-17 main tree; "surfaced" means wired in
code, not verified live).

**Date checked:** Mon 2026-11-23.

**Could not verify:**
- #3213's parent via `get_parent` (returned no parent record) — the
  stage-control set's parentage is unconfirmed; the issues themselves
  are verified open.
- Size/Priority for most ranked issues — the search results carry only
  `enhancement`/`lane:clo-arsi` labels; Size/Priority live in the
  issue-body template and were read only for #5502 (Large/Low) and
  #5203 (Medium/High).
- Cross-lane items beyond the first page of the 394-open-enhancement
  search — the list is a skim, not an inventory.
- Whether any #2764 slice in the backlog section has been superseded
  by later main work — each needs intake re-validation before it is
  built or ranked.
