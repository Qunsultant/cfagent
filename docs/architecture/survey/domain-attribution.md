# Domain attribution — why 209 contexts and 587 resolvers for a few workflows

Repo surveyed: `Qunsultant/cfagent` main at `3e516f1c` (2026-11-25).
Read-only attribution. No code changed, no build, no PR, no issue, no GitHub write.
Inputs: `~/workspace/your_files/context-survey-rca-plan.md` (contexts) and
`~/workspace/your_files/resolvers-and-issues-survey.md` (resolvers), verified against the
fresh clone at `~/workspace/scratch-cfagent-main`. Two worker attributions (workflow/job axis
and layer/dimension axis) are reconciled here; their full tables live in
`/tmp/workflow-job-attribution.md` and `/tmp/layer-dimension-attribution.md`.

## 0. Counts up front

- **Contexts: 209.** **Resolvers: 587** — not 586. See the correction below.
- **The workflows the owner named hold almost nothing.** Stock + options + strategy + goal +
  OODA + opportunity hunt together hold **23 contexts and 106 resolvers** — 11% of contexts,
  18% of resolvers. The rest is shared infrastructure, platform plumbing, and duplication.
- **Top 3 by layer:** Config 149, Integration 110, Services 97 (combined contexts + resolvers).
- **Top 3 by workflow:** Shared / cross-workflow 138, Scheduling 107, Platform 88.
- **Top 3 job families:** Scheduled jobs 68 (18 contexts + 50 resolvers), generic Pipeline
  50 (11 + 39), Screener jobs 40 (13 + 27). The five pipeline stages (feed / enrich /
  analyze / generate / deliver) hold **53 resolvers and 1 context**; 147 contexts and
  345 resolvers are not job definitions at all.

### Correction: resolvers are 587, not 586

The resolver survey's headline says 586 = 557 standalone + 17 class methods + 9 Resolver
types + 3 interface declarations — but its own §4 list contains **18** class-method rows,
and every one was verified in the clone as a genuine class-method implementation
(`resolveRoute` in `src/trading/dataProviders/registry.ts:189` among them). There is no
principled row to drop, so the honest total is **587**. The workflow axis below was built
to the survey's 586 headline; reinstating `resolveRoute` adds +1 resolver to Market data
(25 → 26) and +1 to Non-job on the job axis (344 → 345). Both axes in this document use
587. The survey headline's "17" is a miscount; no new ruling is needed to use 587, but a
ruling would be needed to go back to 586.

## 1. Why so many? (the short answer, quantified)

The platform has few workflows, but the contexts and resolvers are **not per-workflow**.
They are per-route, per-extracted-module, per-surface-mode-family, per-domain-knob, and
per-job-stage — and each slice created its own local one instead of reusing an existing one.

Two sentences: **The 209 contexts are mostly not workflow concepts at all — 82 of them
(56 route contexts + 26 orchestrator DI ports, 39%) are dependency-injection bags, one per
handler file or extracted module, and 77 (37%) are config/env objects; the six named
workflows together own 23.** **The 587 resolvers are mostly per-surface copies of the same
few questions — 73 mode/switch resolvers across 25 `*Modes` files, 114 config/env/policy
knobs, 51 tenant/broker/provider resolvers, 34 generic helpers duplicated verbatim — because
no one owned "one resolver per question" and each surface resolved its own environment,
tenant, broker, and mode locally.**

The numbers behind that:

| What the count actually is | Count | Share |
|---|---:|---|
| Route contexts (one per handler file) + orchestrator DI ports | 82 | 39% of contexts |
| Config / env objects (Env, ResolvedEnvironment, EtapiConfig + 16, OTEL, flags, 25 `*Modes` families, 18 JSON files, wrangler) | 77 | 37% of contexts |
| Execution / identity contexts (Tier A, incl. `ScreenerExecutionContext` ×6) | 17 | 8% of contexts |
| Security contexts beyond `ExecutionContext` | 21 | 10% of contexts |
| MCP + services inputs/results + client (React 3 + data shapes 5) | 12 | 6% of contexts |
| Mode/switch resolvers (kind A) | 73 | 12% of resolvers |
| Config/env/policy/payment knob resolvers (kind C) | 114 | 19% of resolvers |
| Tenant/broker/provider/platform resolvers (kind B) | 51 | 9% of resolvers |
| Generic duplicated helpers (kind G: `resolveBool`, `resolveSwitch`, `resolveOne`, `resolveMinutesKnob`, …) | 34 | 6% of resolvers |
| Job/pipeline/chain/stage/schedule resolvers (kind E) + `*OrThrow` wrappers (kind H) | 55 | 9% of resolvers |
| Other domain-specific resolvers (kind J) | 176 | 30% of resolvers |
| User/account/identity, routing/DI, symbols/universe (kinds D, F, I) | 54 | 9% of resolvers |
| Class methods + Resolver types + interface declarations | 30 | 5% of resolvers |

What is genuinely workflow-specific vs shared vs duplicate (workflow axis):

- **Shared / cross-workflow: 71 contexts, 67 resolvers.** Identity, env/config, and plumbing
  used by every workflow — the validated `ExecutionContext` family, `ScreenerExecutionContext`
  + mirrors, `Env` / `ResolvedEnvironment` / feature flags, the generic mode-switch engine
  and knob helpers, DI/registry helpers. This is the single biggest bucket on the workflow
  axis, and it is the one with no owner.
- **Workflow-specific (all 17 other workflows combined): 138 contexts, 520 resolvers.** Of
  that, Scheduling (23 / 84) and Platform / identity / security / admin (17 / 71) are
  themselves platform plumbing, not user-facing workflows — together 40 contexts and
  155 resolvers. Payments (19 / 59) and Trading / broker (20 / 52) are the next two.
- **Duplicate (same question answered twice or more):** environment resolved in ≥4 places,
  tenant in ≥6, broker/provider selection in ~12 resolvers, `resolveSwitch<T>` defined in 5
  files, `resolveOne<T>` 5× in one file, `resolveBool` ×3, `resolveMinutesKnob` ×6,
  `resolveCaller` ×3, `resolveOperator` ×3. The resolver survey's §2 lists these; the
  layer worker confirmed the kind columns sum exactly to the survey's kind totals, so the
  duplication is in the count, not in the counting.

The RCA from the context survey, restated in one line: no one owned "context" or "resolver"
as a platform concept, so each slice solved its local problem locally — routes mirrored
instead of importing, surfaces copied the mode-switch engine instead of sharing it, and
identity/config were built twice and never unified.

## 2. Attribution tables

Classification rule (both axes, first match wins): one primary domain per definition, no
double-counting; anything serving several domains goes in Shared / cross-workflow (workflow
axis) or Shared / cross-layer (layer axis) and is counted once. File location is the primary
signal; subject overrides are stated where applied (e.g. payment-route modes → Commercial,
broker route files → Integration, kind-G generic helpers → Shared). Judgment calls are
flagged in §5.

### 2a. Per workflow

| Workflow | Contexts | Resolvers | Combined | What they do |
|---|---:|---:|---:|---|
| Shared / cross-workflow | 71 | 67 | 138 | Identity, env/config, plumbing used by every workflow |
| Scheduling | 23 | 84 | 107 | The one scheduler and schedule surfaces (#3121): schedule CRUD/list/row/source modes, cron entries, watchdog + heartbeat + retention, async-job plumbing, callbacks and approvals |
| Platform / identity / security / admin | 17 | 71 | 88 | IAAA tenants, memberships, identity bindings, PDP/permission/policy, audit, delegations, platform admin, service-user dispatch |
| Payments | 19 | 59 | 78 | Monetization, tiers, prices (`PriceCatalogue`), checkout, premium, refunds, subscriptions, metering, ads revenue, payment-assurance, x402 |
| Stock (screener) | 9 | 67 | 76 | Stock screening: screener execution, screen modes/gates, universe/symbol expansion, presets, watchlists, screen-provider selection, premium screener |
| Trading / broker | 20 | 52 | 72 | Broker selection and execution: E*TRADE/Alpaca/Tastytrade, broker connect/environment/orders/limits/risk, account bindings, run-broker context, trading agent |
| Copilot | 12 | 36 | 48 | Stock Copilot + chat/NLQ + biz copilot: copilot cycles, chat turns, NLQ ports/modes, copilot channels/voice, MCP chat shell |
| Observability / infra | 4 | 30 | 34 | OTel config/modes/alerting, SLO thresholds, DLQ, stuck-run/retention alerts, analytics lake |
| Market data / quotes / ticker | 5 | 26 | 31 | Market-data and quote modes, bars/snapshots, Yahoo/history, ticker push feed, public-data requests (+ `resolveRoute`, the reinstated 18th class method) |
| Social / delivery | 2 | 25 | 27 | Publishing and delivery channels: social posts, Slack/email/webhook recipients and verification, digest feed, channel gates |
| Strategy | 4 | 17 | 21 | Strategy discovery and choice: strategy engine/weights, strategy profiles, discovery fit gate, portfolio repair/risk, hedge proposals |
| Options | 6 | 12 | 18 | Options screening and stages: option chains, options stage control, options provider gate, options reports scope, IV collection |
| Knowledge / memory / search | 4 | 11 | 15 | Vector memory, knowledge corpus, AI search, web search, memory consolidation/read modes |
| Reports | 5 | 10 | 15 | Report generation and serving: report dispatch/HITL, canonical report seed/body, run-ledger filters, report links, PDF section config |
| Research | 4 | 10 | 14 | Research pipeline: research job config/rules, research publish, research venue/datasets/engine adapters, screener research route |
| Goal | 2 | 7 | 9 | Goal screens and goal chains: goal-chain modes, goal-leg host dispatch, goal schedule sections, goal screen timeouts |
| Opportunity hunt | 2 | 2 | 4 | The daily opportunity hunt: hunt route context, `opportunityScanner` config, scan-target/scan-clock resolvers |
| OODA | 0 | 1 | 1 | The OODA loop itself: exactly one explicitly-OODA resolver (`resolveResearchVenue`, #6178); the loop's machinery is counted under Research/Scheduling |
| **Total** | **209** | **587** | **796** | |

Small-bucket notes (verified in the clone, not guessed): OODA is 1 resolver / 0 contexts —
"ooda" appears in 89 files but only `resolveResearchVenue` is OODA-named; if the owner
rules OODA = the whole research loop, Research's 4 contexts / 10 resolvers move to OODA.
Opportunity hunt is 2 + 2 — it reuses the stock/options screen machinery rather than owning
resolvers. Goal is small (2 + 7) because goal work rides the screen pipeline; most goal
machinery is counted under Stock, Options, Scheduling, or Shared.

### 2b. Per job

Job families grounded in `config/job-catalogue.json` (38 jobs: 22 goal, 10 system, 1 options,
1 stocks, 1 strategy, 1 other, 1 queued, 1 trading; 12 agents) and the pipeline job files
(`src/services/*PipelineJobs.ts`: feed, enrich, analyze, generate, deliver, chain,
optionsChain, options, research, screener; plus `shardJobs.ts`).

| Job family | Contexts | Resolvers | What they do |
|---|---:|---:|---:|
| Feed | 0 | 16 | Pipeline stage 1: fetch the universe/quotes — feed job lookup, timeouts, cadence, universe hydration, feed snapshots, feed dispatch |
| Enrich | 1 | 11 | Pipeline stage 2: join fundamentals/technicals/sentiment onto feed rows — enrich job lookup, join modes, enrichment selection |
| Analyze | 0 | 7 | Pipeline stage 3: score/filter the enriched rows — analyze job lookup, thresholds, rule sets, screener handoff |
| Generate | 0 | 5 | Pipeline stage 4: build the report/artefact from analyzed rows — generate job lookup, list/owner knobs |
| Deliver | 0 | 14 | Pipeline stage 5: deliver results — deliver job lookup, channels, delivery gate, publisher/recipient verification, HTTP delivery mode |
| Pipeline (generic: chains, definitions, stages, engine) | 11 | 39 | The job engine itself: pipeline-chain lookup, job-definition catalogue/spec, stage config/timeouts/retry, workflow stages, run-now trigger, job pipeline control |
| Async jobs | 2 | 7 | The async-job queue: async-job identity/provenance/failure codes, max runtime, job-list envelope, DLQ route context |
| Scheduled jobs | 18 | 50 | Everything the scheduler fires: schedule modes/sections/sources, cron entries, watchdog/heartbeat/retention, schedule callbacks/approvals, token renewal, sweeps |
| Shard jobs | 2 | 3 | Sharded screen chains: shard-chain source/host dispatch, shard pacing, shard-job reconcile context |
| Report jobs | 5 | 10 | Report runs: canonical report body (+ backfill), report serving/links, run-ledger filters, screener PDF sections |
| Research jobs | 2 | 13 | Research runs: research job config/timeouts/retries, research rules/venue/datasets/engine adapters, premium/market-data research modes |
| Options jobs | 6 | 23 | Options pipeline runs: options stage/screen-job ids, strategy choice/engine, chain/flow symbols, underlyings, discovery fit gate, opportunity scan target/clock |
| Screener jobs | 13 | 27 | Stock screen runs: screen-provider selection, screener gates/modes, universe/listings, paid-screen submission, preset filters, watchlist symbols |
| Goal jobs | 2 | 8 | Goal runs: goal-chain compile mode, goal-leg host dispatch, goal schedule sections, goal stock/options leg symbols |
| Social pipeline jobs | 0 | 9 | Social-daily pipeline (`pipeline:social-daily`, feed → generate → deliver in one firing) and social publishing |
| Non-job / other | 147 | 345 | Not a job family: identity, config/env, payments, trading, platform admin, routes, mode switches with no job tie, generic helpers |
| **Total** | **209** | **587** | |

Two findings: the five pipeline stages are resolver-heavy and context-light — 53 resolvers
but only 1 context (`EnrichmentRouteContext`); stage state lives in the generic
`JobStepContext` / `RunContext`, not in per-stage contexts. Scheduled jobs dominate the job
axis (18 contexts, 50 resolvers), reflecting the #3121 one-scheduler program.

### 2c. Per layer / dimension

| Dimension | Contexts | Resolvers | Combined | What they do |
|---|---:|---:|---:|---|
| Config | 75 | 74 | 149 | Scoped mode switches and env/config knobs: environment, etapi, heartbeat, session, schema, research-job and schedule-surface config |
| Integration | 2 | 108 | 110 | Broker/provider/channel selection, E*TRADE/Alpaca/Tastytrade/Yahoo, Slack/email/webhook delivery, trading engines and market-data sourcing |
| Services | 4 | 93 | 97 | Generic services: account bindings, tenant identity, pipeline-job knobs, copilot/screener/report helpers, scheduling internals |
| APIs | 60 | 18 | 78 | Route-layer contexts: 56 route bags + 4 `ScreenerExecutionContext` mirrors; resolver-light (resolution lives in services/config/security) |
| Workflows engine | 2 | 63 | 65 | Job/pipeline/chain/stage/schedule lookup and dispatch: pipeline-job resolvers, `*OrThrow` wrappers, chain and stage resolution |
| Security | 21 | 41 | 62 | IAAA/PDP identity, `ExecutionContext` resolution, tenant/broker facts at the security boundary, grants, retention, quotas |
| Agents / orchestrator | 30 | 27 | 57 | Orchestrator and agent-surface: 26 DI ports contexts + 4 Tier A, async jobs, chat budgets, DID, capability manifest, agent config, screener-agent naming |
| Commercial / monetization | 2 | 44 | 46 | Payments, pricing, tiers, subscriptions, refunds, checkout, metering, ads, wallet identity |
| Shared / cross-layer | 3 | 38 | 41 | Generic duplicated helpers (kind G) + cross-cutting error/outcome/breaker resolvers |
| Observability | 0 | 27 | 27 | OTEL settings/config, SLO thresholds, alerting, message catalog, telemetry calibration |
| Data foundation | 0 | 26 | 26 | D1/ORM/run-registry/storage resolvers: audit/D1 policies, run context, retention, schema, registry adapters and interfaces |
| MCP | 2 | 14 | 16 | MCP tool-command mode/scope/principal resolution and job-list envelopes for MCP tools |
| UI | 8 | 8 | 16 | Client-side: 3 React contexts + 5 data shapes; polling config, route id, selected runs, tape symbols, screening-provider default |
| Chat / NLQ | 0 | 6 | 6 | NLQ/chat mode switches and NLQ options-strategy scope/profile resolution |
| **Total** | **209** | **587** | **796** | |

Verified absences behind the zeros: data foundation, Chat/NLQ, and Observability have **0
contexts** — data access is via ports/adapters, not contexts; NLQ carries identity as a plain
`userLogin` string plus the `NLQExecutionDeps` ports bundle; OTEL's objects live in
`src/config/otelModes.ts` and count under Config by file location.

### 2d. Reconciliation

- **Contexts, both axes: 209.** Workflow axis: Shared 71 + Scheduling 23 + Trading 20 +
  Payments 19 + Platform 17 + Copilot 12 + Stock 9 + Options 6 + Reports 5 + Market data 5
  + Strategy 4 + Research 4 + Knowledge 4 + Observability 4 + Goal 2 + Opportunity hunt 2
  + Social 2 + OODA 0 = 209. Layer axis: Config 75 + Integration 2 + Services 4 + APIs 60
  + Workflows 2 + Security 21 + Agents 30 + Commercial 2 + Shared 3 + Observability 0 +
  Data 0 + MCP 2 + UI 8 + Chat/NLQ 0 = 209.
- **Resolvers, both axes: 587** (after the §0 correction). Workflow axis sums to 587 with
  `resolveRoute` reinstated under Market data. Layer axis sums to 587 as classified
  (557 standalone + 18 class methods + 9 Resolver types + 3 interface declarations).
  The kind columns cross-check exactly against the survey's kind totals
  (A73 B51 C114 D28 E49 F4 G34 H6 I22 J176 = 557).
- **The two axes are independent slices of the same totals.** A definition sits in one
  workflow bucket and one layer bucket; the axes are not additive with each other. The
  "shared" buckets differ between axes (71 contexts / 67 resolvers by workflow vs 3 / 38
  by layer) because they answer different questions: the workflow shared bucket holds
  everything no single workflow owns, while the layer shared bucket holds only what no
  single layer owns.

## 3. Consolidation, domain by domain

Order: biggest duplication first where a reusable home already exists, then the identity
unification, then the big resolver clusters, then the thin layers. Each domain is **one
issue at a time, serial** — one issue, one PR, land it, then the next domain. In every
domain the first step is to name the existing thing to reuse; nothing new is created until
the reuse candidate is proven absent (and the survey proves it present in every domain
below except where flagged NO HOME).

| # | Domain | Size (ctx + res) | The ONE thing to reuse (already exists) | What consolidates into it |
|---|---|---:|---|---|
| 1 | **Config** | 149 | `environment.config.json` + `resolveEnvironmentConfig` → one typed `UniversalEnvContext`, resolved once per request (owner-decided 2026-11-25: JSON file as the context) | The 52 text vars, the 25 `*Modes` families' env/file layers, the per-domain knob resolvers that only read env/file; the OTEL 7-level cascade becomes the one cascade (run > session > user > runtime > env > file > builtin), recorded in ADD.md |
| 2 | **Generic helpers / Shared** | 41 (layer) / 138 (workflow shared) | One generic helper per question: one `resolveSwitch<T>`, one `resolveOne<T>`, one `resolveBool`, one `resolvePositiveInt`, one `resolveMinutesKnob`, one `resolveCaller`, one `resolveOperator` — pick the existing copy as canonical, delete the rest | The 34 kind-G helpers and the 5 copies of `resolveSwitch<T>` / 5 copies of `resolveOne<T>`; home issue is #3786 (census + standard + shrink-only pin, one resolver per question) |
| 3 | **Identity / Platform** | 88 (workflow) / 62 (security layer) | `ExecutionContext` (#1078) + `resolvePlatformContext` (#6151) as the one identity home | The 5 `ScreenerExecutionContext` mirrors + 2 inline shadows (import the canonical type); the `ScreenerExecutionContext` login store itself is a separate sequenced decision (migrate to `ExecutionContext` or record its sunset) — not smuggled into config work |
| 4 | **Integration (broker / provider)** | 110 | `resolveRunBrokerContext` (per-run resolved broker/mode) fed by the `tenantProviders.ts` family, as the one broker/provider selection home | The ~12 broker/provider selection resolvers (`resolveTenantBroker*`, `resolveTenantProviderContext`, `resolveChannelBroker`, `resolveBrokerSelection`, `resolveTradingPlatform`, …) and the ≥4 environment resolvers; program home is #3216 (slice #3460) |
| 5 | **Scheduling** | 107 | The one scheduler (#3121) — consolidation already in flight (one-schedule program, 10 of 19 landed) | Schedule modes/sections/sources, cron entries, watchdog/heartbeat/retention, callbacks/approvals — ride the existing program, do not start a parallel one |
| 6 | **APIs / route bags** | 78 | The composed pair (`ExecutionContext` + `UniversalEnvContext`) as the one handler shape, plus narrow seams | The 56 route contexts and 26 DI ports contexts, one slice at a time; each slice deletes the bag it replaces |
| 7 | **Services** | 97 | Per subject, the existing canonical: `ExecutionAccountContext` / `resolveExecutionAccountContext` (account bindings), `resolveIaaaTenant` (tenant, 157 mentions), `resolveAgentConfig` (agent config, the one registry-driven resolver) | The tenant copies (`resolveSubmissionTenant` / `resolveDeliveryTenant` near-identical pair, `resolveTickTenant`, `resolveEffectiveTenantId` / `resolveCurrentTenant`) and the per-service knob duplicates |
| 8 | **Workflows engine** | 65 | `JobStepContext` / `RunContext` (stage state) + one resolver per job question (the pipeline-job family in `*PipelineJobs.ts`) | The 6 `*OrThrow` wrappers (thin throw-on-missing wrappers over the same lookups — fold into the resolver), `resolveFeedDispatchJobId` (re-resolves the same id/alias mapping for dispatch), `resolveStrategyProfile` defined twice |
| 9 | **Commercial / monetization** | 46 | `PriceCatalogue` (the only commercial context) + one pricing resolver per family | The 3 refund-payment resolver factories and the per-route payment mode resolvers, converged onto the catalogue |
| 10 | **Observability** | 27 | The OTEL config port + the 7-level cascade (already the canonical statement of precedence) | The ~20 `OTEL_*` env vars and D1 overrides converged onto the one cascade; no context to consolidate (0 contexts) |
| 11 | **Data foundation** | 26 | The ports/adapters (D1/ORM/DO) — resolution already lives in adapters, not contexts | The 6 `resolveId` / `resolveSymbols` adapter implementations stay as the two implementations of one interface each; no context to consolidate (0 contexts) |
| 12 | **MCP / UI / Chat-NLQ / Market data / Social** | 16 / 16 / 6 / 31 / 27 | MCP: `McpToolContext` (the near-subset `OpenaimpMcpHandlerContext` folds into it). UI: the 3 React contexts stay (UI-local state, not platform context). Chat/NLQ: the 6 mode switches fold into the Config cascade. Market data / Social: fold into Integration's one provider/channel home | Small, last; mostly folding into domains 1, 2, and 4 rather than their own programs |

**Where a domain has NO reusable home today (gaps to file, not reasons to create a parallel):**

- **Tenant-override home.** The `runtime` level of the cascade is the tenant-override level
  in the OTEL pattern, but its home (D1 table? a DO? a per-tenant config file? the existing
  `TENANT_*_JSON` env vars formalized?) is undecided. The universal context ships
  platform-global first; tenant overrides are a sequenced follow-up.
- **Identity mapping.** No code converts `ScreenerExecutionContext` into `ExecutionContext`
  (or back). Until that mapping exists, identity unification cannot land — the mapping is
  the missing piece, not another context.
- **A shared helpers module.** There is no shared home for the generic helpers today — each
  file defines its own copy. The consolidation creates one (by promoting an existing copy),
  it does not invent a new abstraction.
- **A per-surface mode engine.** There is no shared `resolveSwitch<T>` today — 5 copies.
  Same treatment: promote one copy, delete the rest.

**Recommended first domain: Config (#1).** It is the biggest (149 combined), the owner has
already decided its carrier (JSON file as the context), it unblocks the deploy (the 64-var
Free cap — 0 text vars + 40 secrets = 40 < 64), and every later domain depends on the
universal context existing. The one thing to reuse there is `environment.config.json` +
`resolveEnvironmentConfig`, extended into the one `UniversalEnvContext`.

## 4. Caveats — what could not be verified

- **Resolver total 587 vs survey headline 586.** Both workers found the same discrepancy
  independently: the survey's §4 lists 18 class methods against its headline of 17. This
  document uses 587 (all 18 verified in the clone). If a ruling later excludes one, the
  Market-data resolver count drops by 1 and the total returns to 586; nothing else moves.
- **Contexts reconcile to 209 only with a reconstructed 3.** The context survey's §1.4
  table itemizes 20 definitions in the security/MCP scope against its §0 claim of 23. The
  layer worker fills the gap with three clone-verified candidates (`PlatformContextFacts`,
  `TenantProviderContext`, `EvaluateExecutionContextResult`); the workflow worker counts
  the 2 unitemized shapes in Shared, unnamed. If the survey's three are different names,
  the per-dimension split could move by at most 1 between Security and Integration. The
  2 unitemized Tier A companion shapes stay in Shared, unclassifiable, as the survey left
  them.
- **Config-77 composition is a stated assumption.** The context survey's §1.5 prose names
  more config objects than the 77 budget holds; only 7 misc `*Config` objects are separately
  counted in the workflow worker's composition. If a recount counts them separately, config
  exceeds 77 and the survey's 77 needs revisiting. The config workflow split is the softest
  number in this document.
- **Boundary items kept out of the 209:** `ResolvedRunContext`, `ExpandGraphContextOptions` /
  `ExpandGraphContextResult` / `GraphContextRow` are real `*Context*` interfaces the context
  survey excludes under its inputs/results rule. Counting any of them would push the context
  total past 209.
- **OODA / Research boundary is a judgment call.** Only the venue resolver is OODA-named;
  the research pipeline is Research. If the owner rules OODA = the whole research loop,
  move Research's 4 contexts + 10 resolvers into OODA.
- **Caller coverage / dead code was not verified** for any of the 557 standalone resolvers;
  the 134 non-exported resolvers may include dead or single-use local helpers. The
  DI-fallback boundary is ±4–6, as the resolver survey discloses.
