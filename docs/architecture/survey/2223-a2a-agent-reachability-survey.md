# SURVEY — #2223: make every Think agent reachable over A2A

Base: main `a71fca57c78d54996191b893ed4c212fc3dc1bbd` (the #2215 merge). Read-only survey; every claim carries file/line evidence from that tree. Read worktree: `~/workspace/wa2a/wt`.

## Headline findings

1. **`entry.binding` has exactly ONE consumer in `src/`: the A2A dispatcher** (`src/a2a/index.ts:59`). No planner code path reads `binding` — so binding-value edits cannot change planner behavior, but ADDING a catalog entry (e.g. "orchestrator") provably does (plannerPrompt gains a line, validateSteps accepts a new agent, an exact-list pin breaks). **Recommendation: an A2A-owned name→binding (+ instance-name) map; leave `OPERATION_CATALOG` untouched.** (§2)
2. **The bare-name = service-identity scheme holds for exactly one agent: trading.** For screener and report-asset the service-identity instance is named `"default"`; for scheduled and payments the live instance is `"default"`; for research it is `research:<login>`; for the orchestrator surfaces there is no name→identity mapping at all. Handlers alone cannot satisfy the issue's instance-naming requirement — resolution needs an instance-name component. (§1, §6.2)
3. **ScheduledAgent is the worst case**: a virgin `"scheduled"` instance seeds a pristine `DEFAULT_SCHEDULES` copy, so `listGoals` over bare-name dispatch would return plausible-looking WRONG state, not empty state. (§1)
4. **`payments.draft` does not exist on PaymentsAgent** — it is a MAS tool inside OrchestratorAgent. The payments card must be re-scoped to PaymentsAgent's real operations. (§1, §6.3)
5. **The name "report-asset" can never dispatch**: the dispatcher regex `/^\/a2a\/(\w+)$/` (`src/a2a/index.ts:55`) excludes hyphens. (§6.1)

## §0 The dispatcher contract (what a conforming agent must satisfy)

`src/a2a/index.ts` (`handleA2A`):

- GET: `/.well-known/agent-card.json` + `/.well-known/agent.json` return all cards (`agent-cards.ts:84`); GET `/a2a/<name>/agent-card.json` returns one card by `cardPath` equality. Public, no auth. (index.ts:20-27)
- POST `/a2a/<name>`: fail-closed bearer gate FIRST — `A2A_API_TOKEN` unset → 503 `-32001`; missing/wrong token → 401 `-32002`, timing-safe compare, before any agent resolution. (index.ts:40-53)
- Path must match `/^\/a2a\/(\w+)$/` — `\w` is `[A-Za-z0-9_]`; **hyphens do not match**. (index.ts:55)
- Name resolution: `catalogAgent(name)` → `OPERATION_CATALOG.find(e => e.agent === name)` (`src/orchestrate.ts:129-131`). No entry → 404 `Unknown agent: <name>`. (index.ts:56-57)
- `namespace = env[entry.binding]`; missing → 500 `Binding not configured: <binding>`. Stub = `namespace.get(namespace.idFromName(name))` — **the instance name IS the URL name**, always. (index.ts:59-64)
- Stub must expose `handleA2A` (function check) → else 500 `Agent does not expose handleA2A`. (index.ts:65-67)
- Body is parsed at the edge (a Request cannot cross the DO RPC boundary); `stub.handleA2A(body, url.origin)` must return `{ text?, data? }`; the wire result is `artifacts: [{ parts: [{kind:"text", text}, ({kind:"data", data})?] }]`, JSON-RPC `id` echoed from the request body. (index.ts:74-103)

Only `TradingAgent` implements `handleA2A` today (`src/agents/trading-agent.ts:1236`). A repo-wide grep for `handleA2A` in `src/` finds no other class implementation (remaining hits are the dispatcher, the server route at `src/server.ts:434-436`, a client doc string, and the OUTBOUND cfpay client `src/services/cfpayA2A.ts`, whose `handleA2AMessage` is a different, client-side surface — do not confuse the two).

Bindings that exist in `wrangler.jsonc`: `SEARCH_AGENT` (:48, class_name `SearchAgent` — the export alias of OrchestratorAgent), `OPTIONS_SCANNER_MCP` (:50), `PAYMENTS_AGENT` (:54), `SCHEDULED_AGENT` (:56), `SCREENER_AGENT` (:58), `RESEARCH_AGENT` (:60), `SESSION_STORE` (:62), `REPORT_ASSET_AGENT` (:64), `TRADING_AGENT` (:66), `ORCHESTRATOR_AGENT` (:71), `BROWSER_AGENT` (:74), `SLACK_AGENT` (:75). `TASKS_AGENT`, `MEMORY_AGENT`, `NLQ_AGENT` do not exist anywhere in the file.

Service identity (#1185): `getServiceUserLogin(env)` (`src/security/serviceIdentity.ts:45-48`) returns the configured `SERVICE_USER_LOGIN` or null (fail-closed, no fallback). `SHARED_ORCHESTRATOR_INSTANCE = "default_trader"` (:62) is an ADDRESS for the shared orchestrator instance, explicitly "never an identity" (:52-61).

---

## §1 Per agent

### 1.1 OrchestratorAgent — bindings `SEARCH_AGENT` + `ORCHESTRATOR_AGENT`; `src/agents/orchestrator.ts` (extends PortThink)

**(a) Instance naming.** Instances are per-login: `env.SEARCH_AGENT.idFromName(userLogin)` (`src/server.ts:341`, `:2733`, `:2824`, and many more), plus fixed addresses: `SHARED_ORCHESTRATOR_INSTANCE` `"default_trader"` (`src/server.ts:1453`, `:1623`, `:1999`), `PREMIUM_GATEWAY_INSTANCE` (:2863), `"system_webhook_receiver"` (:2877), `INBOUND_EMAIL_ORCHESTRATOR_INSTANCE` (:2929), `` `slack_${teamId}` `` (:3222). All state is instance-local SQLite (`this.ctx.storage.sql`): `mas_memory`, `mas_transactions`, `mas_reports`, audit events. `sessionKey()` is the DO id, not the name (`orchestrator.ts:1284-1286`).

The bare names `search` / `tasks` / `memory` / `nlq` / `qa` / `orchestrator` each resolve to a FRESH instance with empty, disjoint `mas_*` state. There is no name→service-identity mapping for this class — the #1185 bare-name pattern does NOT apply (trading invented it; the orchestrator predates it and uses per-login names + named fixed addresses). Consequences that must drive the design:

- `memory.remember` written via `/a2a/memory` is invisible to `/a2a/search`, to every user's chat instance, and to the shared instance — five surface names = five separate memories/ledgers.
- `payments.draft` (MAS) inserts its `mas_transactions` row into whichever named instance received the call — NOT into `"default_trader"`, the ledger of record that PaymentsAgent derives budget state from (§1.2). A draft created over A2A would be invisible to the budget guard.
- The coherent design is ONE A2A name (`orchestrator`) serving all five operations on ONE instance; keeping search/tasks/memory/nlq as separate dispatch names fragments state by construction. (Their cards can remain as discovery aliases only if resolution lands on the same instance — the current dispatcher cannot express that; the §2 map can.)

Which binding: existing A2A `search` resolution uses `SEARCH_AGENT` (the per-login namespace; `ORCHESTRATOR_AGENT` is the #1387 sub-agent-bootstrap root namespace). Keep `SEARCH_AGENT` for orchestrator surfaces.

**(b) Candidate operations** — all five card operations are real, but they are MAS tools / NLQ pipeline, not class methods (full detail in §3): `search.query` → MAS `searchKnowledge`; `payments.draft` → MAS `draftPayment`; `tasks.create` → MAS `createTaskDraft` (an UNPERSISTED draft — §3); `memory.remember` → MAS `rememberFact`; `nlq.execute` → `executeNLQQueryAsync`. Also real and available if the card wants them: `payments.confirm` → MAS `confirmDraft`, `memory.recall` → MAS `recallFacts`.

**(c) Reuse.** `createMAS` (`src/agents/mas.ts:26`) constructed exactly as the one production caller does (`src/agents/routes/searchHub.ts:110-122`): `{ env, sessionId, requestId: crypto.randomUUID(), sql: this.ctx.storage.sql, audit: (t, a, p) => this.audit(t, a, p) }`, then `tool.execute(args, { toolCallId, messages, context: {} })`. NLQ: `executeNLQQueryAsync` (`src/agents/nlq/execution.ts:2252`) with ports from `src/agents/orchestrator/nlqPorts.ts`.

**(d) Construction/RPC.** Adding a public `handleA2A` is unremarkable — the class already serves RPC stub calls (e.g. `seedGovernanceHalt` invoked from `src/server.ts:1452-1456`). Two obligations: (i) ensure the `mas_*` tables before MAS sql use — table creation runs through the class's ensure path (`ensureSharedTable(sql, "mas_memory")` at `orchestrator.ts:1061`; route contexts receive `ensureTables: () => this.ensureTables()` at :464/:493/:503/:517); (ii) choose `sessionId` deliberately — it scopes the MAS search cache (`aiSearchCacheKey(query, sessionId)`, mas.ts:34) and is stamped on draft rows; the instance's own key (`this.sessionKey()`) is the consistent choice.

### 1.2 PaymentsAgent — binding `PAYMENTS_AGENT`; `src/agents/payments-agent.ts` (extends PortThink)

**(a) Instance naming.** The live instance is `"default"`: both production callers resolve `env.PAYMENTS_AGENT.idFromName("default")` (`src/agents/scheduled-agent.ts:307`, `:1080`). Bare `"payments"` is a virgin instance — but this class is **instance-agnostic for all live operations**: budget state is derived per call from the ledger of record (`mas_transactions`, owned by the shared OrchestratorAgent instance) via `fetchLedgerBudgetState` / `listLedgerPayments` / `recordLedgerPayment` (`src/payments/ledger.ts`), whose stub is `SEARCH_AGENT` `idFromName(PAYMENTS_LEDGER_ORCHESTRATOR_INSTANCE)` = `"default_trader"` (ledger.ts:54, :195-207). The only instance-local storage is the RETIRED legacy blob (`payments` / `budgetGuard` keys), read solely by `migrateLegacyLedger` (payments-agent.ts:239-288). Naming risk: **LOW** — with trading, the only agent where a virgin instance serves real data. The #1185 pattern neither applies nor needs to.

**(b) Candidate operations** (real public methods): `payments.budget_check` → `budgetCheck` (:90-113; the operation ScheduledAgent actually consumes, scheduled-agent.ts:315, :1088; fail-closed by design — any error returns `{allowed:false}`); `payments.today_spent` → `todaySpent` (:78-81); `payments.list` → `listPayments` (:223-225). `payments.process` → `processPaidRequest` (:120-160) is real but has **no production caller today** (file header, :17-19) and moves money after facilitator verification — exposing it over A2A is a policy decision, not wiring (§6.7). **`payments.draft` is NOT a PaymentsAgent capability** (§6.3).

**(c) Reuse.** The methods are the dispatch targets; the ledger helpers in `src/payments/ledger.ts` are already the shared path. A `dispatchPaymentsA2A` mirroring `dispatchTradingA2A`'s shape wraps the methods directly — no existing dispatch module to reuse.

**(d) Construction/RPC.** RPC-only actor, no chat hooks, `portHooks` deliberately unset (header :52-60). A thin `handleA2A` is a plain method addition; nothing in construction affects it.

### 1.3 ScreenerAgent — binding `SCREENER_AGENT`; `src/agents/screener-agent.ts` (extends PortThink)

**(a) Instance naming.** Service identity → `"default"`; other users → `` `screener:${login}` `` (`src/agents/screenerAgentName.ts:15-21`); `resolveScreenerAgentName` (:29-38) fails closed when neither a login nor a service identity exists. State is instance-local (`ctx.storage` + SQLite: task ledger, run history, latest results — screener-agent.ts:17, :280). Bare `"screener"` is a virgin instance AND its identity resolution **fails closed**: `userLogin()` (:326-340) returns the recorded owner, else a `screener:`-prefixed name's login, else the service identity for `"default"` only — otherwise it THROWS `"ScreenerAgent has no owner identity recorded for this instance"`. So a naive `handleA2A` on `idFromName("screener")` cannot run a screen until an owner is recorded (`runScreen` records `req.userLogin` at :512). A conforming design must either resolve A2A to the `"default"` instance (when a service identity is configured) or have the dispatch function attribute the run to `getServiceUserLogin(env)` explicitly and fail closed when unconfigured. Runs executed on a virgin `"screener"` instance are invisible to both the service instance and users' instances.

**(b) Candidate operations:** `screener.run_screen` → `runScreen` (:496; request shape `ScreenerRunRequest` :97-111 — trigger/filters/sector/universe/maxItems/symbols/maxSymbols/optional userLogin); `screener.run_goal_screen` → `runGoalScreen` (:1035); `screener.latest` → `getLatest` (:1285); `screener.history` → `getHistory` (:1290); `screener.list_tasks` → `listScreenerTasks` (:445).

**(c) Reuse.** The stub-method surface IS the production dispatch (orchestrator.ts:567 resolves via `resolveScreenerAgentName` and calls methods); no separate dispatch helper exists — the per-agent dispatch function wraps these methods. `resolveScreenerAgentName` is the naming helper any resolution change should reuse.

**(d) Construction/RPC.** Plain async RPC methods with JSON-shaped inputs/outputs. Keep the byte-returning getters (`getLatestPdf`, `getPdfByKey`, `getCsvByKey`, … :1316+) OUT of the A2A operation set — `Uint8Array` does not fit the `{text, data}` JSON outcome.

### 1.4 ScheduledAgent — binding `SCHEDULED_AGENT`; `src/agents/scheduled-agent.ts` (extends PortThink)

**(a) Instance naming — the sharpest hazard in this survey.** The live instance is `"default"` ONLY (`src/server.ts:1010`, `:1534`; the cron path forwards there). ALL state is instance-local `ctx.storage`: goals under key `"goals"` — **seeded with `DEFAULT_SCHEDULES` on first read** (:216-218) — tick history (:230-237), synthesized schedules (:804-813). Bare `"scheduled"` resolves to a virgin instance that seeds a pristine default goal list: `listGoals` over bare-name dispatch returns the seed defaults (plausible-looking, but NOT the live goal set — user-added goals, enable/disable state, and tick history all live in `"default"`), and `addGoal` / `triggerGoal` would write and fire in the shadow instance while the real cron keeps firing `"default"`. For this agent, bare-name dispatch serves WRONG state, not empty state — the exact failure mode #2223 exists to eliminate. A conforming design MUST land A2A resolution on instance `"default"` (per-agent instance-name override in the resolution map, §2).

**(b) Candidate operations** (all real, all bound to the instance's state): `scheduled.list_goals` → `listGoals` (:708); `scheduled.tick_history` → `getTickHistory` (:713); `scheduled.add_goal` → `addGoal` (:725); `scheduled.remove_goal` → `removeGoal` (:772); `scheduled.set_goal_enabled` → `setGoalEnabled` (:782); `scheduled.trigger_goal` → `triggerGoal` (:1172).

**(c) Reuse.** These are the same methods the server routes call on the `"default"` stub (`src/server.ts:1020-1045`, goals GET/POST). No dispatch module exists. `onCron` (:252) is the governed firing path and is not an A2A candidate.

**(d) Construction/RPC.** Nothing about construction blocks a thin `handleA2A` — the blocker is purely instance naming (a).

### 1.5 ResearchAgent — binding `RESEARCH_AGENT`; `src/agents/research-agent.ts` (extends PortThink)

**(a) Instance naming.** Instances are `` `research:${login}` `` (`src/agents/orchestrator.ts:594`; `src/server.ts:1841`). State is instance-local: `research:latest` (:67), `research:history` (:70), research PDFs in instance storage. Bare `"research"` is a virgin instance: `getLatest` / `getHistory` honestly return null/empty, but `runResearch` / `runDiscovery` would store their results in the virgin instance — invisible to `research:<login>` readers (split-brain). Identity comes from the REQUEST, not the instance name: `ResearchRunRequest.userLogin` (:73-78), and `runDiscovery` defaults an absent login to the literal string `"default"` (:529) — a legacy default-login value, NOT the #1185 service identity. An A2A dispatch function should pass `getServiceUserLogin(env)` explicitly, or fail closed, rather than inherit the `"default"` fallback. Note this agent is ALSO the system's one agent-as-a-tool target: `runAgentTool(ResearchAgent, { input: { trigger, userLogin } })` (`src/agents/orchestrator/researchPublish.ts:208`) drives its Think turn (`getTools` :179); A2A would be a second door onto the same methods — no conflict, the methods are door-agnostic.

**(b) Candidate operations:** `research.run` → `runResearch` (:432); `research.discovery` → `runDiscovery` (:524); `research.latest` → `getLatest` (:628); `research.history` → `getHistory` (:866); `research.track_record` → `getTrackRecord` (:879); `research.evaluate` → `evaluateRun` (:912); `research.config` → `getResearchConfig` (:416).

**(c) Reuse.** `runResearch`/`runDiscovery` are the single execution path for the tool door, RPC callers, and the researchPublish fallback (which reads `agent.getLatest()`, researchPublish.ts:218). No separate dispatch helper needed.

**(d) Construction/RPC.** Explicit `constructor(ctx, env)` (:150) — standard DO construction; no RPC blocker. Byte-returning getters (`getResearchPdfByKey` :662, XLSX/CSV getters) stay out of the A2A set, as with screener.

### 1.6 ReportAssetAgent — binding `REPORT_ASSET_AGENT`; `src/agents/report-asset-agent.ts` (extends PortThink)

**(a) Instance naming.** Service identity → `"default"`; users → `` `assets:${login}` `` (`reportAssetAgentName` :115-121). BUT identity is carried in the REQUEST (`AssetRequest.userLogin` :37), never derived from the instance name, and asset bytes are stored via `reportBlobStore` — **R2 when bound**, DO-storage otherwise (`generateAsset` :71-92, `getAsset` :95-108, `putReportPdf` :86). In the production (R2) configuration a virgin instance under any name generates and fetches correctly; in the DO-storage fallback, `getAsset` misses assets stored by other instances. Naming risk: **LOW (R2) / MEDIUM (fallback)**. The real problem is the NAME itself: **"report-asset" contains a hyphen and the dispatcher regex cannot match it** (§6.1) — the A2A name must be `report_asset` / `reportasset`, or the regex widens.

**(b) Candidate operations:** `report_asset.generate` → `generateAsset` (:71-92; returns `{ key, fileName }` — clean JSON, the natural A2A operation); `report_asset.get` → `getAsset` (:95-108; returns raw `Uint8Array` bytes — a poor fit for the JSON `{text, data}` outcome; recommend generate-only, or a get that returns metadata/base64 by explicit design).

**(c) Reuse.** Caller-side helpers `generatePdfAsset` (:129), `generatePdfAssetWithBytes` (:163), `getPdfAsset` (:183) are the existing entry points; the dispatch function calls the class methods directly (the helpers resolve per-user instances, which A2A does not want).

**(d) Construction/RPC.** Two-method RPC surface; `generateAsset` never throws (returns null on failure, :89-92) — the dispatch function must translate null into an honest error result, never a success.

### 1.7 BrowserAgent — binding `BROWSER_AGENT`; `src/agents/browserAgent.ts` (extends PortThink)

**(a) Instance naming.** None in production: the class is constructed in-process with a borrowed ctx (`src/agents/routes/tradingIntegrations.ts:302`; `src/agents/slackAgent.ts:77`). It is STATELESS — every method delegates to `ETradeBrowserService` built from `env` only (:46-51); no `ctx.storage` use anywhere in the class. Bare `"browser"` works identically to any other instance. Naming risk: **NONE** — the easiest agent in the set, and the only one where the issue's bare-name assumption holds as written (besides trading/payments).

**(b) Candidate operations:** `browser.snap_transaction` → `sendTransactionSnapToSlack` (:63-75); `browser.capture_page` → `capturePageSnapshot` (:83-99); `browser.scrape_tables` → `scrapeTables` (:101-104). (`generateTransactionReceiptSvgBase64` :188 is synchronous and local — possible, low value.)

**(c) Reuse.** `onRequest` (:110-186) already routes exactly these three operations from HTTP bodies (`/snap/transaction`, `/snap/page`, `/scrape`) — the dispatch function mirrors its three branches onto the same methods; no new execution logic.

**(d) Construction/RPC.** Caution, not a blocker: the methods accept a caller-supplied `webhookUrl` — over A2A that lets any bearer-token holder make the agent POST snapshots to arbitrary webhooks. The design should decide whether A2A args may carry `webhookUrl` or it is pinned to env configuration (the `env.SLACK_WEBHOOK_URL` precedent in SlackAgent, §1.8).

### 1.8 SlackAgent — binding `SLACK_AGENT`; `src/agents/slackAgent.ts` (extends PortThink)

**(a) Instance naming.** The class has NEVER been instantiated in production: Slack ingress runs through `src/server.ts` routes onto OrchestratorAgent instances named `` `slack_${teamId}` `` (:3222, :3253, :3353), not this class. The class header still says "the class has no wrangler DO binding, so it is unreachable in production" (:13-16) — stale since #2215 added `SLACK_AGENT` (`wrangler.jsonc:75`) in this very base commit, but the substance stands: no caller resolves a `SLACK_AGENT` stub today, so A2A dispatch would be the class's first production instantiation, and its ORM boot on a virgin instance (`getOrm` :83-85, over `this.ctx.storage.sql`) is unexercised in production. Its two domain helpers are env/API-driven rather than state-driven, so naming risk is **LOW** for them. (No clash with `slack_<teamId>` orchestrator instances — different namespace.) One watch-item: `sessionKey()` falls back to the synthetic `"slack_agent_master"` (:59-61) — an identity shape #1185 would flag if it ever attributed spend; the two helper operations don't record `mas_*` state, so it does not bite here, but a dispatch design should not extend its reach.

**(b) Candidate operations:** `slack.send_pre_trade_approval` → `sendPreTradeApprovalTicket` (:102-110); `slack.dispatch_transaction_snap` → `dispatchTransactionSnap` (:116-128). The `onRequest` Slack ingress (slash commands / interactions / events, :136-259) is HTTP-form-shaped, carries its own signature gate (`gateSlackRequest`) and principal resolution, and is **not** honestly exposable as A2A operations — exclude it.

**(c) Reuse.** Both helpers delegate to the single `ETradeSlackTradingService` / `BrowserAgent` — the same service the worker routes use (#1262 Phase 2; header :6-11). No new execution logic.

**(d) Construction/RPC.** `dispatchTransactionSnap` constructs `BrowserAgent` in-process with `this.ctx` (:77-81) — inside a real DO instantiation that ctx is the instance's own, so it works unchanged over the binding.

### Instance-naming matrix (summary of §1a)

| A2A name | Binding | Bare name resolves to | Live instance(s) today | Verdict |
|---|---|---|---|---|
| trading | TRADING_AGENT | service-identity instance | `"trading"` = service identity | ✅ pattern holds (precedent) |
| payments | PAYMENTS_AGENT | virgin instance | `"default"` — but class is instance-agnostic (ledger lives on orchestrator `"default_trader"`) | ✅ works anyway |
| browser | BROWSER_AGENT | virgin instance | none (in-process only); stateless | ✅ works anyway |
| slack | SLACK_AGENT | virgin instance | none (never instantiated); helpers env-driven | ✅ works, first-ever DO instantiation |
| report-asset | REPORT_ASSET_AGENT | — (regex blocks the name) | `"default"` / `assets:<login>`; R2-backed | ⚠️ name must change; then ✅ (R2) |
| screener | SCREENER_AGENT | virgin instance, identity FAILS CLOSED | `"default"` (service) / `screener:<login>` | ⚠️ needs instance override or explicit service-identity attribution |
| research | RESEARCH_AGENT | virgin instance (split-brain writes) | `research:<login>` | ⚠️ reads honest, writes land in the wrong instance |
| scheduled | SCHEDULED_AGENT | virgin instance with SEEDED default goals | `"default"` only | ❌ bare name serves wrong state — override required |
| search/tasks/memory/nlq/orchestrator | SEARCH_AGENT | five separate virgin instances | per-login + `"default_trader"` etc. | ❌ fragmentation — serve all five ops from ONE name/instance |

---

## §2 Catalog design — who consumes `OPERATION_CATALOG`, and the recommendation

Consumers (exhaustive grep over `src/`):

| Consumer | Reads | Uses `binding`? |
|---|---|---|
| `src/a2a/index.ts:56,59` — A2A dispatcher | `catalogAgent(name)`, `entry.binding` | **YES — the only reader of `entry.binding` in `src/`** |
| `src/orchestrate.ts:150-158` — `plannerPrompt` | `agent`, `operations`, `blurb` (rendered into the LLM planning prompt) | no |
| `src/orchestrate.ts:186-187` — `validateSteps` | entry exists + `operations.includes(op)` | no |
| `src/orchestrate.ts:626-629` — `createJob` (the planner path around :626) | `OPERATION_CATALOG.find(e => e.operations.includes(req.operation))`, existence only; returns a descriptor, never dispatches | no |
| `src/agents/scheduled-agent.ts:754-755` | `operations.includes(goal.operation)` — goal acceptance | no |
| `src/server.ts:1029-1035` — GET `/api/schedule/operations` | flattens `agent`/`operations`/`blurb` for the goals UI dropdown | no |

Effects of the two candidate designs:

- **Repair bindings in place** (tasks→?, memory→?, nlq→?): changing ONLY `binding` values provably cannot change planner behavior — no planner consumer reads the field. But (i) the honest value for all three is `SEARCH_AGENT`, which under the dispatcher's `idFromName(name)` rule creates three more disjoint orchestrator instances (§1.1 fragmentation); (ii) the field would become an A2A-only fact living in a planner-owned structure whose own header calls it "the single source of truth for plannable operations" (orchestrate.ts:5-7); (iii) it does nothing for the six names that have no entry at all.
- **Add an "orchestrator" entry to the catalog**: CHANGES planner behavior three ways — `plannerPrompt` gains a line the model can propose from; `validateSteps` starts accepting `agent: "orchestrator"` steps; `/api/schedule/operations` gains entries — and it breaks a pin: `tests/goal_compiler.test.ts:313-324` asserts the EXACT ordered agent list `["search","payments","tasks","memory","nlq","qa","trading","scheduled","social","resource"]`. This directly violates the issue requirement that planner-facing semantics stay unchanged/pinned.

**Recommendation: an A2A-owned resolution map** (in `src/a2a/agent-cards.ts` or a sibling `src/a2a/resolution.ts`): `name → { binding, instanceName? }`. The dispatcher stops importing `catalogAgent` and resolves through the map; `OPERATION_CATALOG` is not touched, so every planner pin stays green by construction. The map is also the only design that can express the two things the catalog structurally cannot:

1. **Per-agent instance names** — `scheduled → instanceName "default"`; screener/research/report-asset → their service-identity instance names (or an explicit design decision to serve virgin instances, recorded per agent); the five orchestrator surfaces → ONE name/instance.
2. **Names with no planner meaning** — `orchestrator`, `screener`, `research`, `report_asset`, `browser`, `slack` (the catalog's `scheduled`/`social`/`resource` entries are ScheduledAgent goal markers, not dispatch targets).

Implementation note: the dispatcher's stub-resolution lines (index.ts:59-64) change from `idFromName(match[1])` to `idFromName(resolution.instanceName ?? match[1])` — small, contained, and observable in the entrypoint test idiom (fake namespaces record `idFromName` arguments, §4). The bearer gate, card serving, outcome shaping, and the `handleA2A` stub check are untouched. Trading's resolution (`trading → TRADING_AGENT`, instance `"trading"`) is preserved verbatim in the map.

---

## §3 Orchestrator surfaces — how the five operations actually execute today

None of the five is an OrchestratorAgent method, and the planner does not execute them: `src/orchestrate.ts` is compile-only by its own header ("Compile outputs only: nothing here executes, schedules, or delivers", :9-13). Execution lives in the MAS tool factory and the NLQ pipeline:

- **`search.query` → MAS `searchKnowledge`** (`src/agents/mas.ts:27-161`): merges local scheduled-run reports (`searchScheduledReports(sql, query, 5)` over the instance's `mas_reports`) with AI Search instance chunks fetched over HTTPS from `${env.AI_SEARCH_ENDPOINT}/search`, behind an in-isolate TTL cache keyed by query+sessionId; with `KNOWLEDGE_SERVING_ENABLED` on, chunks gain corpus provenance (#1169 S2). Note: this MAS path does NOT use `ETradeAISearchService` — that service backs the MCP `knowledge_search` command and the SearchHub `/search/agent` route; the chat prompt aliases the two names (`src/agents/chatPrompt.ts:81`, `src/agents/mcpAdapter.ts:86-87`).
- **`payments.draft` → MAS `draftPayment`** (`mas.ts:166-243`): builds a DID-attested draft (`createDidAttestation`), inserts a row into the instance's `mas_transactions` with status `awaiting_confirmation`, registers draft ownership for webhook routing (`registerDraftOwner`, #932). NO funds move. The execution half is `confirmDraft` (`mas.ts:265-344`): on approval it runs the gateway checkout/refund via `PaymentGatewayService` and marks the row completed/rejected.
- **`tasks.create` → MAS `createTaskDraft`** (`mas.ts:245-263`): returns an UNPERSISTED draft payload (`status: "draft"`, `requiresConfirmation: true`) — nothing is stored anywhere. `confirmDraft` for a task only computes a status payload and audits it (`mas.ts:373-389`); despite the audit notice's wording, it does NOT create a ScheduledAgent goal. Honest A2A semantics for `tasks.create` = "draft a task proposal", not the catalog blurb's "Create a tracked task" — card copy must not repeat the blurb's claim.
- **`memory.remember` → MAS `rememberFact`** (`mas.ts:346-363`): `INSERT INTO mas_memory ... ON CONFLICT(key) DO UPDATE` over the instance sql. The read half is `recallFacts` (`mas.ts:365-389`), on no card today.
- **`nlq.execute` → the NLQ pipeline, NOT a MAS tool**: `executeNLQQueryAsync` (`src/agents/nlq/execution.ts:2252`; sync `executeNLQQuery` :1096; `executeNaturalLanguageQuery` :2272), with dependency ports built by `src/agents/orchestrator/nlqPorts.ts` (scheduling/stock-screen/social-brief ports, :47/:69/:94). Production call sites inside orchestrator machinery: `src/agents/orchestrator/asyncJobs.ts:1027,1035` and `src/agents/chatErrorFallback.ts:58`.

**Construction pattern for an OrchestratorAgent `handleA2A`** (proven in production): the SearchHub MAS route — invoked from the orchestrator mount — builds `createMAS({ env, sessionId, requestId: crypto.randomUUID(), sql, audit })` and calls `mas.searchKnowledge.execute({ query }, { toolCallId: crypto.randomUUID(), messages: [{ role: "user", content: query }], context: {} })` (`src/agents/routes/searchHub.ts:110-122`; the second argument is required by the installed `ai` Tool type and ignored by the tools). Inside the class, `sql` is `this.ctx.storage.sql` and `audit` is `(type, agent, payload) => this.audit(type, agent, payload)` (orchestrator.ts:1320). `createMAS(` has exactly one production invocation (that route) plus tests — an A2A handler would be its second, using the identical shape. The dispatch function (§5 pattern) would extract `{operation, args}` (reuse `extractA2AOperation`, §5.4), switch over the five MAS/NLQ executors, and wrap results in the `{text, data}` outcome.

---

## §4 Test idiom

**Files pinning `dispatchTradingA2A` / TradingAgent A2A behavior:**

- `tests/trading_agent.test.ts` — the main pin file (17 references to `dispatchTradingA2A`):
  - `"TradingAgent surfaces stay in sync (#291 anti-drift)"` (:135-148): `AGENT_CARDS` trading entry exists; `OPERATION_CATALOG` trading entry exists with `binding === "TRADING_AGENT"`; `card.operations` EQUALS `catalog.operations` EQUALS the live service registry's `a2aOperation`s (`liveTradingServices(TRADING_AGENT_CONFIG_BASELINE)`). This is the conformance pin to replicate per agent (§5).
  - `"TradingAgent A2A door (#291)"` (:215+): `extractA2AOperation` over both body envelopes; dispatch success/unknown/empty-body outcomes.
  - `"TradingAgent A2A outcome + instance unification (#291 A1/A2)"` (:271+): `tradingA2AOutcome` / `a2aReplyFromOutcome` shapes; `tradingAgentName` bare-name unification; an edge-dispatcher test importing `handleA2A` from `../src/a2a/index` with a fake env + fake stub (:307-338).
  - `"TradingAgent stable error tokens + dispatch logging (#291 A3/A6)"` (:356+): classified failures carry stable tokens on the A2A surface.
- `tests/a2a_stable_error_tokens_1763.test.ts` — see below.
- `tests/a2a_entrypoint_auth_1763.test.ts` — see below.
- `tests/data_provider_service_capture_p1686.test.ts` — one `dispatchTradingA2A` reference (capture assertions through the A2A door).

**What `a2a_stable_error_tokens_1763` pins** (issue #1763, scan row F-60): the token SET is the nine `TradingErrorToken`s — `unknown_service`, `unknown_operation`, `missing_operation`, `service_disabled`, `provider_not_enabled`, `provider_not_registered`, `provider_unsupported`, `invalid_input`, `internal_error` — and for EACH, `tradingErrorCatalogCode(token)` must resolve to an EXISTING key of `AGENT_ERROR_CATALOG` (`src/aspects/errorCodes.ts`) whose entry's `code` equals itself. Behavior pins: a missing-operation dispatch returns `{ok:false, code:"missing_operation", errorToken:<catalog key>}`; an unknown operation returns `code:"unknown_operation"` likewise — failures carry BOTH the local token (`code`) and the catalog token (`errorToken`), never either/or; success results carry NO `errorToken`. Harness idiom: `vi.mock("agents")` with a stub `Agent` class so the real `trading-agent` module graph loads under node; fake config `{ enabledServices: ["stock_screening"] }`, fake env `{}`.

**How `a2a_entrypoint_auth_1763` fakes its stubs**: it mocks the module graph — `vi.mock("@cloudflare/ai-chat")` (stub `AIChatAgent`), `vi.mock("agents")` (`routeAgentRequest: async () => null`, stub `Agent`), `vi.mock("agents/mcp")` (stub `McpAgent`), `vi.mock("agents/x402")` (`withX402: cls => cls`) — then imports the REAL worker default export from `../src/server` and drives `worker.fetch(request, env)`. The fake env is a plain object: `TRADING_AGENT: { idFromName: (name) => ({ name }), get: () => stub }` where the stub's `handleA2A` pushes `[body, origin]` into a `calls` array and returns `{ text: "ok", data: { ok: true } }`. Assertions: token unset → 503 and `calls` empty (stub NEVER reached); missing/wrong token → 401, including for an unknown agent (auth precedes resolution disclosure); correct token → 200 with exactly one stub call; GET `/a2a/trading/agent-card.json` → 200 with NO token (discovery public). Extending this idiom to new names = add one fake namespace per binding name in `makeEnv` (and, if §2's instance override lands, assert the `idFromName` argument the namespace received).

**Neighbor suite**: `tests/slack_cfpay_a2a_delivery.test.ts` pins the OUTBOUND cfpay A2A delivery (`deliverScreenerToSlackA2A` via `src/services/cfpayA2A.ts`): missing `CFPAY_A2A_TOKEN` → honest error result; delivery/upload calls shaped correctly. It does not exercise inbound dispatch.

---

## §5 Trading conformance checklist (the template)

Everything that makes `trading` "done", in dependency order — replicate per agent:

1. **Card** — `AGENT_CARDS` entry (`src/a2a/agent-cards.ts:69-78`): `name`, `description`, `version: "1.0.0"`, `endpoint: "/a2a/<name>"`, `cardPath: "/a2a/<name>/agent-card.json"`, `capabilities[]`, `operations[]` — operations EXACTLY the served set, no more.
2. **Resolution** — a name→binding entry whose binding EXISTS in `wrangler.jsonc` (trading: catalog entry `orchestrate.ts:71-78`, `binding: "TRADING_AGENT"`; per §2 this moves to the A2A-owned map for new agents).
3. **Operation registry** — every advertised operation maps to a real execution service: `getTradingServiceByOperation` (`trading-agent.ts:412`) over the live service registry; dispatch never invents an operation.
4. **Body extraction** — `extractA2AOperation(body)` (:617-637): accepts the JSON-RPC `message/send` envelope (a `kind:"data"` part carrying `{operation, ...args}` — the cfpay convention) OR a bare `{operation, ...args}` object; neither → null → `missing_operation`.
5. **Dispatch function** — `dispatchTradingA2A(env, config, body, userLogin?, deps?)` (:656-715): standalone (unit-testable without a DO), **never throws**; unknown operation → `{ok:false, code:"unknown_operation"}`; execution errors classified (`classifyTradingError`) into stable tokens; every result carries a `correlationId`.
6. **Result shape** — `A2ADataResult` (:639-654): `{ ok, operation?, service?, code?, errorToken?, correlationId, result?, error? }`; failures carry BOTH the local stable token (`code`) and the `AGENT_ERROR_CATALOG` token (`errorToken`, #1763); successes carry neither.
7. **Outcome wrapper** — `tradingA2AOutcome(data)` (:724-737) → `{ text, data }` with a MANDATORY human-readable text part (success: `"<operation> completed (<service>)."`; failure: `"<operation> failed: <error>"`). Plus `a2aReplyFromOutcome` (:744-754) for in-process readers.
8. **Class handler** — `handleA2A(body, origin)` (:1236-1240): thin — resolves the instance's identity (`instanceUserLogin()`, :1042-1045), passes env/config/instance deps (`getOrm()`, `ctx.storage`), delegates to the dispatch function, wraps with the outcome function. `origin` accepted and reserved (unused in v1).
9. **Instance naming** — `tradingAgentName` / `tradingAgentUserLogin` (:1243-1262): bare name == URL name == the service identity's instance (#1185/#291 A2); all doors (tools/A2A/RPC) resolve through the same helper (`getTradingAgentStub` :1275-1280).
10. **Edge behavior** (already global, `src/a2a/index.ts`): bearer gate fail-closed before resolution; unknown name 404; missing binding 500; missing `handleA2A` 500; body parsed at the edge; wire result = text part + optional data part; request `id` echoed.
11. **Pins** — anti-drift (card == catalog == live registry operations), dispatch unit tests (success/unknown/missing), outcome-shape tests, entrypoint auth tests, stable-token tests (§4).

---

## §6 Contradictions (named plainly)

1. **"report-asset" can never dispatch.** The dispatcher's path regex is `/^\/a2a\/(\w+)$/` (`src/a2a/index.ts:55`); `\w` excludes `-`. `POST /a2a/report-asset` returns the route-level 404 before resolution. GET card serving uses `cardPath` string equality, so discovery would LOOK fine while POST is unreachable — the failure is invisible from the discovery surface. The issue names this agent "report-asset (ReportAssetAgent)"; either the A2A name is `report_asset`/`reportasset` or the regex widens to `([\w-]+)`. (No other in-scope name has this problem.)
2. **The issue's instance-naming requirement is unsatisfiable by handlers alone for 6 of 9 names.** Requirement: "the dispatcher resolves `idFromName(<name>)`; per-agent state behind the bare name must belong to the configured service identity." Reality (§1 matrix): only trading's bare name IS the service-identity instance. Screener/report-asset service instances are named `"default"`, scheduled/payments live instances are `"default"`, research instances are `research:<login>`, orchestrator instances are per-login/named-addresses. Satisfying the requirement needs resolution to carry an instance name (§2 map) — or the requirement silently degrades to "virgin instance state", which for ScheduledAgent means SEEDED FAKE-LOOKING state (its `listGoals` returns `DEFAULT_SCHEDULES` from an instance that has never seen the live goals).
3. **`payments.draft` does not exist on PaymentsAgent.** The operation the payments card (agent-cards.ts:41-49) and catalog (orchestrate.ts:37-42) advertise is executed as a MAS tool inside OrchestratorAgent (mas.ts:166). PaymentsAgent's real surface is `budgetCheck` / `processPaidRequest` / `todaySpent` / `listPayments`. A conforming PaymentsAgent `handleA2A` cannot serve `payments.draft` without inventing a draft capability on the wrong class; the payments card must be re-scoped to the real operations (and `payments.draft` belongs to the orchestrator card only).
4. **tasks / memory / nlq are not agents, and treating them as dispatch names fragments state.** There are no classes or bindings behind those names; the operations are OrchestratorAgent surfaces whose state is that instance's `mas_*` SQLite. Five names on the `SEARCH_AGENT` namespace = five disjoint memories, ledgers, and report stores (§1.1). The issue's own scope line groups them under "orchestrator (incl. its search/tasks/memory/nlq/qa surfaces)" — the survey confirms that is the only coherent reading, and it implies ONE orchestrator instance serves them all.
5. **qa has no on-demand executor and no card.** The catalog's qa entry (`qa.supervised_fix`, `qa.run_sweep` → `SEARCH_AGENT`, orchestrate.ts:59-70) exists for `createJob` validation (descriptor-only, per its own comment) and goal acceptance: `qa.run_sweep` is a `DEFAULT_SCHEDULES` operation (`src/schedule.ts:52`) fired through ScheduledAgent; `qa.supervised_fix` is triggered by the self-healing loop filing a GitHub issue and creating a supervise job (`src/qa/self-healing.ts:56,93`) — neither is an OrchestratorAgent method an A2A handler can invoke with `(body, origin)`. The orchestrator card's operations omit qa (agent-cards.ts:29). Do NOT advertise qa operations on any card until an executor exists; the issue scope's "incl. qa surfaces" cannot be satisfied as written today.
6. **SlackAgent's own header contradicts wrangler at this base.** `slackAgent.ts:13-16` says the class "has no wrangler DO binding"; `wrangler.jsonc:75` binds `SLACK_AGENT` (added by #2215, this base commit). Comment-only staleness, but the underlying fact matters for sequencing: the class has never run as a Durable Object in production, so its first instantiation (via A2A) exercises unproven boot/ORM paths.
7. **`payments.process` would get its first production caller from A2A.** The PaymentsAgent header records that the #785 audit found `processPaidRequest` had no production caller (payments-agent.ts:17-19). It verifies a payment proof with the x402 facilitator and records spend. Wiring it to a bearer-token endpoint is a money-movement policy decision the issue does not mention; the low-risk conforming PaymentsAgent set is `budget_check` / `today_spent` / `list`.
8. **Minor — the "search" binding's class is an alias.** `SEARCH_AGENT` binds class_name `SearchAgent` (wrangler.jsonc:48), which is the export alias of OrchestratorAgent (`src/server.ts:216`); `ORCHESTRATOR_AGENT` (:71) binds the same class under its own name for sub-agent bootstrap (#1387). Resolution for orchestrator surfaces should use `SEARCH_AGENT` (the live per-login namespace, and what A2A `search` already resolves to) — naming the class "OrchestratorAgent" in issue text is correct, but implementers should not switch the binding to `ORCHESTRATOR_AGENT` thinking it is "the real one": instance state lives under the SEARCH_AGENT namespace's names.

Out-of-scope check: `src/agents/socialAgent.ts` (SocialMediaAgent) is a module of functions over a store, not a DO/Think class — correctly absent from the issue's agent list. `OptionsScannerMCP` remains excluded per the issue (MCP is its protocol).
