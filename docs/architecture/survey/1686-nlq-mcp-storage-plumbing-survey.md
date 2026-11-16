# #1686 SURVEY — Plumb storage through NLQ / MCP / trading-agent contexts (L2 follow-up to #1661)

Survey base: current main `39b15548acc6f00ec4adec99702f9c9a0654b28b`, worktree `~/workspace/w1686survey/wt`.
#1661 is on main (merge `e2b070c0`); the pin file `tests/data_provider_service_capture_p1661.test.ts` exists in the tree.
#1686: filed 2026-10-26T09:41:30Z, state OPEN, label `lane:cdo-mha7`, **0 comments** (public API read 2026-10-26).

Scope verdict up front: the issue's three-leg framing is **mostly right but needs two corrections** —
(C1) the trading-agent leg does NOT fetch outcome-only today: it returns the missing-seam error result, because its platform is built with `orm: undefined`. Fixing it needs an orm/sql source threaded alongside storage, not storage alone — and that turns an error into a live fetch, a real behavior change that must be disclosed like #1661's scheduled-discovery change.
(C2) the `McpToolContext` path in the issue body is wrong: it lives at `src/patterns/interfaces.ts:23`, not `src/mcp/patterns/interfaces.ts:22` (that path does not exist).
The NLQ and MCP legs are confirmed exactly as filed. The completeness sweep found NO additional outcome-only *fetch* legs, but two error-result (no-fetch) legs and one dead class that the build must explicitly disposition, not silently absorb.

---

## 1. NLQ stock-screen path

### Entry and context construction

NLQ has two executor cores in `src/agents/nlq/execution.ts`:

- `executeNLQQueryCore` (:244) — sync core. Constructs `new ETradeService(orm, env, sessionId)` at :466. It makes NO `screenMarketsAsync` call (grep shows the only two call sites are in the async core), so it is out of the threading path except as a construction precedent.
- `executeNLQQueryAsyncCore` (:1388) — async core, signature:
  ```ts
  async function executeNLQQueryAsyncCore(
    orm: DatabaseORM, sessionId: string, plan: NLQPlan, env?: Env,
    userLogin?: string, userDid?: string, deps?: NLQExecutionDeps
  )
  ```
  Constructs `new ETradeService(orm, env, login)` at :1417 (login is the threaded authenticated identity; #1185 forbids any synthetic fallback identity).

Public entries funnel into the async core:

- `executeNLQQueryAsync` (:2243): `(orm, sessionId, plan, env?, userLogin?, userDid?, deps?: NLQExecutionDeps)` — passes `deps` straight through.
- `executeNaturalLanguageQuery` (:2263): `(orm, sessionId, query, env, userLoginOrOptions?, userDid?, options?: {...})`. The inline `options` type (:2270) carries `scanRunStore?, profileStore?, schedulingPort?, stockScreenPort?, socialBriefPort?, discoveryRunner?, fitDiscoveryRunner?` — **no storage field**. The deps object is built at :2290–2291 from those options; the build adds `storage?` here and forwards it into the deps object. Note the guard: deps are built only if at least one option is present — storage must join that guard condition, or a storage-only call would drop it.

### The two L2 call sites (both inside AsyncCore)

- :1475 — the `screen` action: `await etrade.screenMarketsAsync(screenFilters)`. Reached only when `deps?.stockScreenPort` is absent (:1457 guard).
- :1924 — the `watchlist_save` fallback: `await etrade.screenMarketsAsync(plan.tradingData?.filters)`. Reached only when `deps?.stockScreenPort` is absent (:1917 guard).
- :1749 — `runOptionsStrategyAction(etrade, action, filters, {...})` passes AsyncCore's `etrade` instance into `src/agents/nlqOptionsStrategy.ts`. Its scope-resolution branch calls `etrade.screenMarketsAsync(scope.filters)` at `nlqOptionsStrategy.ts:1082`. The structural parameter type at `nlqOptionsStrategy.ts:751` declares `screenMarketsAsync(filter?: any)` (one arg). Covered by the same fix as :1475/:1924 IF the fix rides on the service instance; if the fix passes a seam at the call site, this structural type must widen to an optional second `seam?: NasdaqUniverseSeam` parameter (additive).

### Where storage enters: the NLQ route already has it

`src/agents/routes/mcpChatNlq.ts` — the route ctx carries `getStorage?()` (:72, #1661 idiom) and already threads it to the discovery/fit runners at :332 (`blobStorage: ctx.getStorage?.()`, `storage: ctx.getStorage?.()`). But the route **binds NO stock-screen port** — its own comment at :322–326 says so explicitly ("the REST route binds NO stock-screen port, so stock screens still fall back to the listings screener here, in both modes; the async job is the stock-screen surface").

Two route modes, BOTH hit L2:
- `rest` mode (:332): full options object, no `stockScreenPort` → AsyncCore fallback legs.
- `mcp` mode (:328–330): `executeNaturalLanguageQuery(orm, sessionId, query, ctx.env, userLogin, userDid)` with NO options at all → `deps` undefined → AsyncCore fallback legs. The "NO options" shape is deliberate per the :322 comment, so covering mcp mode means either a narrow disclosed exception (pass `{ storage }` in mcp mode too) or an explicit decision to leave mcp mode outcome-only. See Open Question Q2.

NOT L2 (already capturing through the port):
- Async-job NLQ (`src/agents/orchestrator/asyncJobs.ts:1017`): passes `stockScreenPort` AND storage-threaded discovery/fit runners → screen actions run through `nlqStockScreenPort` → ScreenerAgent `runScreen` (the #1661-closed agent leg, `screener-agent.ts` deps built with `blobStorage: this.ctx.storage`).
- Chat-fallback NLQ (`src/agents/orchestrator.ts:1680` via `chatErrorFallbackContext`): passes `stockScreenPort` → same port path.
- The `types.ts` comment claiming "async jobs" are among the port-less contexts is STALE relative to `asyncJobs.ts:1017` — do not use it as evidence.

### NLQ threading points (in order)

1. `NLQExecutionDeps` (`src/agents/nlq/types.ts:143` area; interface extends `OptionsStrategyDeps`): add `storage?: NasdaqUniverseRouteBundleInput["storage"]` (additive, optional). Precedent: the interface already grows by optional port; the type of the handle is the bundle input's `storage` field (`src/trading/screenerPipeline.ts:442`: `{ get, put }` — a minimal structural handle, NOT a DO class import).
2. `executeNaturalLanguageQuery` options type (:2270): add `storage?` (same type) + add it to the :2290 guard and the :2291 deps literal (additive).
3. `executeNLQQueryAsyncCore` (:1388): no signature change needed if `deps` carries storage — read `deps?.storage` at the two call sites. (If the build prefers service-carried storage instead, see §5 design note: the :1417 construction gains an optional 5th argument — but `ETradeService`'s ctor takes only 4 today, see Q1 below.)
4. Call sites :1475 and :1924: pass a seam built from `(orm.getSql?.(), env, login, deps?.storage)` — OR pass nothing and let a storage-carrying service build it (see §5). Either way the #1661 params reached are `nasdaqUniverseSeamFromSql`'s 4th `storage` param (`screenerPipeline.ts:511`); `getUniverseDeps` is NOT on this path (it returns options-discovery deps, not a screenLive seam) and `screenMarketsAsync`'s own signature needs no change (it already takes `seam?`).
5. `nlqOptionsStrategy.ts:751` structural type: widen ONLY if the call-site-seam design is chosen (additive optional 2nd param); no change under service-carried storage.
6. Route `mcpChatNlq.ts:332` options literal: add `storage: ctx.getStorage?.()` (additive). For mcp mode (:328–330): see Q2.

No new capture design is needed: the seam's bundle already captures with `runId: crypto.randomUUID()` (`screenerPipeline.ts:523`) and the run context carries `userLogin` — same shape as the closed legs.

---

## 2. McpToolContext and the MCP stock-screen tool

### Current fields (corrected path)

`src/patterns/interfaces.ts:23` — `McpToolContext` (NOT `src/mcp/patterns/interfaces.ts:22`, which does not exist):

| Field | Line | Notes |
|---|---|---|
| `env: Env` | :24 | |
| `orm: DatabaseORM` | :25 | |
| `sessionId: string` | :26 | doubles as the userLogin in the scan tool |
| `scopedModes?` | ~:33 | #1721 carriers |
| `scopedNlqModes?` | ~:40 | #1722 carriers |
| `scopedKnowledgeModes?` | ~:47 | #1723 carriers |
| `scopedMemoryModes?` | ~:55 | #1723 carriers |
| `requestId?` | :56 | |
| `audit` | :57 | required |
| `facade?` | :58 | |
| `submitJob?` / `getJob?` / `listJobs?` | :59–:66 | |

The #1721/#1722/#1723 carrier precedent is exactly the pattern a storage field follows: optional, populated by the execution-context owner, unset → today's behavior.

### The tool and its construction

`src/mcp/etradeCommands.ts:57–58` — `ETradeMarketScanCommand.execute`:
```ts
const etrade = new ETradeService(context.orm, context.env, context.sessionId);
const result = await etrade.screenMarketsAsync(input);
```
No seam, so it funnels into the internal build at `src/services/etrade.ts:158` (outcome-only).

### Where contexts are built (the supply side)

- **Chat turns (the live MCP-scan path):** `src/agents/orchestrator/chatTurnHelpers.ts:71` `createTurnTools(ctx, requestId)` builds the context literal (:75–87: env/orm/sessionId/requestId/facade/submitJob/getJob/listJobs/audit) with NO storage. Its input `ChatTurnHelpersContext` (:29) carries `ensureTables` (i.e. `storage.sql`!), `getOrm`, `sessionKey` — but NO blob-storage handle field. The orchestrator supplies it at `src/agents/orchestrator.ts:1398–1399` from `chatTurnHelpersContext()` (:286–299), which has `this.ctx.storage` in scope (same object that supplies `ensureTables`/`getOrm`). So: add `storage?` to `ChatTurnHelpersContext` (additive), supply `this.ctx.storage` in the orchestrator's builder, forward it in `createTurnTools` into `McpToolContext.storage`. The tool is reachable as a Think tool through this path (`createAgentMcpTools` adapts the factory's commands; `chatPrompt.ts:96,132` documents `etrade_market_scan` as the chat scan tool).
- **REST bridge:** `src/agents/routes/restToolBridge.ts:42` `restToolContext(parts)` builds a context from `RestToolParts` (:26–38: orm/sessionId/audit/env/scoped carriers — no storage). Its callers (`runRestTool`, :61) are memory/ads/audit/schema/payments routes — NONE invokes `etrade_market_scan`. Adding `storage?` to `RestToolParts` + forwarding is cheap completeness, not a live path; the build may include it or explicitly defer it.
- **Hosted-MCP direct entry:** no separate context builder was found — `McpToolFactory.executeTool` is called only from the REST bridge, and `createAgentMcpTools` only from chat turns. If a hosted MCP endpoint builds contexts elsewhere, it was not located in this sweep; the build should confirm before claiming full MCP coverage (see Q4).

### Additive field design

```ts
storage?: import("../trading/screenerPipeline").NasdaqUniverseRouteBundleInput["storage"];
```
- Optional, backwards-compatible: every existing constructor of the literal (chat turns, REST bridge, tests) compiles unchanged; tools that ignore it are unaffected.
- Type note: the handle is the structural `{ get, put }` pair, not a Durable Object type — no new import cycle (the type-only import mirrors the existing `import("../config/nlqModes")` inline-type idiom already in this interface).
- Degradation contract (mirrors `getUniverseDeps`): tools without storage keep today's outcome-only behavior; tools with storage capture. No tool changes behavior except `etrade_market_scan` (and any future tool that reads the field).

### Consumers that must NOT be affected

Every other `IMcpToolCommand.execute(input, context)` implementation reads only its own fields; adding an optional field changes no existing read. Files with `execute(input, context: McpToolContext)` implementations: `src/mcp/commands.ts` (incl. `knowledge_search` + platform grounding), `cloudflareAgentCommands.ts`, `agentDbReadCommands.ts`, `agenticPaymentCommands.ts`, `goalChainCommands.ts`, `src/agents/mcpAdapter.ts` (adapter only, passes context through). None constructs an `ETradeService` or calls `screenMarketsAsync` except `etradeCommands.ts`. The `scoped*` carrier fields are the model for "additive, owner-populated, unset falls through" — follow it.

---

## 3. Trading-agent path

### Execution chain

`src/agents/trading-agent.ts`:

- `TradingServiceContext` (:113–118): `{ env, config, userLogin, resolvePlatform }` — NO orm, NO storage.
- `stock_screening` service execute (:177–186): `const platform = ctx.resolvePlatform(input.provider); ... return platform.screenMarkets(input.filter ?? {});` — no seam.
- `executeTradingService` builds the ctx at :480–487: `{ env, config, userLogin, resolvePlatform: (providerId) => resolveTradingPlatform(env, config, providerId, userLogin) }`.
- `resolveTradingPlatform` (:366–~400): validates provider/login, then `TradingPlatformRegistry.getPlatform(provider, env, undefined, userLogin, ...)` — **orm is hard-passed `undefined`**.
- `TradingPlatformRegistry.getPlatform` (`src/trading/registry.ts:30`): `factory(env, orm, userLogin, overrideEnv)` — passes the undefined orm straight into `ETradeTradingPlatform`.
- `ETradeTradingPlatform` ctor (`src/trading/etrade/platform.ts:63–72`): `(env, orm, userLogin, overrideEnv?, existingClient?)`, stores `orm` (undefined here).
- `platform.screenMarkets` (:233–240): `seam ?? nasdaqUniverseSeamFromSql(this.orm?.getSql?.(), this.env, this.userLogin)` — with orm undefined, `nasdaqUniverseSeamFromSql` returns `undefined` immediately (`screenerPipeline.ts:518`: `if (!sql) return undefined`).
- `DynamicMarketScreener.screenLive` (`src/trading/screener.ts:782`): with `seam === undefined`, `acquireUniverse({ mode: "all-listings", universeDeps: undefined, universeRoute: undefined })` (:813–818) returns the **missing-seam error-result shape** (decision D1, #1378) — no listings fetch happens at all.

### Correction to the issue's framing (C1)

The trading-agent leg is NOT "a successful fetch [that] leaves no capture row" today. It is a **missing-seam error result**: no fetch, no capture row, no outcome row for a fetch. Threading storage alone cannot fix it — `nasdaqUniverseSeamFromSql` without sql returns undefined regardless of storage. The fix must thread an orm/sql source AND storage, and it converts an error into a live fetch + capture. That is a genuine behavior change (same disclosure class as #1661's scheduled-discovery throw→fetch change), not a capture-only addition.

### Where storage + orm exist upstream

`TradingAgent` (`trading-agent.ts:778`) extends `Think<Env>` — the same DO-agent base as the orchestrator, so `this.ctx.storage` is available in principle (the orchestrator reads `this.ctx.storage` throughout; `TradingAgent` itself never references `this.ctx` today — its `getTools()` at :803–805 passes only `(this.env, this.config(), this.instanceUserLogin() ?? undefined)`). It has NO `getOrm()` method today (grep: no `getOrm` in the file; `instanceUserLogin()` at :830 is its only instance-identity helper). The DO's SQL handle would come from the same `AgentContext["storage"]["sql"]` shape the orchestrator's `ensureTables`/`getOrm` expose — but the exact accessor on this class must be established by the build (Think base vs orchestrator's own `getOrm` helper). This is the least-mapped part of the chain; see Q3.

### Trading-agent threading points (in order)

1. `TradingAgent.getTools()` (:803–805): pass the DO storage handle (and an orm/sql accessor) into `buildTradingTools` — new optional params (additive).
2. `buildTradingTools(env, config, userLogin?)` (:502): accept optional `storage?` (+ orm?) and forward into `executeTradingService` calls (additive).
3. `executeTradingService` ctx literal (:480–487): add `storage?` (+ `orm?`/`sql?`) to `TradingServiceContext` (:113) and forward into `resolveTradingPlatform` (additive optional params on both).
4. `resolveTradingPlatform` (:366): accept optional orm/storage; pass orm through to `getPlatform` instead of `undefined`, and storage through to the platform (additive). `TradingPlatformRegistry.getPlatform` signature (:30) needs NO change for orm (it already takes it); storage needs either a new optional param on `getPlatform` + the etrade factory, or the seam built at the execute site — see §5 design note.
5. `ETradeTradingPlatform` ctor (:63): new optional `storage?` param (additive, 6th) OR the execute site builds the seam: `platform.screenMarkets(filter, await nasdaqUniverseSeamFromSql(orm?.getSql?.(), env, login, storage))` — `screenMarkets` already takes `seam?` (:233), so no signature change there either way.
6. `stock_screening` execute (:177–186): pass the seam (or rely on the storage-carrying platform's internal build at :239 — the internal-build site, see §4).

Door 3 typed RPC (`executeService`, :808–811) and A2A dispatch (:934, :963, :1026) funnel through the same `executeTradingService`, so covering that function covers all doors. `TradingAgent` is exported from `src/server.ts:175` (DO registration); no other construction site was found.

---

## 4. The two internal-build sites (verify + disposition)

Verified on current main at the SAME lines as #1661's §15:

- `src/services/etrade.ts:158` — inside `ETradeService.screenMarketsAsync` (:152–160): `seam ?? (await nasdaqUniverseSeamFromSql(this.orm?.getSql?.(), this.env, this.userLogin))` — no storage arg.
- `src/trading/etrade/platform.ts:239` — inside `ETradeTradingPlatform.screenMarkets` (:233–240): identical internal build, no storage arg.

**Disposition: IN #1686's scope, as the mechanism — not a separate residual.** Every L2 caller funnels through exactly one of these two lines (NLQ + MCP → :158; trading-agent → :239). They are the lines the #1661 PR and §15 named as L2. Two ways to resolve them, and the build must pick one (see §5):

- (a) Call-site seams: these lines stay as the no-storage fallback for callers that pass nothing; L2 callers pass a pre-built seam, so these lines are no longer on their path. The lines remain, but L2 is closed.
- (b) Service-carried storage: these lines gain the storage arg (`..., this.storage)`), so the internal build captures whenever the service/platform was constructed with a handle. The lines change, and L2 is closed for every caller of that instance.

Either way there is nothing left to file separately about these two lines after #1686 — unless the build chooses (a) AND some caller is missed, in which case the missed caller (not the line) is the residual.

---

## 5. Completeness sweep — every caller passing NO storage

Method: grepped `nasdaqUniverseSeamFromSql`, `getUniverseDeps`, `screenMarketsAsync`, `acquireUniverse`, `screenLive`, `screenMarkets(` across `src/` on the survey tree, then classified each site by whether a fetch actually happens.

### A. Outcome-only FETCH legs (successful fetch, no capture row) — #1686's scope

| Site | Path | Funnels through |
|---|---|---|
| `src/agents/nlq/execution.ts:1475` | NLQ `screen` action, port-less | `etrade.ts:158` |
| `src/agents/nlq/execution.ts:1924` | NLQ `watchlist_save` fallback, port-less | `etrade.ts:158` |
| `src/agents/nlqOptionsStrategy.ts:1082` | NLQ scope resolution (called from `execution.ts:1749` with AsyncCore's service) | `etrade.ts:158` (via the passed instance) |
| `src/mcp/etradeCommands.ts:58` | MCP `etrade_market_scan` | `etrade.ts:158` |
| `src/agents/trading-agent.ts:185` | Trading-agent `screen_stocks` | `platform.ts:239` — BUT see C1: today this is an error result, not a fetch (orm undefined) |

**The NLQ/MCP/trading-agent set IS exhaustive for outcome-only fetches.** No other `screenMarketsAsync`, `screenMarkets(`, or seam-less `screenLive` call site performs a listings fetch.

### B. No-fetch legs — explicitly NOT outcome-only; disposition required, not silent absorption

| Site | What happens today | Disposition |
|---|---|---|
| `src/services/screeningRuntime.ts:120` (default) + `:209` | `createProductionScreeningRegistry` defaults `stockScreener` to `createLiveStockScreener()` with NO seam (`:101–111`); the listings stock leg of a goal screen returns the missing-seam error result. The screener-agent goal path (`screener-agent.ts:1035,1067,1094–1096`) builds a Yahoo screener when Yahoo deps exist, else passes nothing → same default. The agent DOES build a storage-carrying bundle for options discovery (`screener-agent.ts:1076–1086`) but does not build a listings stockScreener from it. | Out of #1686's stated scope (goal screens are none of NLQ/MCP/trading-agent) AND not outcome-only (no fetch). If the issue's Outcome ("zero listings legs remain outcome-only") is read strictly, this already satisfies it. If it is read as "every listings leg captures", goal screens need a NEW seamed listings screener — new behavior, separate decision. Recommend: name it in #1686's §15 as a known non-outcome-only leg, do not absorb it into the build without a scope decision. |
| `src/trading/options/flows/flowService.ts:2173` → `:1718` | `resolveDynamicFlowSymbols(filter)` with NO seam → `screenLive(filter, undefined)` → missing-seam error → caught (`:1768–1770`) → curated-universe defaults (`:1772+`). | Already ruled OUT of scope by #1661 Q4 (flowService curated fallback). Re-confirm the exclusion; do not touch. |
| `src/trading/screener.ts:813` | `screenLive`'s own internal `acquireUniverse` call — not a caller leg; it consumes whatever seam was passed. | N/A. |
| `src/agents/screener-agent.ts:780,788` | `acquireUniverse` with `yahooDeps` / `quoteDeps` (platform-routed, #1661-closed). | Closed already. |
| All `getUniverseDeps?.(storage)` route sites (`etradeOptions.ts:182,496,558,697,791`, `etradeOptionsEvaluate.ts:172`) | Storage passed. | Closed already. |

### C. Dead code — verified, excluded

- `src/trading/agent.ts:39` — `TradingMicroAgent.screenOpportunities` calls `this.platform.screenMarkets(filter)` with no seam. **Zero constructors of `TradingMicroAgent` exist in `src/`** (grep). Dead path; if it is ever wired, it needs the §3 treatment (its platform comes from `TradingPlatformRegistry.getPlatform(platformId, env, orm, userLogin)` at :37, which at least carries orm — unlike the registry path). Do not build for it now; note it in the §15 so a future wiring doesn't silently reintroduce an outcome-only leg.

### Design note (applies to all three legs)

Two coherent designs, both reaching the #1661 params with no new capture code:

- **Design A — call-site seams (zero service signature changes).** Each call site builds `await nasdaqUniverseSeamFromSql(orm?.getSql?.(), env, login, storage)` and passes it as the existing optional `seam?` arg (`screenMarketsAsync` :152, `screenMarkets` :233). Import-cycle check: `screenerPipeline.ts` imports only from `./*`, `../services/*`, `../orm` — nothing from `agents/` or `mcp/` — so no cycle. `nlq/execution.ts` already imports from `../../trading` (:14, :17); `mcp/etradeCommands.ts` already imports from `../trading` (:14). Cost: the seam-build expression duplicated at 4+ sites.
- **Design B — service-carried storage (matches #1661's idiom).** `ETradeService` ctor gains optional 5th param `storage?` (current ctor :67 takes 4); `screenMarketsAsync`'s internal build (:158) passes `this.storage`. `ETradeTradingPlatform` ctor gains optional 6th param `storage?` (current ctor :63 takes 5); `screenMarkets`' internal build (:239) passes it. Call sites then only thread the handle into constructions (NLQ :1417/:466, MCP :57, trading-agent platform construction). Cost: 2 ctor + 2 method changes, all additive-optional; benefit: one seam-build site per service, and the structural type at `nlqOptionsStrategy.ts:751` needs NO change.
- Recommendation: **Design B for NLQ/MCP** (small, idiomatic, testable with the p1661 pin pattern — stubbed capture store asserting provider/capability/run id/blob SHA). For the **trading agent, Design B PLUS orm threading** (resolveTradingPlatform must stop passing `undefined` orm) — that sub-change is where the behavior change lives and must be disclosed separately.

---

## 6. Standing-rule checks

- **#1686 comments (public API, 2026-10-26): 0 comments.** No lane claim, no owner activity, no competing design. Label `lane:cdo-mha7` already applied at filing.
- **Same-scope work on main since filing (2026-10-26T09:41:30Z): none.** `git log --since` on all L2 paths shows only: #1721 (scopedModes carriers), #1722 (NLQ_MODE switch — the route modes cited in §1), #1723 (scoped carriers), and #1661's own merge (`e2b070c0`). No commit mentions #1686. The #1737 Workflows decoupling commits (`5caa2e9e`, `f1c9f504`, `a93af221`, `9cc8b291`) touch `server.ts`/`orchestrator.ts` but **none of the L2 paths** (verified by stat grep). The #1721–#1723 carrier additions are adjacent, not colliding: they prove the additive-optional-field pattern is currently accepted on exactly the interfaces #1686 will touch (`McpToolContext`, NLQ route options), and a storage field alongside them is consistent.
- **Collision risk: LOW.** The only live contention is main churn generally (the #1661 ship already absorbed one ~90-file main move); the build should still run the gate-base vs branch-base freshness check, since `orchestrator.ts`, `screenerPipeline.ts`, and the NLQ route are high-traffic files.

---

## 7. Risks and open questions

### Session scoping — whose storage handle? (the main design question)

- The handle is **the executing DO agent's blob store, not a per-user store**. `agentCtx.storage` is the orchestrator DO's storage for route/chat/NLQ/MCP-turn legs, and would be the trading-agent DO's own storage for the trading-agent leg. Capture ROWS are user-scoped (the bundle's `runContext` carries `userLogin` + `runId` + `tenantId: "default"`, `screenerPipeline.ts:487–493`; the capture store records tenant/user scope per E1), but the BLOB bytes land in whichever DO executed the screen.
- Consequence: trading-agent captures would live in the trading agent's DO tables/blobs, NOT the orchestrator's — provider-health reads (E6, per-DO capture tables) and any future cross-surface capture queries would see them only against that DO. NLQ/MCP-turn legs execute in the orchestrator DO, so their captures land with the route legs. The build must decide (and the §15 must state) whether per-DO capture placement is acceptable, or whether trading-agent captures should be routed to a shared store. No code today routes captures across DOs; inventing that is out of #1686's plumbing scope.
- The storage handle type itself is minimal (`{ get, put }`, `screenerPipeline.ts:442`) — it carries no identity, so a wrong-handle bug would write captures under the wrong DO's store with the right userLogin in the row. Pins should assert the row's run/user AND that the blob went to the intended store (stubbed store identity), not just that a row exists.

### Behavior-change audit (what threading storage could change besides capture)

- **NLQ + MCP: none, except capture rows.** The fetch already happens today through the internal build; adding storage only swaps the bundle's recorder from `outcomeRecorder` to `capture` (`screenerPipeline.ts:478–483`) — same fetcher, same route resolution, same failure shapes. Capture-write failure degrades to the `capture_failed` marker and never throws (E1 contract: `recordCapture` never throws). Safe to ship as capture-only.
- **Trading agent: REAL behavior change.** Today: missing-seam error result. After orm+storage threading: live listings fetch + capture. Screens that errored start returning data. This must be disclosed in the PR body and §15 in the same class as #1661's scheduled-discovery disclosure, and the build needs a pin asserting the new success shape (not just capture presence). If the owner does not want trading-agent screens to start fetching, the alternative is to leave the trading-agent leg as an error result and narrow #1686's Outcome — that is a scope decision, not a build detail.
- **No ordering/approval surface is touched.** All three legs are read-only screens; no order placement, no HITL path, no token handling. The `userLogin` threaded is already the authenticated identity (#1185) at every site; no new identity is introduced.

### Open questions (need answers before / during build)

- **Q1 — Service-carried storage vs call-site seams?** Recommendation is Design B (§5), but it adds a 5th ctor param to `ETradeService` and a 6th to `ETradeTradingPlatform`. If the owner prefers zero service changes, Design A works with no signature changes at all. Either closes L2 for NLQ/MCP; the trading agent needs orm threading under both.
- **Q2 — NLQ `mcp` mode: cover or explicitly exclude?** `mcpChatNlq.ts:328–330` deliberately passes NO options in mcp mode. Threading storage there breaks the mode's stated contract (narrow, disclosed exception) or leaves mcp-mode screens outcome-only (incomplete Outcome). The build must pick one and say so in the PR.
- **Q3 — Trading-agent orm source?** `TradingAgent` has no `getOrm()` and never touches `this.ctx` today. The build must establish the Think-base accessor for the DO's SQL handle (orchestrator's `getOrm()` is an orchestrator-local helper, not evidently a Think-base method — verify against the Think base before assuming `this.ctx.storage.sql` works on `TradingAgent`). If no clean accessor exists, the trading-agent leg may need its platform constructed with an orm passed from the caller (route/DO instantiation site) instead — a larger change.
- **Q4 — Hosted-MCP direct entry: does one exist?** No context builder besides chat turns and the REST bridge was found. If a hosted MCP HTTP endpoint constructs `McpToolContext` somewhere not covered by this sweep (e.g. a mount in `server.ts` or a Workers MCP binding), its screens would stay outcome-only after this build. The build should grep the MCP mount path and either cover it or name it as a residual.
- **Q5 — Goal screens: in or out?** The screener-agent goal path builds a storage-carrying bundle for options discovery but defaults the listings stock leg to a no-seam screener (error result, not outcome-only). Absorbing "give goal screens a seamed listings screener" into #1686 is new behavior, not plumbing. Recommend: out of #1686, named in its §15 as a known non-outcome-only leg, filed separately only if the owner wants goal listings legs to fetch.
- **Q6 — Per-DO capture placement for the trading agent (see scoping above): acceptable, or must captures converge?** If convergence is required, that is a separate design (cross-DO capture routing) and #1686 should close with the trading-agent leg capturing into its own DO store, explicitly stated.
- **Q7 — Pin strategy for the trading-agent leg.** The #1661 pin pattern (stubbed capture store, per-leg executing pins) applies to NLQ/MCP directly. The trading-agent leg's tools run through Think tool dispatch; an executing pin needs the tool-ctx seam, not just the service method. The build should confirm a vitest-reachable seam for `stock_screening` execute (the service registry functions are plain functions taking `(env, config, ...)` — likely pinnable) rather than assuming it.

---

## Threading plan (dependency order)

1. **Types first (no behavior):** `McpToolContext.storage?` (`patterns/interfaces.ts:23`); `NLQExecutionDeps.storage?` (`nlq/types.ts:143`); `TradingServiceContext.storage?` + `orm?` (`trading-agent.ts:113`); `ChatTurnHelpersContext.storage?` (`chatTurnHelpers.ts:29`); `RestToolParts.storage?` (`restToolBridge.ts:26`) if included. All additive-optional; existing constructors compile unchanged.
2. **Services (Design B):** `ETradeService` ctor + `screenMarketsAsync` internal build (`services/etrade.ts:67,158`); `ETradeTradingPlatform` ctor + `screenMarkets` internal build (`trading/etrade/platform.ts:63,239`). If Design A is chosen instead, skip this step and build seams at the call sites.
3. **NLQ:** `executeNaturalLanguageQuery` options + guard + deps literal (`execution.ts:2270,2290–2291`) → AsyncCore call sites (:1475, :1924) → `nlqOptionsStrategy.ts:751` type widen ONLY under Design A → route options literal (`mcpChatNlq.ts:332`) + mcp-mode decision (Q2).
4. **MCP:** orchestrator `chatTurnHelpersContext()` supplies `this.ctx.storage` (`orchestrator.ts:286`) → `createTurnTools` forwards it (`chatTurnHelpers.ts:71`) → `etrade_market_scan` passes it through its service construction (`etradeCommands.ts:57–58`, Design B) or builds the seam (Design A). REST bridge forwarding (`restToolBridge.ts:42`) if included.
5. **Trading agent:** `TradingAgent.getTools()` supplies storage + orm accessor (:803–805) → `buildTradingTools` → `executeTradingService` ctx (:480–487) → `resolveTradingPlatform` stops passing `undefined` orm (:366) → `stock_screening` execute passes the seam or relies on the platform's internal build (:177–186). Disclose the error→fetch behavior change.
6. **Pins (TDD, following the p1661 pattern):** per-leg executing pins with a stubbed capture store asserting provider/capability/run id/blob SHA; Red on a pristine control (no storage threaded → no capture row), Green after. Include a trading-agent pin asserting the new success shape (not just capture presence) and a pin proving tools without storage still degrade to outcome-only (the `getUniverseDeps` contract, extended to the new fields).
7. **Gates:** full A/B exact-delta + tsc-identical + Gitleaks (fragment-assembled fixtures only) + merged-tree freshness check (high-traffic files) + CHANGELOG rebuilt on current main at push time. §15 must state: the trading-agent behavior change, the mcp-mode decision (Q2), the goal-screen disposition (Q5), the per-DO placement statement (Q6), and the hosted-MCP confirmation (Q4) — and must NOT claim "zero legs remain outcome-only" without those qualifications.

## Files touched (expected build surface, for the parent's fork-point watch)

`src/patterns/interfaces.ts`, `src/agents/nlq/types.ts`, `src/agents/nlq/execution.ts`, `src/agents/nlqOptionsStrategy.ts` (only under Design A), `src/agents/routes/mcpChatNlq.ts`, `src/mcp/etradeCommands.ts`, `src/agents/orchestrator/chatTurnHelpers.ts`, `src/agents/orchestrator.ts` (context builder only), `src/agents/routes/restToolBridge.ts` (optional), `src/services/etrade.ts` (Design B), `src/trading/etrade/platform.ts` (Design B), `src/agents/trading-agent.ts`, `src/trading/registry.ts` (only if storage rides `getPlatform`), `tests/data_provider_service_capture_p1686.test.ts` (new pin file), `CHANGELOG.md`.
