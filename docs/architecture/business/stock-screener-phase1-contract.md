# Stock screener Phase 1 contract — consolidation (#2764, #2766)

**Status:** Phase 1 contract for human review. No execution change. This document is the deliverable for Phase 1; no screening code, routing, or runtime is changed by the PR that adds it.

**Related issues:** #2764 (parent tracking: stock-only screener lifecycle consolidation, lossless, with user-managed pattern catalog), #2766 (full-stack sub-issue: usable patterns, pattern-oriented AOP architecture, stock-only UX). Coordination reference (not a dependency for this docs-only PR): #2621 (options programme, runtime unification, agent #cfo-qunso).

## 1. Purpose

Define, before any execution change, the single contract, DAG model, and canonical state model that all stock screening paths will use. Phase 1 ends with human review of this contract, not with migrated code. Phase 2 (broker extraction) starts only after that review.

## 2. Scope boundary (from #2764, re-affirmed)

In: stock screening only. Manual REST, async REST workflow, chat mesh, NLQ stock-screen port, scheduled stock screening including sharded runs, and all stock-related MarketDataResearchHub subtabs (screener, report, quoting, fundamentals, bars, snapshot, compare).

Out: options, goal screening, trading facade / order execution, Pareto evaluation (#2773), FINRA/SEC legal platform (#2772), screening-semantics changes.

Lossless: no pattern, preset, schedule, run, result, artifact, delivery, or paid-run record dropped, truncated, merged, or silently defaulted. Nothing related to stock is out of scope by the stock rule; the exclusions above are by asset class / domain, not by stock relation.

## 3. Screening tool contract (proposed, to be verified against current main in review)

Input (canonical, one shape for all paths):

- assetClass: "stocks" only for this programme
- criteria: StockScreenerFilter (shared schema, src/trading/screeningSchemas.ts)
- patternRef: optional, { patternId, version } — a reference, NOT a copy of pattern criteria
- presetRef: optional, { presetId } — resolved at run time, user-scoped; schedule payloads carry presetId, not a frozen filter
- universe: explicit universe descriptor (full listings, keyword-filtered, or user-filtered)
- delivery: explicit delivery envelope (inline, WebSocket, chat read-back, scheduled delivery, email/Slack/webhook/PDF where already supported)
- idempotencyKey: caller-supplied or derived, required for paid and scheduled runs
- runMode: manual | async | chat | nlq | scheduled | research

Output (canonical):

- runId, parentRunId (on replay), trigger source, patternRef/presetRef as resolved, criteria as validated
- stage trace, provenance (provider, quote source, fallback used), partial-result flag
- results (full scanned set + standouts, distinctly marked), artifacts (report/PDF/CSV where requested), delivery outcomes per destination
- failure taxonomy: transient | permanent | partial | failed-preset (loud, no silent default)

Rules:

- A stock run rejects an options preset loudly. A missing/bad preset fails loudly, never silently defaults.
- Pattern application must be deterministic: same pattern version + same criteria overrides = same derived filter. Overrides are stored separately from the pattern definition.
- Paid runs: charged once per runId; idempotencyKey prevents duplicate charge on retry/replay. Replay charging is decided in §8, not assumed.

## 4. DAG model (proposed)

Nodes (stock lifecycle, in dependency order):

1. acquireUniverse
2. fetchQuotes (provider-primary, per-symbol fallback + retries, as in current scheduled path)
3. enrich (technicals: RSI, MACD, SMA distances, volume, 52-week position, etc.)
4. computeIndicatorsAndScores (including factor grades)
5. applyFilters (criteria + pattern-derived filter, if any)
6. rankAndGrade
7. detectStandouts
8. persistCanonicalResults
9. shapeReport
10. deliver

Execution semantics (broker-owned, not path-owned):

- dependency order, parallelism per node type, per-node timeouts, central retry policy with per-node-type sub-budgets (shards as a sub-budget)
- completion: complete | partially-complete (failed non-required node, partial results marked) | failed
- failure: transient retried, permanent classified, never-list: no silent nulls, no lazy fallbacks
- idempotency: node-level and run-level, replay creates new run linked to original

Shards: sharded screening is a DAG execution mode (partition universe, run node set per shard, merge), not a separate workflow. Shard failure = partial result for that shard, marked, not silent omission.

## 5. Canonical state model

- Run: id, trigger, mode, user, session, criteria, patternRef, presetRef, universe, status, created/completed, idempotencyKey, paid flag
- Stage: runId, node, status, input/output ids, provider/provenance, retry count, error taxonomy
- Artifact: runId, type (result set, report, PDF, CSV), renderer version, delivery destination, delivery status
- Delivery: runId, destination, status, attempt count, duplicate-suppression key
- Pattern: id, version, assetClass, indicators, guardrails, paired strategy ids (stock patterns only in v1 catalog; options families excluded), risk notes
- Preset: id, user, assetClass, criteria, created/updated — separate table/model from Pattern, never merged

Lossless inventory (to be run before and after each phase): pattern count, preset count, schedule count, run count, artifact count, delivery count — must reconcile 1:1, exceptions listed and approved.

## 6. UX contract (stock only, after programme: 20 tab URLs)

Existing 18 + new patterns tab + new presets tab:

- ?tab=screeners&view=stocks | new-screen | run-screen | reports | schedules | review | track-record | scanner | iv-history
- ?tab=chat (mesh) | ?tab=nlq
- ?tab=research&view=screener | report | quoting | fundamentals | bars | snapshot | compare

New: ?tab=screeners&view=patterns — read-only in v1, usable in the full-stack sub-issue (select → apply to a stock screen → run via the single lifecycle → optionally save as preset).

New: ?tab=screeners&view=presets — presets catalog. System/starter presets are read-only in the catalog; choosing one copies it to the user's own presets (My Presets), which the user can edit, run, and schedule. The catalog preset and the user's copy are separate rows; editing the copy does not edit the catalog. Starter names proposed (not yet finalized): Trend Breakout, Pullback Reversion, Momentum Leaders, Oversold Bounce, Volume Surge, 52-Week Strength, Value Zone, Squeeze Watch. Preset catalog is separate from pattern catalog and from ScreenerPresetManager's My Presets list.

Panels (not URLs) inside those tabs: StockCriteriaPanel, ScreenerPresetManager, ScreenerResultsView, ScreeningReviewPanel, ScreeningOutcomesPanel, RunDetailView, SchedulesPanel, ReportsPanel, MorningDigest, FirstRunScreen.

No existing tab is removed. Legacy ?screenerTab= continues to resolve.

## 7. Phase 1 exit condition (for human review)

- [ ] Contract, DAG, and state model above verified against current main (file paths, schema names, provider fallback behaviour, paid-run charging, schedule preset resolution)
- [ ] CF broker location verified — an earlier check did NOT find src/agents/cf/broker.ts in main; Phase 1 review must name the actual broker/planner location or state that it is to be created, not assumed existing
- [ ] Pattern vs preset separation and lossless inventory test plan approved
- [ ] Reviewer approves Phase 1 before Phase 2 (broker extraction) starts
- [ ] No code execution change lands in Phase 1; this document is the deliverable

## 8. Decisions adopted to unblock execution (user may override in chat)

1. Replay charging: recovery replay of failed units is not re-charged; a new intentional replay is charged as a new run.
2. Pattern versioning: pinned at run creation.
3. Shard merge rule: partial run, marked shard, not fail whole run.
4. Delivery duplicate-suppression: by (runId, destination), retry-safe, no duplicate delivery within a run.

## 9. Coordination with options programme #2621 (agent #cfo-qunso)

Options programme is runtime unification for options, journey 1 manual strategy panel, using ThinkWorkflows, Schedules/Cron, Queues, one stage runner, mas_async_jobs checkpoints, pipelinePolicy, breakerDecorator, outcomeCatalog single resolver, one recorder, one delivery bridge.

Stock programme must reuse that shared runtime, not duplicate it: no second recorder, catalog, port layer, unit store, or generic AOP framework. Domains stay separate (stock vs options), shared surfaces (ScreenersHub nav, iv-history, scanner naming, report/delivery parity) require coordination, not unilateral change. Stock programme does not change options selection, thesis, caps, or content, and does not merge before options slice 1 dependencies that are options-only.

This Phase 1 PR is docs-only and changes no shared runtime, so it does not queue ahead of any options dependency and does not depend on options-only code. Later stock phases that touch a shared surface must coordinate with #2621 first and stop if that coordination would break it.
