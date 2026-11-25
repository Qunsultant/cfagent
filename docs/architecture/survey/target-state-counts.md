# Target state counts — after the unification program

Repo surveyed: `Qunsultant/cfagent` main at `3e516f1c` (2026-11-25), from a fresh depth-1 clone.
Read-only derivation. No code was changed, no build run, no PR, no issue, no GitHub write.
Design decided by the owner (2026-11-25): **"let's use json file as a context"** — the config-file route.
The JSON file (`environment.config.json`, extended) IS the context carrier: resolved once per request
into one typed `UniversalEnvContext`. NOT the JSON-var packing (no single JSON text var + hydration).
This settles fork decision 1 in the context survey's §3.5 in favour of the file route.

Inputs: `context-survey-rca-plan.md` (209 contexts, RCA, fix plan) and
`resolvers-and-issues-survey.md` (586 resolver definitions). Both documents' §0 counting rules
are carried over here so the target numbers are re-derivable against them.

## 0. Counts up front

| | Today | After the program | Change |
|---|---|---|---|
| **App-created context types** | 209 | **4–7 (base case 4)** | 203–206 retire; 1 new (`UniversalEnvContext`) |
| **Platform-provided context types** (counted separately, cannot retire) | 3 types, 5 receipt sites | **3 types, 5 receipt sites** | 0 |
| **Named resolver definitions** | 586 | **87–127 (central estimate 106)** | ≈480 retire or fold |
| **Distinct resolution questions** (the lossless check) | ≈306 | **≈306 — all must have a named home** | 0 questions dropped |

The platform concept in the end state:

- **ONE universal env context** — `UniversalEnvContext`, resolved once per request from the
  extended JSON file (+ request overrides: tenant, user, overrideEnv), carrying the dimensions
  **platform / tenant / user (principal) / environment-mode / broker-provider / request-operation /
  channels**.
- **ONE validated execution context** — `ExecutionContext` (#1078), the identity context
  (who, which tenant, which mode, PDP-validated). Composed with the universal context at the
  boundaries (API #6172, MCP #6173, DO route shell) via `resolvePlatformContext`, so one call
  yields identity + config together.
- **ONE universal resolver** — `resolveUniversalContext` (the extended `resolveEnvironmentConfig`),
  answering the config question once. Most of today's resolvers become *fields* of the universal
  context, answered inside that one resolver.
- **ONE cascade** — run > session > user > runtime > env > file > built-in safe default
  (the OTEL 7-level statement, adopted for all config). The `runtime` level is the tenant-override
  level; its home is still an open owner decision.

Base-case context 4: `ExecutionContext` (1) + raw `Env` (1) + `UniversalEnvContext` (1, new) +
`ToastContext` (1, retained client UI state). The range to 7 is +1 legacy `ScreenerExecutionContext`
(identity decision), +1 `ChainContext`, +1 `PageChromeContext` (client retention decisions).
Platform/server contexts alone end at **3 (range 3–4)**.

**Single biggest retirement:** the config question itself. 73 mode switches + ~102 config knobs +
the broker-environment family + OTel settings + etapi config — roughly 180 of today's 586
resolver definitions — collapse into *fields* of the one universal resolver. On the context side,
the biggest retirement is the 83 dependency bags (26 orchestrator ports + 56 route shapes + 1 alias),
which retire into the seam map in §1.2.

**No-home items:** there is no single one — there are six named items that need a body read or an
owner decision before they can be given a home (listed in §3). None is yet confirmed as a defect;
none is silently dropped.

## 1. Target context count — derivation from the 209

### 1.1 Counting rule for the end state

Same rule as the context survey §0, applied to the end state: a "context" is a named app-defined
type/interface whose name contains `Context`, plus the raw `Env` shape and the one
`UniversalEnvContext`, plus client React contexts. Consequences, stated so the number is
re-derivable:

- **Nested section types inside `UniversalEnvContext` are not separate contexts** (e.g. its
  `etapi`, `otel`, per-domain mode sections). The survey counted `EtapiConfig`'s 16 sub-interfaces
  separately in the 77; in the end state they are sections of the one type. Without this rule the
  count explodes again by construction.
- **Resolver Input/Deps/Outcome/Result types renamed without "Context" in the name are not
  counted** (e.g. `ResolvePlatformContextInput` → plain `ResolvePlatformInput`). Their capabilities
  persist as resolver API — a renaming effect, not a deletion, and the main reason the security
  category goes to 0. If the owner counts resolver I/O as contexts, add those back (see §5).
- **Ports are seams, not contexts, and are not counted**: `FeatureFlagPort`,
  `PriceCatalogue`/`PriceEntry`, `OtelConfigPort` remain as data-access seams. **Config JSON files
  are data, not context types, and are not counted.** **Deps objects are not contexts**
  (`RouteRequestDeps` remains as the dispatch Deps).
- The ~180 scope-carrier/`Resolved*` interfaces in `src/config/` were already excluded from the
  209; they collapse into `UniversalEnvContext` sections too — additional reduction beyond the
  headline, not in the arithmetic.

### 1.2 Bridge table (209 → 4–7)

| Category | Start | Remain | Retire | New | Where the retired capabilities go |
|---|---|---|---|---|---|
| Tier A execution/identity | 17 | 1–2 | 15–16 | 0 | `ExecutionContext` stays; everything else folds into it + `UniversalEnvContext` + explicit run params |
| Orchestrator DI ports | 26 | 0 | 26 | 0 | Universal / Execution / explicit seams (seam map below) |
| Route contexts | 56 shapes (+1 alias) | 0 | 56 (+alias dies with its target) | 0 | Same seam map |
| Security beyond `ExecutionContext` | 21 | 0 | 21 | 0 | Execution / Universal / renamed resolver I/O |
| MCP | 2 | 0 | 2 | 0 | Composed pair (Execution + Universal) + explicit seams |
| Services inputs/results | 2 | 0 | 2 | 0 | `UniversalEnvContext.broker` (+ explicit resolver params) |
| Config / env objects | 77 | 2 (`Env` + `UniversalEnvContext`) | 76 | 1 (`UniversalEnvContext`) | Universal sections / files-as-data / ports-as-seams |
| Client React contexts | 3 | 1–3 | 0–2 | 0 | Props (retired ones); retained ones stay as UI state |
| Client data shapes | 5 | 0 | 5 | 0 | Renamed plain prop/state types; client projection of the composed pair |
| **Total app-created** | **209** | **4–7** | **203–206** | **1** | |
| Platform-provided | 3 types, 5 sites | 3 types, 5 sites | 0 | 0 | Cannot retire — counted separately (§1.8) |
| Test-only | 0 | 0 | 0 | 0 | — |

Check: 209 − 206 + 1 = 4; 209 − 203 + 1 = 7. ✓

### 1.3 Seam map for the DI bags (ports + routes) — every seam named

A bag retires only because each seam it carries has a named home. This map applies to all 26
ports and all 56 route shapes; per-bag extras are in §1.4.

| Seam carried by the bags | Home in the end state |
|---|---|
| `env: Env` / `Partial<Env>` / `unknown` | `UniversalEnvContext` (resolved); raw `Env` still passed at the Worker/DO boundary only, never threaded through handlers |
| `agentCtx: AgentContext` | Platform-provided Agents-SDK `AgentContext`, passed separately — not an app context, not counted |
| `audit(...)` / `recordAudit` | Explicit `audit` function parameter (audit is an operation, not config) |
| `getOrm()` / `ensureTables()` / `sql` / `storage` / `getStorageSql()` | Explicit data seam parameter (a Deps object, not a `*Context`) |
| `readSettingRaw(key)` | Gone as a live lookup — settings are resolved into `UniversalEnvContext` at resolution time via the one cascade; handlers read Universal fields |
| `writeSetting?` / `notifySettingsChanged?` | Explicit settings-write seam parameter |
| `getScreenerExecutionContext()` | `ExecutionContext` itself (resolved once, passed in); the accessor dies |
| `scoped*Modes?` carriers | `UniversalEnvContext.<domain>` sections (one cascade) |
| `sessionKey` / `sessionId` | `ExecutionContext.sessionId` |
| `traceId?` / `traceparent?` | `ExecutionContext.traceId` / `correlationId` |
| `userLogin` / `turnUserLogin?` (plain string fields) | `ExecutionContext.principalId`, via the existing login→internal-id resolution |
| `tenantId` (plain string fields) | `ExecutionContext.tenantId` |
| `schedule` / `listSchedules` / `cancelSchedule` / `scheduleEvery` | Explicit scheduler seam parameter |
| `submitAsyncJob` / `getAsyncJob` / `listAsyncJobs` / `routeRequest` | Explicit job seam parameters |
| `commercial?` / payment / checkout seams | Explicit commercial/payment ports (incl. retained `PriceCatalogue` seam) |
| `*Store?` / `*Port?` test seams | Explicit parameters on the handler (Deps, not Context) |
| `getScreenerAgent` / `getResearchAgent` / `runAgentTool` | Explicit agent-access seam parameters |
| `serviceMembershipStore?` / `membershipStore?` / `aliasKv?` | Explicit membership seam parameter (the `ExecutionContextAuthority` capability, renamed) |
| `waitUntilStable` / `waitUntil` re-exposures | Platform `ExecutionContext.waitUntil` / `AgentContext.waitUntil`, passed through, not wrapped |

### 1.4 Lossless mapping — Tier A, ports, routes

**Tier A (17 → 1–2)**

| Definition(s) | Fate | Home |
|---|---|---|
| `ScreenerExecutionContext` canonical (`scheduleMaintenance.ts:35`) | Retire in base case; **retain 0–1 pending the identity decision** | `userLogin` → `ExecutionContext.principalId` (login→id resolution, already exists); `environment` TEST/PROD → `UniversalEnvContext.environment` under the one mode vocabulary |
| `ScreenerExecutionContext` mirrors ×5 (`orchestrator.ts:285`, `screenerResearch.ts:90`, `schedules.ts:252`, `copilotChannels.ts:131`, `stockCopilot.ts:124`) | Retire (5) | Same as canonical — import the canonical type until identity unification deletes it; the mirrors carry no capability the canonical lacks |
| Inline shadows, uncounted (`reports.ts:135`, `workspace.ts:23`, `thinkAdapter.ts:735`) | Retire/fix | Canonical type; the loosened optional-`userLogin` shape is drift with **no home — owner decision** (restore required `userLogin` or record why optional; see §3) |
| `ExecutionContext` (`executionContext.ts:106`) | **Remains (1)** | Itself — the one validated execution context |
| `ExecutionAccountContext` (`accountBindings.ts:508`) | Retire | `UniversalEnvContext.broker` — resolved (broker, mode, accountId, source) section; validation stays in its resolver, now a step of the Universal resolver |
| `RunBrokerContext` (`runBrokerContext.ts:57`) | Retire | Same `UniversalEnvContext.broker` section (the same (broker, mode, account) axis in a second vocabulary — the duplication is the point) |
| `ChainExecutionContext` (`chainExecutor.ts:104`) | Retire as a type | `userLogin`→Execution; `environment`/`mode`→Universal; `chainId`/`universe`/`trigger`/`channels`→ explicit chain-run input params (a plain input type, not a Context) |
| `ShardChainContext` (`types.ts:3119`) | Retire as a type | Same split; its carrying of both `environment` AND `mode` ends with the one mode vocabulary; shard addressing stays a plain job payload |
| `JobStepContext` (`jobPipelineSteps.ts:25`) | Retire as a `*Context` type | Identity→Execution; config→Universal; `jobId`/`runId`/`stepIndex`/`item`/`params`→ explicit step-handler params (engine-internal, renamed non-Context state) |
| `RunContext` (`jobPipelineEngine.ts:562`, engine-internal) | Retire as a `*Context` type | Internal engine run state (deps/ledger/checkpoints/memory) — persists as engine state under a non-Context name, in the same file |
| `PipelineStageContext` (`pipeline.ts:53`) | Retire | Stages take (Execution, Universal, stage input); mutable `brief` stays an explicit stage-state/`PipelineRunRecord` field |
| `TradingServiceContext` (`trading-agent.ts:182`) | Retire | `env`→Universal; `config`→Universal.trading; `userLogin`→Execution; `orm`/`storage`/`resolvePlatform`→ explicit seams |
| 2 unitemized companion shapes | **Cannot be mapped — survey gap** | No home can be named; they are unnamed in the survey. **No home — defect in the derivation, not the code.** If either is a distinct retained identity type, add +1 each to the headline (see §5) |

**Orchestrator DI ports (26 → 0)** — all retire as types; capabilities go via the seam map.
Distinctive extras beyond the universal seam map:

- `ScheduleMaintenanceContext` — only storage keys (`screenerExecutionContextKey`,
  `legacyScheduleMigrationKey`) → explicit key params; no identity value carried.
- `ScheduledCallbacksContext`, `ScheduledTasksCopilotContext`, `ScheduledTasksObserveContext`,
  `SettingsWebhookContext` — the 4 identity-bearing ports (`getScreenerExecutionContext`) →
  `ExecutionContext` directly.
- `ScheduledTasksPipelineContext` — `userLogin?` param → `ExecutionContext.principalId`.
- `ScheduleWatchdogContext` — `userLogin?` → Execution; `storage {get,put}` → data seam.
- `NlqPortsContext` — NLQ/monetization/payment fields → explicit NLQ + commercial ports.
- `AsyncJobsContext`, `ChatTurnHelpersContext`, `DurableTurnContext`, `HttpEntryContext` —
  turn/job state (`turnEpoch`, `submittedTurnRoutes`, `activeTurnMetadata`, `turnUserLogin?`) →
  explicit turn-state params + Execution; `sessionKey` → `ExecutionContext.sessionId`.
- `ReportDispatchContext`, `ResearchPublishContext` — report-dispatch/HITL seams → explicit
  dispatch seams; `env` → Universal.
- `AutopilotContext` — `autopilotStateKey` → explicit key param; verdict evaluation → explicit seam.
- `CanonicalReportSeedContext`, `ShardJobReconcileContext` — plain `tenantId: string` →
  `ExecutionContext.tenantId`; `nowMs`/`setBy` → explicit params.
- `GoalScreenDispatchContext` (`env: unknown, getOrm`) → Universal + data seam.
- `GovernanceSeedContext`, `IdpProfileConfigContext` (`sql` only) → data seam only.
- `UsageEventsDoorsContext`, `ChatErrorFallbackContext`, `OptionsStageControlDoorContext`,
  `MeshOptionsStrategyDoorContext`, `MeshScreenDoorContext`, `StockCopilotDoorContext` —
  door/mesh seams (`controlStage?`, `createEtradeService?`, `loadBars?`, `proposalFiler?`, ports) →
  explicit door/port params; `env`/`sql`/`orm`/`storage` → Universal + data seam;
  `readSettingRaw` → Universal fields.

**Route contexts (56 shapes + 1 alias → 0)** — all retire; the alias
`BrokerOrderRouteContext = EtradeBrokerRouteContext` dies with its target. Every route takes the
universal seam map. Distinctive extras, by route (all other routes take only the universal map):

- Identity-bearing (`getScreenerExecutionContext` accessor): `CopilotChannelsRouteContext`,
  `SchedulesRouteContext`, `ScreenerResearchRouteContext`, `StockCopilotRouteContext`,
  `ReportsRouteContext` (inline accessor), `WorkspaceRouteContext` (loosened accessor — same
  owner decision as the Tier A shadows) → `ExecutionContext`.
- Scoped-modes carriers → `UniversalEnvContext.<domain>`: `AdsRevenueReferralsRouteContext`
  (`scopedModes?`), `AlpacaRouteContext` + `MarketDataResearchRouteContext`
  (`scopedMarketDataModes?`), `EtradeBrokerRouteContext` + `EtradeOptionsRouteContext`
  (`scopedEtradeModes?`), `McpChatNlqRouteContext` (`scopedNlqModes?`,
  `scopedHttpDeliveryModes?`, `scopedJobListModes?`).
- Bare `userLogin` value carriers → `ExecutionContext.principalId`:
  `EnrichmentRouteContext`, `WorkflowRunsRouteContext`, `DataProviderRoutesContext`,
  `SearchHubRouteContext` (`userLogin?`).
- Scheduler/job seams → explicit scheduler/job seams: `SchedulesRouteContext`
  (`listSchedules`, `scheduleEvery`, `submitAsyncJob?`, `autonomousMarketScreen`,
  `autoRenewETradeTokens`), `AutopilotRouteContext` (autopilot state + verdict seams),
  `JobStatusRouteContext` (`readJobStatus`, `controlJobStage?`, `replayJob?`),
  `JobDefinitionsRouteContext` (definition/stage-override seams), `WorkflowRunsRouteContext`
  (`sagaAuditStub?`, `sagaProjectionReader?` → explicit saga seams),
  `ScheduledJobOutcomeRouteContext` (`audit` + `getOrm` only).
- Payment/commercial → explicit commercial ports: `AgenticPaymentsRouteContext`,
  `PaymentsRouteContext`, `PaymentAssuranceLiveContext` (`getUserLogin?` → Execution;
  `checkoutPorts?` → explicit ports).
- Broker-env switch: `BrokerEnvironmentSwitchContext` (`readSettingRaw`/`writeSetting?` +
  `Partial<Env>`) → Universal settings fields + explicit settings-write seam.
- Admin/migration/tenant: `AdminTenantQueueContext`, `OrchestratorMigrationContext`,
  `ServiceUserRouteContext`, `DelegationRouteContext`, `PlatformTenantRouteContext`,
  `PlatformUsersRouteContext`, `PlatformAccountRouteContext`, `PlatformChannelRouteContext`
  (`membershipStore?`, `aliasKv?`, `stores?`, `directory?`, `channels?`) → Execution tenant +
  explicit membership/store/channel seams.
- Channel/delivery desk: `TradingIntegrationsRouteContext`, `DataLifecycleRouteContext`,
  `PlatformChannelRouteContext` → explicit channel/delivery seams; delivery-mode header →
  Universal channels section.
- Env-only / near-empty bags (retire with nothing distinctive): `BrokerGateRouteContext`
  (`env` only), `OptionsProviderGateRouteContext` (`env` only), `IdResolveRouteContext`
  (`ensureTables` only), `ScreenerPresetsRouteContext` (`ensureTables` only),
  `SchemaRouteContext` (`getOrm` + `audit?`), `MaintenanceRouteContext` (`agentCtx` + `audit`),
  `CronDispatchRecordRouteContext` (`env` + `sql`), `MeterRouteContext`,
  `OpportunityHuntRouteContext`, `MemoryResetRouteContext`, `KnowledgeCorpusRouteContext`,
  `KvWipeRouteContext`, `ReportsRouteContext` (report-dispatch/HITL/delivery seams → explicit
  seams), `PremiumRouteContext`, `BrokerScreenRouteContext`, `BrokerConnectRouteContext`,
  `BrokerLimitRouteContext`, `BrokerOptionsRouteContext`, `BrokerReadsRouteContext`,
  `BrokerRiskRouteContext`, `AuditRouteContext`, `WatchlistsRouteContext` (`requestedEnv` →
  Universal.environment).
- The 27 route files defining no context stay as they are (raw args / parent context / `env`
  direct) — no count effect.

### 1.5 Lossless mapping — security, MCP, services

**Security beyond `ExecutionContext` (21 → 0) and MCP (2 → 0).** All retire as
`*Context`-named types; the resolver APIs persist under non-Context names.

| Definition(s) | Home |
|---|---|
| `ResolvePlatformContextInput` | Plain resolver input (renamed, e.g. `ResolvePlatformInput`): request facts → explicit params; `permission`/`runSelection`/`runEnvironment` → params + Universal |
| `PlatformContextResult` | The composed pair itself — `resolvePlatformContext` returns `{ execution: ExecutionContext; env: UniversalEnvContext }`; `broker`/`screenProvider`/`tier`/`runBroker` are now `UniversalEnvContext` fields; `factsFromCache` stays a resolution diagnostic on the pair |
| `PlatformContextPorts`, `PlatformContextSources` | Explicit Deps params (test seams), not Contexts |
| `ApiRequestContextOutcome`, `ApiRequestContextDeps` | Renamed resolution result/Deps; the `WeakMap<Request, …>` carrier now holds the composed pair; deny codes persist as the (non-Context) deny-code union |
| `McpToolContextInput`, `McpToolContextDeps`, `McpToolContextOutcome` | Same treatment at the MCP boundary; fixed `serviceId "mcp"` / `taskId "mcp:<traceId>"` inputs stay explicit params |
| `ExecutionContextAuthority` | Renamed `ExecutionAuthority` Deps/param (`memberships`, `isConnectionBound`) |
| `ResolveExecutionContextInput` | Plain resolver input (renamed) |
| `ExecutionContextRequestEcho` | Denial-echo field on the renamed denial result |
| `NarrowExecutionContextInput` | Explicit narrowing params to `narrowExecutionContext` |
| `ResolveLedgerWriteContextInput`, `ResolveLedgerWriteContextHeaderInput`, `LedgerWriteContextLog`, `ObserveLedgerWriteContextInput` | Narrowed `ExecutionContext` (service principal, tenant, approval reference) + explicit ledger-write params (`kind`, `checkoutId`, `claimTxHash`, `paymentIntentId`); log/observe → audit seam. **Possible +1**: if the owner requires a distinct audited ledger-write type for separation of duties, it would remain as one renamed type — outside the base range |
| `ObligationEvaluationContext` | Explicit evaluator params + the validated `ExecutionContext` it evaluates against |
| `TenantProviderContext` | `UniversalEnvContext.tenant.providers` (brokerId, dataProviderId, fell-back flags, display names) |
| `PlatformIdentity` | Split: `tenantId`/`tier` → Execution + Universal; `userLogin` → identity-resolution input; `creditsUSD`/`includedRunsRemaining` → Universal commercial section or explicit commercial seam |
| `McpToolContext` | Composed pair + explicit seams: `env`→Universal; `orm`/`storage`→data seam; `sessionId`→Execution; `executionContext?`→the Execution argument itself; scoped modes→Universal sections; `submitJob`/`getJob`/`listJobs`→job seams; `actingLogin`/`traceparent`→explicit accessors |
| `OpenaimpMcpHandlerContext` | Same as `McpToolContext` (near-subset); the handler builds the composed pair directly, no intermediate handler context; `deliveryModeRun` → Universal channels section |

**No counted definition in this category is left homeless: 0 "no home — defect".**

**Services inputs/results (2 → 0)**

- `ResolveRunBrokerContextInput` → explicit params to the broker-resolution step inside the
  Universal resolver; its output is `UniversalEnvContext.broker`.
- `ValidatedExecutionAccountContext` → `UniversalEnvContext.broker` (validated account section);
  validation stays in its resolver.

### 1.6 Lossless mapping — config / env objects (77 → 2)

- **`Env` (335 fields) — REMAINS (1).** The raw Worker binding shape is not the resolved
  `UniversalEnvContext`: it is what the runtime hands the Worker (bindings, secrets, vars). It
  shrinks (52 text vars move to the file; 199 unread fields per the open decision) but stays 1
  type. Verified in the clone: `src/types.ts:3`, 335 fields per the survey.
- **`UniversalEnvContext` — NEW (1).** Extends the `ResolvedEnvironment` shape
  (name/label/isLive/etrade/payments/serviceUserLogin/agentSchedule) with the sections below.
  Resolved once per request (platform-global parts once per isolate init), composed with
  `ExecutionContext` at the API boundary (#6172), MCP boundary (#6173), and DO route shell via
  `resolvePlatformContext`.
- `ResolvedEnvironment` + `EnvironmentETradeConfig` + `EnvironmentPaymentsConfig` →
  `UniversalEnvContext` core sections (`environment`, `etrade`, `payments`). Retire as separate
  types.
- `EtapiConfig` + 16 sub-interfaces → `UniversalEnvContext.etapi` (one section; the 16 become
  nested section types, not contexts).
- `OtelFileConfig` → `UniversalEnvContext.otel`; `config/otel.json` remains as file data;
  `OtelConfigPort` remains as the D1-backed `runtime`-level override **seam** (not counted);
  `OtelResolutionSource` vocabulary (`run|session|user|runtime|env|file|builtin`) is reused as the
  one cascade's source enum.
- `FeatureEvaluationContext` → `UniversalEnvContext.flags` (evaluation snapshot);
  `FeatureFlagPort` remains as the flag-reading **seam** (not counted). The 29-flag union and
  adapters persist behind the port.
- `PriceCatalogue` / `PriceEntry` → **remain as the D1 price port** (not counted as contexts):
  prices are per-tenant operator data, not environment config, and do not belong in
  `UniversalEnvContext`.
- **25 `*Modes` families → 0 separate types.** Verified in the clone: exactly 25 `*Modes.ts`
  files in `src/config/`. Each family's scope-carrier interfaces (`*ScopedModes`,
  `*ScopeLevels`, `Resolved*`) retire; each domain's resolved values become a section of
  `UniversalEnvContext` (e.g. `etrade`, `screener`, `nlq`, `otel`, `payments`, `marketData`, …).
  The per-domain **resolver functions** remain as functions (not types) and all converge onto the
  one cascade: **run > session > user > runtime > env > file > built-in safe default** (the OTEL
  7-level statement). The `runtime` level is the tenant-override level (home = open decision).
- Misc `*Config` objects → `UniversalEnvContext` sections named after each (`sessionStore`,
  `platformContext.cache`, `commercial`, `jobs`, `trading`, `research`, `brokers`, `heartbeat`,
  `lifecycle`, `profileLimits`, `sessionLimits`, `vocabulary`, `channelBrokers`, `idpProfile`,
  `orderCapabilities`, `shardPacing`, `sloThresholds`, `analyticsLake`, `opportunityHunt`,
  `researchRules`); file-backed ones keep their `config/*.json` files as data read by the one
  resolver.
- 18 config JSON files (verified in the clone: 18 files in `config/`) → **remain as data files,
  not counted**: `environment.config.json` is extended as the carrier (52 text vars move in); the
  other 17 stay as the file layer for their domains unless the owner consolidates them into the
  one file — file inventory range **1–18**, type-count effect 0.
- `wrangler.jsonc` vars+bindings → the deployment manifest, not a context (reclassified, not
  counted); 52 text vars leave it as comments per the 2026-11-24 owner ruling; secrets/bindings/
  `CF_DEPLOY_VERSION` stay in env.

### 1.7 Lossless mapping — client React contexts (3 → 1–3) and client data shapes (5 → 0)

| Definition | Fate | Home / reason |
|---|---|---|
| `ToastContext` (`Toast.tsx:59`) | **Remains (1)** | Retained with reason: client UI feedback state, shared across 11 component files — no home in Universal/Execution, and forcing it there would be wrong. Out of scope of the platform program. |
| `PageChromeContext` (`PageShell.tsx:22`) | Retire in base case (0); retain +1 if owner keeps it | Single literal (`"page"\|"tab"\|"nested"`), only `PageShell` reads it, all providers pass `"tab"` → explicit prop. |
| `ChainContext` (`OptionsResearchPanel.tsx:503`) | Retire in base case (0); retain +1 if owner keeps it | Provider and sole consumer in the same file; contracts/refresh/target are local UI state → props. |
| `ScanRunContext`, `OfferContext`, `PlatformContext` (store), `ScheduleRowContext`, `TradeOrderContext` | Retire as `*Context`-named types (0) | Renamed plain prop/state types; the client `PlatformContext` store becomes a client-side projection of the composed pair fetched from the server, not a React context. |

### 1.8 Platform-provided (3 types, 5 sites — remain, counted separately)

Workers `ExecutionContext` (1 type at 3 sites: `scheduled`, `queue`, `email`),
`DurableObjectState` (1 type, 3 constructors), Agents-SDK `AgentContext` (1 type, `this.ctx`).
**Cannot be retired.** Note the name collision: the app's validated `ExecutionContext` and the
Workers `ExecutionContext` are distinct types that both remain — the count keeps them separate.
The `email()` receipt site is a dead pass-through (never referenced, verified in the survey) —
the site could be dropped, type-count effect 0.

### 1.9 Open decisions that change the context count

| Decision | Effect on the headline | Deciding factor |
|---|---|---|
| Identity unification: migrate `ScreenerExecutionContext` login store → `ExecutionContext` principalId store, or keep the legacy store with a recorded sunset? | **±1** (already spans the 4–7 range; base case assumes unification) | Owner ruling; also settles the optional-`userLogin` shadows, which have no home until then |
| Client `ChainContext` / `PageChromeContext` retention | **+0–2** (already spans the range; base case retires both to props) | Owner call on local UI state; `ToastContext` stays either way |
| Tenant-override home (D1 table? DO? per-tenant file? formalized `TENANT_*_JSON` env vars?) | **0 on types; 1–18 on files.** +1 only if the owner creates a distinct `TenantContext` type — which would breach one-of-everything and should be flagged, not silently added | Owner ruling; Universal ships platform-global first with the tenant layer sequenced |
| 199 unread `Env` fields: remove or leave? | **0 on types** (`Env` stays 1 either way); field count falls, exact total not derivable (overlap between the 199 and the 52 moved vars is not in the survey) | Owner call |
| File's unread `payments` section: wire into the resolver or delete with a record? | **0** (it becomes `UniversalEnvContext.payments` content or is deleted; no type either way) | Owner call |
| Ledger-write separation: distinct audited ledger-write type or narrowed `ExecutionContext`? | **+0–1, outside the base range** (headline would be 5–8 if retained) | Owner/CISO call |
| 2 unitemized Tier A companion shapes | **±0–2, underivable** — the survey names neither, so no home can be assigned | Itemize them first; if either is a distinct retained identity type, add 1 each |
| Handler seams carried as one shared `*Context` vs one Deps object | **+0–1 naming effect only** (no capability change) | Implementer's choice; the census pin should count Deps separately so this cannot inflate the number silently |
| Config-file consolidation: all config into `environment.config.json` vs per-domain files kept | **0 on types; 1–18 on files** | Owner call |

## 2. Target resolver count — derivation from the 586

### 2.1 Counting rule for the end state

A "resolver" in the end state = a named, cross-module function/type that answers one question for
callers outside the universal-resolution module. Internal helpers inside that module (the generic
switch, bool/int parsing) are implementation, not separate resolvers. A question = one semantic
input→output pair, parameterized by surface/kind/key — e.g. "job definition by id" is one question
with a `kind` parameter, not six resolvers; "which broker for this tenant" is one question, not
one per surface. Wrappers that only add throwing (`*OrThrow`), aliases, and per-file copies of the
same function are 0. This is the rule behind every collapse below.

**Second number, not to be confused with the headline:** distinct questions are ≈ **285–320**
(central ≈ 306). Most of those questions are config fields answered *inside* the one universal
resolver, so they add 0 separate definitions. The headline counts definitions; the question count
is the lossless check — every one of the ≈306 questions must have a named home below, or it is a
defect.

### 2.2 The one universal resolver — counted explicitly: 1

`resolveUniversalContext` (the extended `resolveEnvironmentConfig`,
`src/config/environment.ts:102`) — resolved **once per request** from the extended
`environment.config.json` (+ request overrides: tenant, user, overrideEnv). It absorbs, as
fields/mechanism, not as separate resolvers:

- `resolveEnvironmentConfig` itself — it *becomes* the universal resolver.
- `resolveETradeBaseUrl` (`environment.ts:73`, verified in clone: sandbox default + live-host
  allow-list, `#847`) — internal validation helper inside the universal resolver, not a separate
  resolver.
- The broker-environment family: `resolveBrokerEnvironment`, `resolveBrokerEnvironmentDefault`,
  `resolveBrokerEnvironmentFromSettings`, `resolveSharedTradingEnvironment`,
  `resolveTradeEnvironmentFromSettings` (alias, not a definition), `resolveEnvironmentFor`,
  `resolveRequestedEnv`. Verified in clone (`brokerEnvironment.ts:46–105`):
  `resolveSharedTradingEnvironment` and `resolveBrokerEnvironmentFromSettings` are near-identical
  (both read `etrade:environment`, fall back TEST); the reads-vs-trades default asymmetry (`#3382`)
  is preserved as *two fields* on the universal context (read-environment vs trade-environment),
  not two resolvers.
- `getEtapiConfig` (`src/config/etapiConfig.ts:635`, verified: merges `defaults.etapi` + per-env
  block from `environment.config.json` + `ETAPI_CONFIG` override) — not in the 586 (not
  `resolve*`-named) but a config resolver in substance; absorbed as the etapi slice of the
  universal context.
- The OTel resolvers: `resolveOtelMetrics/Traces/Backend/Archive/AlertingSettings` (5,
  `otelModes.ts:910–1218`), `resolveOtelMetrics/Logging/TracesConfig` (3), `resolveOtelMaster`,
  `resolveOtelDestinationEnabled`, `resolveOtelSignalExporter`,
  `resolveOtelDomainEnabled/Level/Sampling` (6 in §3-J) — all OTel fields of the universal
  context. The 5 local `resolveOne<T>` copies inside them are the same generic switch, internal.
- The flag adapters: `EnvFeatureFlagAdapter` / `InMemoryFeatureFlagAdapter` (`src/features/*`,
  verified) are *not* in the 586 and are *not* resolvers — they are the two implementations of
  the one `FeatureFlagPort`. Flags themselves are universal-context fields. The adapters are
  retained as adapters (2 implementations, 1 port, 0 resolvers).

Secrets are **not** absorbed: the JSON file must not carry secret values. Secret *names* are
config fields; secret *values* come from the secret store via the one generic secret resolver
(counted in J).

### 2.3 Breakdown by group

| Group | Today | Distinct questions | Separate resolvers remaining | Retired resolvers' home |
|---|---|---|---|---|
| **U — universal** | 1 (`resolveEnvironmentConfig`) | 1 | **1** | — (it is the home) |
| **A — mode/switch** | 73 | ≈64 fields, 1 mechanism | **0** | Universal context (fields) + internal generic `resolveSwitch<T>` |
| **B — tenant/broker/provider/platform** | 51 | ≈17 | **6 (5–8)** | Universal (selection/env fields) + 6 surviving store lookups |
| **C — config/env/policy/payment knob** | 114 | ≈102 fields/questions | **8 (6–10)** | Universal (knobs) + 8 surviving |
| **D — user/account/identity/binding** | 28 | 4 | **4 (3–5)** | 4 surviving (below) |
| **E — job/pipeline/chain/stage/schedule** | 49 | ≈20 | **11 (9–13)** | 1 catalogue + schedule/stage/chain/dispatch/provenance |
| **F — routing/DI/registry/manifest** | 4 | 4 | **4 (3–4)** | Each survives |
| **G — generic duplicated helper** | 34 | 11 names / 5–6 semantic | **2 (2–3)** | Internal parsing/switch → universal; caller + ports survive |
| **H — pipeline `*OrThrow`** | 6 | 0 new | **0** | The 6 underlying E resolvers (throwing is a call-site option) |
| **I — symbols/universe/scope** | 22 | 4 | **4 (3–5)** | 4 surviving |
| **J — other domain-specific** | 176 | ≈90 | **61 (51–71)** | See J buckets below |
| **§4 class methods (17)** | 17 | — | **+4 (3–5)** | See §2.5 |
| **§4 types/interfaces (9+3)** | 12 | — | **+1 (1–2)** | Refund source interface; rest fold |
| **Total** | **586** | **≈306** | **106 (87–127)** | |

Arithmetic check — central: 1+0+6+8+4+11+4+2+0+4+61+4+1 = **106**. Low:
1+0+5+6+3+9+3+2+0+3+51+3+1 = **87**. High: 1+0+8+10+5+13+4+3+0+5+71+5+2 = **127**.
Group totals sum to the survey totals (73+51+114+28+49+4+34+6+22+176 = 557; +17+9+3 = 586 —
verified by re-parsing the survey list).

### 2.4 Per-group derivations

**A — mode/switch (73 → 0 separate; 64 fields, 1 mechanism).** The 73 are almost 1:1 with
config fields, so the *field* collapse is small — the *definition* collapse is total. Verified
in clone (`etradeModes.ts:165–260`): `resolveSwitch<T>` is the run > session > user > env > legacy
cascade; `resolveEtradeScan/Quote/Preview/Positions/Status/DiscoveryMode` are one-line
instantiations differing only in valid-set + switch name, and `resolveEtradeRestSwitch` is the same
six again by key. Counting fields (collapsing RestSwitch overloads, the `*FromEnv` variant, and
the copilot duplicates): E*TRADE 6, market-data 7, quote 7, agentic-payments 6, route surfaces 5,
command modes 4, enrich joins 3, ChatNlq 2, knowledge 2, copilot execution/Rsi 2–3, plus 1 each
for ads-revenue, api-ingress, http-delivery, goal-compile, Nlq, payments-flow, privacy,
research-stage, audit-write, schema-migration, screener-default-execution, privacy-Dsar,
agent-access, membership-repair, stale-cleanup, execution-mode, ledger-read, scheduled-effective,
discovery-run, strategy-mode, AI-model-name ≈ **64 fields**. All 64 are fields of
`UniversalEnvContext`, answered by the one internal generic switch. **No A question is dropped;
no A resolver survives separately.** If the owner later decides each mode field is its own
resolver, add ≈64 — that decision is what the JSON-as-context design rules out.

**B — tenant/broker/provider/platform (51 → 6).** Questions: tenant 1, broker-environment 1,
broker selection 1, data-provider selection 1, screen-provider 1, web-search provider 1, history
provider 1, channel 1, platform identity 1, stored credentials/logins/bindings 3, recipient
binding 1, channel state 1, publish channel 1, run-broker context 1 ≈ 17. Absorbed into universal
fields: tenant, broker-env, broker/data/screen/web-search/history provider selections, platform
identity, run-broker context (that *is* the per-run universal context). Surviving (store/state
lookups the JSON file cannot answer): **(1)** tenant credentials (`resolveTenantCredentials`),
**(2)** tenant logins (`resolveTenantLogins`, `resolveLoginsForTenant` — same question),
**(3)** provider binding (`resolveProviderBinding`), **(4)** recipient binding
(`resolveEnvChannelRecipientBinding`, `resolveTenantOwnerEmailBinding` — one question, env vs
tenant source), **(5)** schedule channel state (`resolveScheduleChannelState`,
`resolveScheduleChannelFlagsView`), **(6)** publisher channel
(`resolveAndVerifyPublisherSlackChannel`, `resolveSocialSlackChannel`,
`resolveChannelDisposition` — one channel-routing question). Range 5–8: `resolvePromptBrokerTools`
may survive as a 7th (broker→tools derivation) and channel-state vs publish-channel may split
(+1). Verified: `tenantProviders.ts:111–344` — `resolveTenantProviders`,
`resolveEffectiveTenantProviders`, `resolveTenantBroker`, `resolveTenantBrokerSelection`,
`resolveTenantDataProviderSelection`, `resolveScreenProviderForRun`,
`resolveManualScreenProviders` are all the same stored-selection row read through different
default/presence seams; they collapse to the universal context's broker/provider fields.

**C — config/env/policy/payment knob (114 → 8).** ≈102 distinct knob fields (timeouts,
thresholds, heartbeat, OTel, research-stage, stage timeouts, feed cadence, etc.) are
universal-context fields — including the 4 `resolveScreenerNdGate*` variants (1 field) and the 5
OTel settings. Surviving: **(1)** tier-for-user (`resolvePremiumTier`, `resolveEmailTier`,
`resolveMeteredTier`, `resolveEffectiveTier`, `resolveTier`, `resolveAdsTier`,
`resolveTierTransition` — one question, stored tier + transition), **(2)** price
(`resolveProductPrice`, `resolvePrice`, plus class `resolveChargePricing` — one question),
**(3–5)** policy-by-port: audit policy, pipeline policy, retry/breaker policy
(`resolveAuditPolicy`, `resolvePipelinePolicy`, `resolveD1RetryPolicy`, `resolveBreakerPolicyFor`,
`resolvePdpPolicySource` — 3, range 2–4), **(6–7)** job-catalogue parameter questions
(`resolveParameter`, `resolveEnumSource`, `resolveParamDerivation` — 2, range 1–3; fold into E's
catalogue resolver at the low end), **(8)** provenance (`resolveMeterProvenance`,
`resolveGatewayProvenance`, `resolveRefundProvenance` — one generic provenance-from-row question,
range 0–2). The 3 refund factories (`createPayPerRun/Bundle/SubscriptionPaymentResolver`) are
implementations of the one `RefundPaymentSourceResolver` interface — counted under §4, not here.
`createMeterTierResolver` is the tier question (1) above.

**D — user/account/identity/binding (28 → 4).** **(1)** execution-account binding —
`resolveUserAccountBinding`, `resolveExecutionAccountTuple`, `resolveExecutionAccountContext`,
`resolveValidatedExecutionAccountContext`, `resolveScheduleBindingDefaults`,
`resolveEffectiveAccountBinding`, `resolveAccountByLabel`, `resolveAccountId`,
`resolvePaidScreenAccount`, `resolveStockCopilotActiveBinding` (one question, parameterized by
schedule/label/manual); **(2)** actor identity — `resolveIdentityFacts`, `resolveEntryUserId`,
`resolveDoNameForUser`, `resolveAliasLogin`, `resolveCaptureUserLogin`, `resolveLogins`,
`resolveDispatchCandidate`, `resolveAsyncJobIdentity`, `resolveScheduledLogin`,
`resolveTrustedScheduleIdentity`, `resolveTokenServiceLogin`, `resolveServiceLoginForEtrade` (one
question: who is the actor/login for this request/job); **(3)** DID document —
`resolveAgentDidDocument`, `resolveEtradeAuthorizerDid`, `resolveSnapIdentity` (did → document;
folds into (2) at the low end); **(4)** user quota — `resolveUserRequestQuota` (runtime counter,
not config).

**E — job/pipeline/chain/stage/schedule (49 → 11).** **(1)** job-by-id catalogue —
`resolveFeedJob`, `resolveEnrichJob`, `resolveAnalyzeJob`, `resolveGenerateJob`,
`resolveDeliverJob`, `resolvePipelineChain`, `resolveAnalyzeStepJob`, `resolveSubJob` (one
question, `kind` parameter; the one externalized job catalogue, #5880). The 6 `*OrThrow` wrappers
(H) are 0. **(2–4)** schedule — schedule source (`resolveScheduleSource`), schedule run
trigger/id (`resolveScheduleRunJobId`, `resolveScheduleRunTrigger`), pending approval / flags
caller / firer dispatch (`resolvePendingScheduleApproval`, `resolveScheduleFlagsCaller`,
`resolveScheduledFirerHostDispatch` — 3 questions, range 2–4). **(5)** stage-by-path —
`resolveStage`, `resolveStageNode`, `resolveWorkflowStage`, `resolveOptionsStageId`. **(6)**
chain source — `resolveChainSourceForRequest`, `resolveShardChainSource`,
`resolveChainAuthority`. **(7–8)** dispatch/run id — `resolveFeedDispatchJobId`,
`resolveFeedDispatchPipelineRunId`, `resolveScreenJobId`, `resolveWorkflowRunId`,
`resolveLinkedJobRunId` (2: dispatch-job-id and run-id). **(9–10)** provenance + failure code —
`resolveJobProvenance`, `resolveJobFailureCode`. **(11)** observers —
`resolveJobPipelineControlObservers`. Absorbed/validated-as-config (internal to
catalogue/universal): `resolveJobDefinition`, `resolveJobDefinitionSpec`, `resolveSchedule`
(raw→config), `resolveStageSchedule`, `resolveScheduleList*`, `resolve*Sections`,
`resolveScheduleUpdate` ×2 (one question, deprecated copy folds into the unified one),
`resolveJobSubset`, `resolveCronEntryPoint`, `resolveHttpJobChain`, `resolveWebSearchChain`.

**F — routing/DI/registry/manifest (4 → 4).** `resolveAgentCapabilityManifest`,
`resolveUnitDriver`, `resolveRouteId`, `resolveChallengerOutcome` — four distinct questions, each
survives. Low end 3 if `resolveRouteId` folds into a generic enum-validation helper.

**G — generic duplicated helper (34 → 2).** 11 unique names, 5–6 semantic questions: bool
(`resolveBool` ×3, `resolveBoolean` — 1), int (`resolvePositiveInt` ×3, `resolveInt`,
`resolveMinutesKnob` ×6, `resolveDays` ×2 — 1 parsing primitive), switch (`resolveSwitch` ×5,
`resolveOne` ×5 — 1, internal to universal), caller/operator (`resolveCaller` ×3,
`resolveOperator` ×3 — 1, runtime auth identity), ports (`resolvePorts` ×2 — 1, DI wiring).
Surviving: **caller (1) + ports (1) = 2** (range 2–3 if operator is a distinct role-checked
question). Bool/int/switch are internal to the universal resolver, 0 separate.

**I — symbols/universe/scope (22 → 4).** **(1)** universe-to-symbols — `resolveUniverse`,
`resolveRunUniverse`, `resolveUniverseSymbols`, `resolveUniverseListings`, `resolveAllListings`,
`resolveUniverseListWithHydration`, `resolveUniverseIndex`, `resolveCopilotUniverse`,
`resolveCopilotUniverseFull`, `resolveCopilotUniversePreset` (one question; verified in clone
`stockCopilotConfiguration.ts:215+`: sync version parses setting/env/default, full version reads
the stored index list — same question, two sources). **(2)** scope — `resolveToolScope`,
`resolveScopesWithRoleAdapter`, `resolveOptionsReportScope`, `resolveScopeSymbols`. **(3)**
leg/flow symbols — `resolveGoalStockLegSymbols`, `resolveGoalOptionsLegSymbols`,
`resolveDynamicFlowSymbols`, `resolveTrackedSymbols`, `resolveTapeSymbols`. **(4)** per-symbol
derivation — `resolveFeedSnapshotForSymbol`, `resolveSymbol`, `resolveStockSector` (folds into (3)
at the low end).

**J — other domain-specific (176 → 61, range 51–71) — the bounded group.** Name-based buckets
(re-counted from the §3-J list; they sum to 176) with surviving questions per bucket:

| J bucket | Entries | Surviving |
|---|---|---|
| Config-absorbed (OTel 6, heartbeat due-hours 3, broker endpoints, flag-managed-by, retention, run-ledger filters, shard pacing, session cap, vocab value/axis, research rules, social-feed source, breakout caps) | 27 | 0 — universal fields |
| Secrets/credentials (`resolveEmailSecret`, `resolveThinkWebhookSecret`, `resolveClientSecret`, `resolvePublicCredentialRef`, `resolveAlpacaPair`, `resolveTastytradeCredentials`, `resolveOtelBackendCredentials`, `resolveTokenSet`) | 8 | 1–2 — one generic secret-by-name resolver (+ token-set by family) |
| Host dispatch (`resolve*HostDispatch` ×5 + `resolveCallbackDispatch`) | 6 | 1–3 — one generic host-dispatch question; +2 if per-work-type inputs differ |
| Delivery/recipient/verify + email (`resolvePublishTarget/SubmissionEndpoint/PostUrl`, `resolveAndVerifyPublisherWebhookUrl/EmailTo`, `resolveAndVerifySlack/WebhookRecipientAtDelivery`, `resolveOptionsRunEmailRecipient`, `resolveEmailDestination`, `resolveAgentEmailNamespace`, `createPortThinkEmailResolver`, DI `resolveSlackPost/EmailSender/Logger`) | 14 | 4–6 |
| Copilot/strategy/trading derivations (strategy profile, thesis, risk profile, copilot trading selection/strategies/sessions/filer/activation, order type/TIF, ladder deltas, SPY-put contract, cancel targets, scan target/clock, allowed ids, panel bands, score weights ×2, side, enrichment selection/timeframe, market-data quotes, positions snapshot, preset filter) | 27 | 14–18 — verified: `resolveScoreWeights` reads `SCORE_WEIGHTS` from the etapi config (`strategyEngine.ts:321,353`) + a runtime `bias` input, so base weights are universal fields and the bias-adjusted derivation survives as **1**; `resolveNoViewScoreWeights` calls it, 0 extra |
| Reports/ledger/run-detail/provenance/rewards/product (stored report, serve leg, audit/error/outcome aspects, provenance, report link/canonical/format, scan linkage, feed quotes from artifact, run detail, ledger write context, attribution, social rewards ×3, product access ×2, effective version, run context) | 25 | 14–17 |
| Identity/authz/session, J-side (viewer, wired/delegation/operator/admin/nav callers, acting session, MCP principal, draft owner, execution context, grant proposal, bootstrap, offboard, DO-name input, store-operator access, current list, principal, screen execution context, paid-screen action, reader halt, brief date) | 21 | 6–8 — caller variants fold into G's caller (1); `resolveExecutionContext` is the per-run universal context itself, 0 extra |
| Job/stage/research/DI/ports/catalogue/generic (stub, stores, checkout/token/research stores, spec axes/number/param, sections helpers, statement/recreate plan, handoffs ×2, schedule timing/lifecycle, node, observers, run-now trigger, Yahoo deps, research datasets/adapters, knowledge/memory-read, public bars, bulk-move population, x402 network, voice backends ×2) | 33 | 7–10 — ports/stores fold into G's ports (1); catalogue spec folds into E; schedule timing folds into E |
| A2A (`resolveA2AAgent`, `resolveA2AInstanceName`) | 2 | 1–2 |
| Misc stragglers (selected run ×2, OTel catalog message/severity/alert-rule/record-kind ×4, stored index list, prefixes, screen selection, research venue, offer) | 13 | 3–5 — selected run 1, OTel catalog 1–2, research venue 1 (`#6178` already landed the one venue resolver), offer 1; stored index → I, prefixes → G, screen selection → B |
| **J total** | **176** | **51–71, point 61** |

**Why J is a range, not a point:** a full body read of all 176 was not feasible (the survey
itself was name-based). What would narrow it: a body read of the ~40 ambiguous entries —
principally the trading-derivation bucket (are `resolveThesis`/`resolveRiskProfile`/
`resolveStrategyProfile` three questions or one strategy-resolution question with three outputs?),
the reports bucket (is provenance one generic question or per-row-type?), and the host-dispatch
bucket (one generic vs per-work-type). Each such read moves the total by ±1; the range width
(±10) is the sum of those judgement calls, not ignorance about the list — every entry is assigned
to a bucket above.

### 2.5 §4 — class methods (17), types (9), interface declarations (3)

Worked through the survey §4 list name by name:

- **Survive as their own question (+4):** `resolveId` (2 adapters + interface
  `runRegistryPorts.ts:139` — run-id resolution, 1 question, 2 adapter implementations);
  `resolveUncached` (`betaService.ts:140`, with `BetaResolver` type — beta-for-symbol, 1);
  `resolveCalibratedPrompt` (`telemetryPorts.ts:553` — calibrated prompt for tenant/actor/key, 1);
  `resolveRoute` (`dataProviders/registry.ts:189` — capability assignment, 1; folds into F at the
  low end).
- **Fold into a counted standalone question (0 extra):** `resolveDeliveryTenant` → B tenant;
  `resolveWatchlistSymbols` → I universe; `resolveTokenIdentity` → D actor identity;
  `resolveMany` → J allowed-strategy-ids; `resolveEngineClient` → G ports;
  `resolveStrategyProfile` (class) → J strategy profile (duplicate of the standalone);
  `resolveUnderlyings` → I symbols; `resolveAccount` → D account binding;
  `resolveDefaultAccountNumber` → D account binding; `resolveSymbols` ×2 adapters + interface →
  I symbols; `resolveChargePricing` → C price; `resolveApiKey` → J generic secret.
- **Types/interfaces (+1):** `RefundPaymentSourceResolver` — 1 question (refund source); its 3
  factories (`createPayPerRun/Bundle/SubscriptionPaymentResolver`) are adapter implementations, 0
  extra. The other 8 types fold: `McpRoleResolver` → I scope;
  `ProviderResolver`/`ProviderIssuerResolver` → B provider; `WalletLoginResolver` → D identity;
  `SettingResolver` → internal to universal; `JobPipelineControlOtelResolver` → E
  observers/OTel; `BetaResolver` → the beta question above (already counted);
  `BrokerChainSourceResolver` → E chain source. Interface `resolveStage` → E stage. **No type is
  a separate resolver definition beyond the 1 refund-source interface.**

## 3. Lossless / additive check — "no home" items

Every retired definition above names its home (universal field, or a named surviving resolver).
The items below have **no confirmed home — open candidates, not asserted defects** — because
their bodies were not read or the survey did not itemize them. Each needs one body read or one
owner decision; none is silently dropped.

| # | Item | Why no home yet | What decides it |
|---|---|---|---|
| 1 | 2 unitemized Tier A companion shapes (context survey §1.1) | The survey names neither, so no home can be assigned | Itemize them first; if either is a distinct retained identity type, add +1 each to the context headline |
| 2 | Optional-`userLogin` inline shadows (`workspace.ts:23`, `thinkAdapter.ts:735,739–740`) | Drift: optional login where canonical requires it | Owner decision — restore required `userLogin` or record why optional |
| 3 | `resolveStub` (`src/agents/orchestrator/meshDoors.ts:413`) | Generic stub lookup for mesh doors; name does not pin the question | Body read — if it is test/mesh scaffolding it belongs outside the production count, not migrated |
| 4 | `resolveReaderHalt` (`src/agents/scheduled-agent.ts:301`) | Halt-condition derivation; no obvious home among the surviving questions | Body read |
| 5 | `resolveCurrentList` (`src/server/routes/auth.ts:2999`) | Name does not say what list | Body read |
| 6 | Ledger-write separation (context §1.5) | Narrowed `ExecutionContext` is the base-case home; a distinct audited type would be +1 outside the base range | Owner/CISO call |

Everything else maps. In particular: `resolveBriefDate` is a pure date formatter, not a
resolution question — it drops as a classification correction, not a lost question. The
deprecated `resolveScheduleUpdate` (`scheduleManagement.deprecated.ts:113`) folds into the unified
one (`unifiedScheduleManagement.ts:2512`).

## 4. Open decisions that would change either count

**Resolver-count swings** (from §2):

1. **Per-field vs universal mode/config resolvers** — if each of the ≈64 A fields (or ≈102 C
   knobs) keeps its own resolver, add up to +64/+102. The JSON-as-context design is the decision
   that prevents this; it is the single largest swing.
2. **Job catalogue granularity** — one job-by-id resolver (counted) vs one per kind
   (feed/enrich/analyze/generate/deliver/chain): +5.
3. **Host dispatch granularity** — one generic vs one per work-type
   (comparison/goal-leg/shard/scan/evaluate): +4.
4. **Secrets** — one generic secret-by-name resolver (counted) vs one per secret: +6.
5. **Broker/tenant selection placement** — if tenant/broker selection is a separate
   persisted-selection resolver rather than universal-context fields: +2–3.
6. **Caller/ports as context vs DI** — if `resolveCaller`/`resolvePorts` become fields of the
   universal context rather than surviving resolvers: −2.
7. **`*OrThrow` variants kept as exports** — +6 (derivation rule says they are not separate;
   reversing it adds 6).
8. **ExecutionContext vs UniversalEnvContext** — if `resolveExecutionContext`
   (`security/executionContext.ts:315`) and the #6172/#6173/#6174 family are a *separate* context
   from the universal env context: +1 (and a standing duplication risk with the universal
   resolver).
9. **The 3 no-home resolver candidates** (`resolveStub`, `resolveReaderHalt`,
   `resolveCurrentList`) — body reads decide whether each is +1, folds into an existing question,
   or is test scaffolding outside the count.
10. **Dead-code analysis** — see §5 (−0 to ~−27).
11. **OTel catalog / provenance genericity** — one generic catalog/provenance resolver vs
    per-type: ±3 (inside the J range).

**Context-count swings** — see §1.9 (identity unification ±1; client React retention +0–2;
tenant-override home 0 on types; 199 unread `Env` fields 0 on types; payments section 0;
ledger-write separation +0–1 outside the base range; the 2 unitemized Tier A shapes ±0–2;
Deps-vs-Context naming +0–1; config-file consolidation 0 on types).

**Decisions the program must not smuggle in:** identity unification is a separate decision from
config unification (the universal context ships first; the legacy login store is retired only by
ruling). The tenant layer ships as a sequenced follow-up, not inside the first universal-context
slice. The 199 unread `Env` fields and the file's unread `payments` section are owner calls, not
cleanup done silently inside the move.

## 5. Caveats — where the derivation is not exact

- **Dead-code sensitivity (resolvers, not subtracted).** The survey did no dead-code analysis;
  134 of the 557 are file-local. If dead-code analysis finds some of those uncalled, the headline
  falls — but only by the number actually proven dead, concentrated in file-local G/J helpers. As
  a sensitivity only (not a claim): if 10–20% of the 134 are dead, the central estimate drops by
  ~13–27, to ~79–93. Do **not** subtract anything until that analysis exists; assuming any
  specific local helper dead would be inventing the count.
- **The survey's 77 (contexts) does not publish a line-by-line tally.** Reconstructing it from
  its §1.5 groupings gives 70 on the narrow reading (Env + Resolved + Etapi 17 + OTEL 2 + flags 2
  + prices 2 + Modes 25 + JSON 18 + wrangler/environment.config 2) and overshoots when all 24
  misc `*Config` objects are added — a ±7 reconciliation gap in the survey itself. It does not
  move the end count: every config item's fate is the same class (Universal section / file data /
  port seam / explicit param), so the config end state is 2 regardless.
- **Security 21 likewise does not itemize to 21 by name in §1.4** — 19 named interfaces +
  `PlatformIdentity` = 20, plus the 2 MCP = 22 in the section, against the §0 headline of 21 + 2
  = 23. Same situation: all share the retire fate, so the end count (0) is unaffected.
- **Tier A 17 vs 15 itemized** is inherited from the survey (±2, §1.4).
- **J is a range (51–71), not a point** — a body read of the ~40 ambiguous entries would narrow
  it; each read moves the total by ±1.
- **Verified against the clone** (`~/workspace/scratch-cfagent-main`, main `3e516f1c`): 25
  `*Modes.ts` files; 18 `config/*.json` files; 57 route-context names (56 shapes + the
  `BrokerOrderRouteContext` alias); `ScreenerExecutionContext` mirrors are `type` declarations,
  not `interface`s; no `UniversalEnvContext` exists yet; `PlatformContextResult` carries
  `{ context: ExecutionContext; broker; screenProvider; tier; runBroker }` as the survey states;
  `resolveEnvironmentConfig` at `src/config/environment.ts:102`; `resolveETradeBaseUrl` at `:73`;
  `brokerEnvironment.ts:46–105`; `tenantProviders.ts:111–344`; `strategyEngine.ts:321,353`;
  `stockCopilotConfiguration.ts:215+`; `etradeModes.ts:165–260`; `etapiConfig.ts:635`;
  `otelModes.ts:910–1218`. No code was modified.
- **Issue states** (#6491 open, #6487 parent, #6172/#6173/#6174, #3786, #3216, #1314) are taken
  from the parent agent's read on 2026-11-25, not re-verified here. No GitHub state was changed
  or re-checked.

## Sources traced

- `~/workspace/your_files/context-survey-rca-plan.md` — 209 contexts, RCA, fix plan (§0 counting
  rule, §1 counted list, §3.2 target shape, §3.3 phases, §3.5 open decisions).
- `~/workspace/your_files/resolvers-and-issues-survey.md` — 586 resolver definitions (§3 557-entry
  list re-parsed: group totals and duplicate names verified by script; §4 17+9+3 list; §5 issue
  coverage).
- Clone `~/workspace/scratch-cfagent-main` at `3e516f1c` — bodies read as listed in §5 and in the
  per-group derivations. No code was built, written, or pushed; no GitHub writes were made.
