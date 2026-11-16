**Per-operation survey (owner request, 2026-11-11): what each catalog operation does, how it is used today, and its workflow-migration readiness. Verified on main. #CAIO-quns**

Correction to my earlier count on this issue: the catalog is **12 entries / 20 operations** (not 13/19).

**A — OrchestratorAgent A2A operations (run through the MAS tool factory, inline; no goal uses them)**
- `search.query` — web/data search, executed as the search tool command. *Ready trivially* — already a single tool invocation, the doctrine's unit; migration is a formality.
- `payments.draft` — drafts a payment request; executes nothing (the family continues at `payments.confirm`, also on the card). *Ready* — a single step; the surrounding money path already has workflow form.
- `tasks.create` — creates a tracked task. Today it returns an **unpersisted draft** (the dispatch header's own honesty note: nothing is tracked until a human confirms). *Nothing durable to migrate yet.*
- `memory.remember` — stores an outcome in vector memory (VectorMemory write). *Ready trivially* — single tool invocation.

**B — TradingAgent operations (agent-as-tool / A2A on TradingAgent)**
- `trading.screen_stocks` / `trading.screen_options` — run screens. In their main paths these already execute as **ScreenerScreenWorkflow** runs (mesh/chat doors). *Already workflow-backed.*
- `trading.trade_stock` / `trading.trade_options` — place trades via the trade-approval door, i.e. **TradingTradeWorkflow** with its approval wait. *Already workflow-backed.*

**C — Goal operations with dedicated executors inside ScheduledAgent (no job, no workflow)**
- `social.publish` — publishes the daily social post via the social goal executor (`src/agents/social/goalExecutor.ts`); baseline disabled. *Ready* — one deterministic action.
- `pipeline:social-daily` — the social pipeline; runs inline through the pipeline executor in the tick. *Already pipeline-shaped.*
- `resource.rollup_daily` / `resource.cap_alert` / `resource.dashboard_comparison` — SessionStore metering: nightly rollup, hourly 70%-cap alert, dashboard comparison; handlers in ScheduledAgent / `resourceGoals.ts`. *Ready* — single deterministic jobs.
- `index.refresh_wikipedia` — weekly refresh of index constituent lists into D1 via `indexListJob`. *Ready* — a natural fetch→store mini-chain.
- `index.refresh_holdings` — ETF holdings refresh via the same job service; baseline disabled and **no holdings fetcher is bound**. *Blocked on the fetcher existing*, not on workflow shape.
- `feed.refresh_all` — hourly refresh of all feed jobs; a dedicated onCron branch dispatching the pipeline's feed jobs. The work already runs on the stage-runner plane; the goal is only its trigger. *Already aligned.*

**D — Chain**
- `chain.execute` — executes a compiled goal chain. A ScheduledAgent-owned marker handled in onCron's own branch; the chain executor runs legs inline reusing the async-job rails' shard handler, serve legs submit report jobs, deliver legs report unimplemented until the serve completion hook runs. *The strongest real candidate*: a CompiledChain is already registry-stage-shaped, so the stage runner is its doctrinal home — but the executor's inline/rails hybrid semantics (deliver-leg deferral) must be preserved or deliberately changed.

**E — Turn machinery, not a job family**
- `nlq.execute` — executes a natural-language query (chat/REST NLQ path, async-job payload via `nlqPorts`). Not a migration candidate as an operation; its stock-screen leg already starts ScreenerScreenWorkflow runs.

**F — No executor / dormant (the survey's hard findings)**
- `qa.run_sweep` — the scheduled QA sweep (the `daily-qa-sweep` baseline). **No executor exists.** The catalog's own comment (#1655) states registration was the complete fix and "no sweep implementation is claimed": the goal fires, passes the budget check, mints a descriptor, records a successful run — and nothing sweeps. The live QA loop is elsewhere (qa-smoke files issues; `POST /api/qa/investigate` diagnoses; humans fix). *Nothing to migrate — an implementation gap wearing a green run record.*
- `qa.supervised_fix` — investigate a failure and propose a supervised fix. Lives only in deprecated `src/qa/self-healing.ts`: no production caller, and it calls an `OrchestratorAgent.createJob` method that does not exist. *Dormant.*
- (Outside the catalog) `search.opportunity_hunt` — the `opportunity-hunt` baseline's operation is **not in the catalog at all** (it appears only in PaymentsAgent's budget guard allowlist and in `DEFAULT_SCHEDULES`). Combined with the isDue finding on this issue, that baseline is doubly dead: it can never become due, and if it did, `createJob` would throw "Unknown operation" — the exact failure #1655 fixed for `qa.run_sweep`.

**Summary for the document:** already workflow-backed — the four trading operations; already aligned in kind — `pipeline:social-daily`, `feed.refresh_all`; ready as ordinary stages — `social.publish`, the three `resource.*`, `index.refresh_wikipedia`, and trivially the four A2A tool operations; strongest structural candidate — `chain.execute`; not candidates — `nlq.execute` (turn machinery), `tasks.create` (unpersisted draft), `index.refresh_holdings` (no fetcher); nothing to migrate — `qa.run_sweep`, `qa.supervised_fix` (no live executor).
