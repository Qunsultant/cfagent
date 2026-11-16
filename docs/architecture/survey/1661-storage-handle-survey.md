# #1661 Survey — thread a storage handle into service paths for full blob capture

**Base:** main `25b82c187dca` (survey worktree `~/workspace/w1661survey/wt`). Read-only; no writes, no GitHub mutations.
**Parent-verified 2026-10-26:** orchestrator.ts passes full `{sql, blobStorage, env}` platformDeps (correction 1 holds); `scheduledTasks.ts:1578` defensive conditional exists; `nasdaqUniverseSeamFromSql(sql, env, userLogin)` takes NO storage param and calls the bundle without storage (outcome-only by construction); `createFitDiscoveryRunner` deps carry NO storage param; `scheduledUniverseDeps` returns undefined without `platformDeps.sql` (discovery throws naming the seam).

## Headline corrections to #1661's framing (verified against code)

1. **Scope item 1's "scheduled `options_analysis` service leg" is NOT outcome-only.** Both serving constructions pass full capture deps: `src/agents/orchestrator.ts:655` (`{sql, blobStorage, env}`) and `src/agents/routes/schedules.ts:608`. The `...(platformDeps.blobStorage ? {storage} : {})` conditional at `src/services/scheduledTasks.ts:1578` is defensive only. STRUCK from scope (Q5).
2. **The genuinely outcome-only listings legs are narrower than the issue implies** — one shared helper plus the fit runner plus two scheduled constructions. Research-agent ×4, screener-agent goal, and the feedNasdaq shard are already full-capture.
3. **Two scheduled discovery sites are not outcome-only — they are no-handle (throw).** `scheduledCallbacks.ts:439` and `schedules.ts:705` construct `ScheduledTasksService` without `platformDeps`, so `scheduledUniverseDeps` returns undefined and discovery throws naming the seam. Threading a handle there changes behavior (throw → live fetch), not just provenance (Q3).

## Site table — listings legs (Nasdaq universe seam)

Seam: `nasdaqUniverseRouteBundle` (`screenerPipeline.ts:451`, `storage?` param = full capture vs outcome-only), `nasdaqUniverseSeamFromSql` (`:508`, NO storage param — outcome-only by construction), `ETradeService.getUniverseDeps()` (`etrade.ts:171`).

| # | Site | Handle in scope today | Verdict |
|---|---|---|---|
| L1 | Routes `etradeOptions.ts:182, 494, 556, 693, 787` + `etradeOptionsEvaluate.ts:172` (options discovery) via `getUniverseDeps()` | `ETradeService` holds `orm` + `env`; route ctx holds `getStorageSql()` but NO storage-object accessor | Construction-site change. Add optional `storage` to `nasdaqUniverseSeamFromSql` + `getUniverseDeps`, feed from a route-ctx storage accessor. One helper change covers all 6 route sites. |
| L2 | NLQ `nlq/execution.ts:1475, 1924`, `nlqOptionsStrategy.ts:1082`; MCP `mcp/etradeCommands.ts:58`; trading-agent `trading-agent.ts:185` (via `platform.screenMarkets`) | Same `ETradeService`/`platform` (`orm` + `env` in hand) | Same helper change as L1, zero per-site changes — all flow through `screenMarketsAsync` / `platform.screenMarkets`, which build the seam internally. |
| L3 | `fitDiscoveryRunner.ts:234` (universe deps; `createFitDiscoveryRunner` at `:184` has NO storage param) | 3 construction sites: `asyncJobs.ts:953` (`ctx.agentCtx.storage` in scope), `mcpChatNlq.ts:275` (route ctx, sql only), `tradingIntegrations.ts:91` (route ctx, `agentCtx` + sql) | Straightforward + small deps change. Add optional `storage` to `createFitDiscoveryRunner` deps, pass to the bundle call; pass `ctx.agentCtx.storage` at asyncJobs, route-ctx storage at the other two. Fixes universe leg AND history leg (H3) in one change. |
| L4 | Scheduled discovery: `scheduledTasks.ts:2352` (autonomousStrategyDiscovery), `:2843` (Derived), `:3184` (NoView) via `scheduledUniverseDeps` | Served by `scheduledCallbacks.ts:439` (no `platformDeps`) and `schedules.ts:705` (no `platformDeps`); `ctx.agentCtx.storage` in scope at both | Straightforward threading, WITH a behavior change. Add the 9th `platformDeps` arg (`{sql, blobStorage, env}`) at both constructions. Discovery goes from missing-seam throw → live fetch + capture. |
| L5 | `scheduledTasks.ts:3445` (`collectDailyIvHistory`) via `scheduledUniverseDeps` | Served by `scheduledCallbacks.ts:516` and `schedules.ts:659`, both without `platformDeps` | NO-OP — SKIP. Only calls `dataAgent.loadSnapshot({symbol})` per symbol (single-symbol path); the discovery branch is unreachable, so passed deps are inert. Threading changes nothing observable. |
| — | Already captured (NOT legs) | — | research-agent bundles `:429, 510, 674, 819` (all pass `storage: this.ctx.storage`); screener-agent goal bundle `:1076` (storage + `req.idempotencyKey`); shard `feedNasdaq` (`shardExecutors.ts:121`, `storage: deps.storage`); `autonomousOptionsAnalysis` (correction 1); market/goal screens delegate to ScreenerAgent. |
| — | Not legs | — | `flowService.ts:2173` calls `resolveDynamicFlowSymbols(filter)` with NO seam inside `getDynamicLiveFlowItems` (`:2148`, no seam param) → screenLive errors → curated-symbol fallback. No listings fetch happens, so nothing to capture; fixing it is a discovery-behavior change, not capture work. OUT of scope (Q4). `createLiveStockScreener()`'s no-seam default (`screeningRuntime.ts:120`) has ZERO production callers — dead, not a leg. |

## Site table — history legs (#1331 angle; `resolveYahooHistoryDeps` accepts optional `blobStorage`, `platformHistory.ts:211`)

| # | Site | Handle in scope today | Verdict |
|---|---|---|---|
| H1 | Backtest route `screenerResearch.ts:1432` (`executeScreenBacktest` bars) | Route ctx: `getOrm()`, `env`, `getScreenerExecutionContext()` (`{userLogin, environment}` only) — NO storage. Code comment itself names the follow-up: "thread a storage handle into the route ctx" | Construction-site change (same route-ctx decision as L1). Pass the handle as `blobStorage` to `resolveYahooHistoryDeps`. |
| H2 | `createDiscoveryService` (`discoveryService.ts:334`) — `blobStorage?` param exists at `:348` with comment "No caller passes one today — threading it through is a follow-up" | `asyncJobs.ts:953` (`ctx.agentCtx.storage` in scope); `mcpChatNlq.ts:275`, `tradingIntegrations.ts:91` (route ctxs) | Straightforward at asyncJobs; route-ctx decision at the other two. Zero API change — just pass the param. |
| H3 | `fitDiscoveryRunner.ts:216` (history deps) | Same 3 sites as L3 | Same change as L3 — one `storage` param feeds both history and universe calls. |
| — | Already captured (NOT legs) | — | research-agent history `:414, 495, 659, 804` (all pass `blobStorage: this.ctx.storage`); screener-agent history `:769` (same). |

## The handle question (the one design decision)

No leg was found that genuinely CANNOT carry a handle — the binding constraint is the route-ctx interface, not availability. Two candidates:
- **(a) Extend the route ctx (ADOPTED).** The orchestrator's ctx builders already hold DO storage in scope — `getStorageSql: () => this.ctx.storage.sql` (`orchestrator.ts:1772, 1973`). Adding a storage accessor to the route ctx interfaces reuses the existing DO storage and capture path, so route-leg blobs land in the same store as agent-leg captures. Small framework touch, zero new storage code.
- **(b) New R2→`CaptureBlobStorage` adapter.** Worker `env` binds `REPORTS_BUCKET` → bucket `screener`, but NO adapter from `R2Bucket` to `CaptureBlobStorage` (`{get, put}`, `captureStore.ts:179`) exists — `reportBlobStore.ts` only wraps R2 for report PDFs. New code, and blobs would live in a different store than agent-leg captures. REJECTED (reuse-before-build).

DO/agent contexts need no decision: `this.ctx.storage` / `ctx.agentCtx.storage` is already the handle.

## Recommended slice order (smallest safe first) — ADOPTED as one PR (one issue, related changes)

1. **S1 — Scheduled discovery constructions** (`scheduledCallbacks.ts:439`, `schedules.ts:705`): add `platformDeps` with `ctx.agentCtx.storage`. Pure threading, no API change. (Behavior note per correction 3 — DISCLOSED, see below.)
2. **S2 — Fit runner** (`createFitDiscoveryRunner` + 3 sites): one param fixes L3 + H3 together.
3. **S3 — DiscoveryService at asyncJobs** (`:953`): pass `ctx.agentCtx.storage` to the existing param.
4. **S4 — Seam helper + route legs** (L1 + L2 + H1 + H2-route-sites): add `storage` to `nasdaqUniverseSeamFromSql`/`getUniverseDeps`, feed from the route-ctx accessor; pass `blobStorage` at `screenerResearch.ts:1432` and at the H2 route sites.
5. **S5 (SKIPPED) — `collectDailyIvHistory` constructions**: inert (L5), zero observable change. Skipped, disclosed — not diff noise for zero benefit.

## Scope questions — ADOPTED answers (parent, 2026-10-26)

- **Q1 — History in scope? YES.** #1661 scope item 2 names the #1331 bindings, which ARE history bindings; the fit-runner change fixes both anyway. Acceptance grep covers `resolveYahooHistoryDeps`/`bindYahooHistoryDeps` too.
- **Q2 — Route handle: (a) route-ctx storage accessor.** Uniform blobs, no new storage code.
- **Q3 — Throw→fetch behavior change at S1: PROCEED, DISCLOSED.** The two scheduled discovery sites currently fail closed (missing-seam throw); threading makes them fetch live + capture. That IS the point of threading (a throwing leg never fetches, so no capture row could ever land) and is required by the issue's acceptance ("zero legs remain outcome-only"). It must be NAMED in the PR body and §15 as a behavior change, not just provenance — never presented as provenance-only.
- **Q4 — `flowService` curated fallback: OUT of scope.** Needs a seam (and a sql source for `getDynamicLiveFlowItems`) before capture is meaningful; a discovery fix, not a capture fix. Separate issue if wanted — NOT filed here.
- **Q5 — Strike `options_analysis` from scope item 1: YES.** Already full-capture at both serving sites (verified firsthand).

## Pin implications

- The p1378 pins assert the helper's with/without-storage contract (`tests/data_provider_nasdaq_residuals_p1378.test.ts:380, 407`), which #1661 PRESERVES — no pin breaks.
- Each slice ADDS a pin asserting a capture row lands at its newly threaded leg (stubbed capture store, following the `:380` pattern). The p1331 pin file asserts no outcome-only behavior, and `fit_discovery_kernel` mentions no storage — both need NEW pins, not edits.
