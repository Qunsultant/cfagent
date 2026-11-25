# Resolvers and issue coverage — survey

Repo: Qunsultant/cfagent, main at `3e516f1c` (2026-11-25). Read-only survey; no code changed, no GitHub writes.
A sibling survey is counting `*Context` objects separately — this document is resolvers + issue coverage only.

## 1. Resolver count

### Definition used (and where the line was drawn)

A **resolver** is a function named `resolve*`, a `create*Resolver` factory, or a `*Resolver` type/class/object, that turns raw inputs (env vars, config files, headers, ids, names, stored settings) into a resolved/validated value or object — i.e. it applies a **priority cascade, lookup, validation, or defaulting** and returns a typed result. Definitions were counted, not usages. Overload signatures were collapsed to one resolver.

**Line drawn:** counted — a function that applies a fallback chain (env > file > builtin), validates against an allow-list, or maps a raw string/id to a typed object/enum with a default. **Not counted** — plain getters with no fallback/validation, pure string parsers, and generic DI-container `resolve(name)` methods (listed separately below).

**Borderline, disclosed:** `const resolveX = deps.x ?? default` DI-fallback bindings — 3 of these in `src/observability/otelAlerting.ts` (`resolveSlackPost`, `resolveEmailSender`, `resolveLogger`) *are* in the count because their arrow is on the definition line, while 4 same-shaped bindings (`resolveSymbols` meshOptionsStrategyDoor:302, `resolveUserLogin` screenerQueueConsumer:44, `resolvePlatform` brokerChainSourceResidency:104, `resolveIdentity` platformContext:233) are *not*. So the headline is **±4–6** depending on where you put that boundary. Anonymous inline implementations assigned to a Resolver-typed object field (e.g. `resolveTier:` lambdas in `premium.ts`, `resolvePlatform:` in `trading-agent.ts`) were also not counted.

**Verification:** every definition was found by anchored patterns (`function resolve*`, `const resolve* =`, generic `function resolve*<T>`, class/interface methods) and spot-checked by reading bodies — grep alone was not treated as proof. A first sweep missed generic functions (`resolveSwitch<T>`, `resolveSelectedRun<T>`, `createPortThinkEmailResolver<Env>`) and local generic consts (`resolveOne<T>` ×5 in otelModes); a second sweep caught 17 of those.

### Headline totals (src/, non-test)

| Category | Count |
|---|---|
| Standalone `resolve*` functions / const arrows (overload-collapsed; incl. 5 `create*Resolver` factories, 6 `*OrThrow` wrappers) | **557** (423 exported, 134 file-local) |
| `resolve*` class methods (implementations) | **17** |
| `*Resolver` type/interface definitions | **9** |
| `resolve*` interface method declarations (contracts only) | **3** |
| **Total named resolver definitions** | **586** |

### Breakdown of the 557 standalone resolvers (name-based classification)

| Kind | Count | What |
|---|---|---|
| A — mode/switch (scoped config) | 73 | Per-surface mode switches, run > session > user > global env > legacy, mostly in `src/config/*Modes.ts` |
| B — tenant/broker/provider/platform | 51 | Tenant, broker selection, data-provider selection, channel |
| C — config/env/policy/payment knob | 114 | Env/policy objects, timeouts, thresholds, tiers, pricing, agent config |
| D — user/account/identity/binding | 28 | Logins, account bindings, execution-account context, DIDs |
| E — job/pipeline/chain/stage/schedule | 49 | Pipeline-job lookup by id/alias, chains, stages, schedules |
| F — routing/DI/registry/manifest | 4 | Capability manifest, unit driver, route id, challenger outcome |
| G — generic duplicated helper | 34 | `resolveBool`, `resolvePositiveInt`, `resolveSwitch`, `resolveOne`, `resolveMinutesKnob`, `resolveCaller`, `resolveOperator`, `resolvePorts`, `resolveDays`, `resolveInt`, `resolveBoolean` — same name defined in 2–6 files each |
| H — pipeline `*OrThrow` wrapper | 6 | Thin throw-on-missing wrappers over the E-kind job resolvers, all in `meshDoors.ts` |
| I — symbols/universe/scope | 22 | Universe/symbol expansion, scopes |
| J — other domain-specific | 176 | Everything else (secrets, paths, recipients, reports, OTel, etc.) |

### By src/ directory (557 standalone only)

services 170, config 128, agents 84, security 41, trading 35, data 27, mcps 13, observability 12, workflows 9, client 8, actors 6, agentic 4, events 3, server 3, a2a 2, enrichment 2, features 2, outcomes 2, aspects 1, breakers 1, gateway 1, orchestrations 1, payments 1, privacy 1.

### Named examples verified to exist

- `resolveEnvironmentConfig` — `src/config/environment.ts:102`, `export function resolveEnvironmentConfig(env?: Partial<Env>, overrideEnv?: string): ResolvedEnvironment` (priority: overrideEnv > `ETRADE_ENVIRONMENT` > `environment.config.json` default > `APP_ENV`/`ENVIRONMENT`; 64 mentions).
- `resolveETradeBaseUrl` — `src/config/environment.ts:73`, `export function resolveETradeBaseUrl(rawUrl: string): string` (sandbox default `https://apisb.etrade.com/v1`, live host allow-listed, `#847` anti-spoof check; only 2 mentions — defined + called once inside `resolveEnvironmentConfig`).

## 2. Top overlaps / duplicates

1. **Environment (TEST/PROD) is resolved in at least 4 places.** `resolveEnvironmentConfig` (environment.ts:102) vs the `brokerEnvironment.ts` family — `resolveBrokerEnvironment` (:46, stored value or TEST), `resolveBrokerEnvironmentDefault` (:57, always TEST), `resolveBrokerEnvironmentFromSettings` (:65) and `resolveSharedTradingEnvironment` (:91) — the last two are near-identical (both read setting `etrade:environment`, fall back TEST); the duplication is deliberate per the `#3382` comment (reads vs trade actions must not share a default), but the logic is copy-pasted. `resolveTradeEnvironmentFromSettings` (:105) is just an alias of `resolveSharedTradingEnvironment`. Plus `resolveEnvironmentFor` (brokerConnect.ts:299) and `resolveRequestedEnv` (brokerOrderCommands.ts:315).
2. **Tenant is resolved in at least 6 places.** Canonical: `resolveIaaaTenant` (`src/security/iaaaGithubEndToEnd.ts:164`, `IAAA_TENANT_ID` env → default; 157 mentions). DB-backed: `resolveTickTenant` (`src/services/paidScreenSubmission.ts:283`). Two near-identical copies of the same "commercial adapter → `resolveTickTenant`" logic: `resolveSubmissionTenant` (`src/agents/orchestrator/asyncJobs.ts:418`, cached) and `resolveDeliveryTenant` (`src/services/scheduledTasks.ts:1558`, private method). Also `resolveEffectiveTenantId` / `resolveCurrentTenant` (`src/services/platformIdentity.ts:78,137`), `resolveBackfillTenant`, `resolveAgentScheduleTenant`, `resolveAccountTenantId`.
3. **Broker/provider selection is a cluster, not one resolver.** `resolveTenantBroker`, `resolveTenantBrokerSelection`, `resolveTenantDataProviderSelection`, `resolveTenantProviders`, `resolveEffectiveTenantProviders`, `resolveScreenProviderForRun`, `resolveManualScreenProviders` (all `src/services/tenantProviders.ts:111–344`) vs `resolveTenantProviderContext` (`src/services/optionsProviderContext.ts:131`) vs `resolveChannelBroker` / `resolveNoSelectionBroker` (`src/trading/channelBroker.ts:62,113`) vs `resolveBrokerSelection` (`src/trading/brokerCatalog.ts:603`) vs `resolveTradingPlatform` (`src/agents/trading-agent.ts:441`) vs `resolveRunBrokerContext` (`src/services/runBrokerContext.ts:86`).
4. **The mode-switch engine is copy-pasted per surface.** Generic `resolveSwitch<T>` is defined separately in 5 `*Modes.ts` files (agenticPaymentsModes:182, etradeModes:165, goalChainModes:165, marketDataModes:262, quoteModes:217); generic `resolveOne<T>` is defined 5× inside `src/config/otelModes.ts` (lines 914, 997, 1058, 1159, 1222, one per enclosing `resolveOtel*Settings` function). Per-surface resolvers then multiply: E*TRADE 6 + `resolveEtradeRestSwitch`, market-data 7 + `resolveMarketDataRestSwitch`, quote 7, OTel 11, agentic-payments 8. `resolveScreenerNdGate` exists in 4 variants (`src/config/screenerModes.ts:191,202,217,249`). Counterweight: `resolveAgentConfig` (`src/services/agentConfigResolver.ts:340`) is the single registry-driven agent-config resolver (14 mentions).
5. **Generic knob helpers are duplicated verbatim across files:** `resolveBool` ×3 (autopilotVerdictTrend:50, judgeScoreFeedback:62, memoryConsolidation:83), `resolvePositiveInt` ×3, `resolveMinutesKnob` ×6 (analyzeJobs:352, deliverJobs:461, enrichJobs:316, feedJobs:263, generateJobs:322, pipelineChains:169), `resolveCaller` ×3, `resolveOperator` ×3, `resolvePorts` ×2, `resolveDays` ×2 (doSqliteJobOutcomeAdapter:55, inMemoryJobOutcomeAdapter:27), `resolveRunDetailMessage` ×2, `resolveScheduleUpdate` ×2 — one copy lives in `src/services/scheduleManagement.deprecated.ts:113` and the other in `src/services/unifiedScheduleManagement.ts:2512`.
6. **Pipeline jobs: definition + wrapper + dispatch copies.** `resolveFeedJob` / `resolveEnrichJob` / `resolveAnalyzeJob` / `resolveGenerateJob` / `resolveDeliverJob` / `resolvePipelineChain` live in `src/services/*PipelineJobs.ts`, are wrapped by 6 `*OrThrow` functions in `src/agents/orchestrator/meshDoors.ts:534–1210`, and `resolveFeedDispatchJobId` (`asyncJobs.ts:958`) re-resolves the same id/alias mapping for dispatch. `resolveStrategyProfile` is defined twice: function in `src/agents/nlqOptionsStrategy.ts:737` and class method in `src/trading/options/unifiedOptionsService.ts:794`. `resolveId` = interface (`src/data/runRegistryPorts.ts:139`) + 2 adapter impls; `resolveSymbols` = interface (`src/retrieval/retrievalPorts.ts:107`) + 2 adapter impls.
7. **Refund/payment resolvers:** `RefundPaymentSourceResolver` interface (`src/data/refundPorts.ts:542`) with 3 factories — `createPayPerRunPaymentResolver` (refundPaymentIntent:91), `createBundlePaymentResolver` (:145), `createSubscriptionPaymentResolver` (refundService:126) — plus `createMeterTierResolver` (routes/meter.ts:82) and `createPortThinkEmailResolver` (agentEmailRouting:189). `WalletLoginResolver` is defined once (`src/security/payerWalletIdentity.ts:19`); its appearance in `src/agents/routes/premium.ts:90` is an import, not a second definition (same for `RefundPaymentSourceResolver` in refundService.ts:75).

## 3. Full list — 557 standalone resolvers

Name | file:line | signature (definition's first line; multi-line signatures truncated). "What it resolves" is the name itself plus its kind heading — names are self-describing; bodies were read for the central ones and a sample of each kind.

### A — mode/switch (73)

- resolveAiModelName | src/agents/model.ts:22 | export function resolveAiModelName(env?: Partial<Env>, taskOrCustomModel?: string): string {
- resolveCopilotChatExecutionMode | src/agents/orchestrator/meshStockCopilotDoor.ts:347 | export function resolveCopilotChatExecutionMode(opts: {
- resolveRouteMode | src/agents/routes/adsRevenueReferrals.ts:107 | function resolveRouteMode(
- resolveAgenticRouteMode | src/agents/routes/agenticPayments.ts:451 | function resolveAgenticRouteMode(
- resolvePaymentsRouteMode | src/agents/routes/payments.ts:188 | function resolvePaymentsRouteMode(
- resolvePaymentsFlowMode | src/agents/routes/payments.ts:248 | export function resolvePaymentsFlowMode(
- resolvePremiumRouteMode | src/agents/routes/premium.ts:161 | function resolvePremiumRouteMode(
- resolveAdsRevenueMode | src/config/adsRevenueModes.ts:130 | export function resolveAdsRevenueMode(levels: ModeScopeLevels): ResolvedAdsRevenueMode {
- resolvePaymentsCreateMode | src/config/agenticPaymentsModes.ts:225 | export function resolvePaymentsCreateMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
- resolvePaymentsConfirmMode | src/config/agenticPaymentsModes.ts:229 | export function resolvePaymentsConfirmMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
- resolvePaymentsTransactionsMode | src/config/agenticPaymentsModes.ts:233 | export function resolvePaymentsTransactionsMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
- resolveAgenticWalletMode | src/config/agenticPaymentsModes.ts:237 | export function resolveAgenticWalletMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
- resolvePremiumScreenerMode | src/config/agenticPaymentsModes.ts:241 | export function resolvePremiumScreenerMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
- resolvePremiumResearchMode | src/config/agenticPaymentsModes.ts:245 | export function resolvePremiumResearchMode(levels: PaymentsModeScopeLevels, legacy: PaymentsSurfaceMode): ResolvedPaymentsSwitch {
- resolvePaymentsSwitchByKey | src/config/agenticPaymentsModes.ts:255 | export function resolvePaymentsSwitchByKey(
- resolveApiIngressMode | src/config/apiIngressModes.ts:82 | export function resolveApiIngressMode(
- resolveHttpDeliveryMode | src/config/asyncJobModes.ts:185 | export function resolveHttpDeliveryMode(
- resolveChatNlqMode | src/config/chatNlqModes.ts:245 | export function resolveChatNlqMode(levels: ChatNlqModeScopeLevels): ResolvedChatNlqMode {
- resolveChatNlqTurnMode | src/config/chatNlqModes.ts:275 | export function resolveChatNlqTurnMode(context: {
- resolveEtradeScanMode | src/config/etradeModes.ts:209 | export function resolveEtradeScanMode(levels: EtradeModeScopeLevels, legacy: EtradeScanMode): ResolvedEtradeSwitch<EtradeScanMode> {
- resolveEtradeQuoteMode | src/config/etradeModes.ts:213 | export function resolveEtradeQuoteMode(levels: EtradeModeScopeLevels, legacy: EtradeQuoteMode): ResolvedEtradeSwitch<EtradeQuoteMode> {
- resolveEtradePreviewMode | src/config/etradeModes.ts:217 | export function resolveEtradePreviewMode(levels: EtradeModeScopeLevels, legacy: EtradePreviewMode): ResolvedEtradeSwitch<EtradePreviewMode> {
- resolveEtradePositionsMode | src/config/etradeModes.ts:221 | export function resolveEtradePositionsMode(levels: EtradeModeScopeLevels, legacy: EtradePositionsMode): ResolvedEtradeSwitch<EtradePositionsMode> {
- resolveEtradeStatusMode | src/config/etradeModes.ts:225 | export function resolveEtradeStatusMode(levels: EtradeModeScopeLevels, legacy: EtradeStatusMode): ResolvedEtradeSwitch<EtradeStatusMode> {
- resolveEtradeDiscoveryMode | src/config/etradeModes.ts:229 | export function resolveEtradeDiscoveryMode(levels: EtradeModeScopeLevels, legacy: EtradeDiscoveryMode): ResolvedEtradeSwitch<EtradeDiscoveryMode> {
- resolveEtradeRestSwitch | src/config/etradeModes.ts:254 | export function resolveEtradeRestSwitch( — impl; 6 overload signatures at lines 248–253, collapsed
- resolveGoalCompileMode | src/config/goalChainModes.ts:208 | export function resolveGoalCompileMode(
- resolveKnowledgeMode | src/config/knowledgeMemoryModes.ts:181 | export function resolveKnowledgeMode(
- resolveMemoryReadMode | src/config/knowledgeMemoryModes.ts:222 | export function resolveMemoryReadMode(
- resolveMarketDataQuoteMode | src/config/marketDataModes.ts:306 | export function resolveMarketDataQuoteMode(levels: MarketDataModeScopeLevels, legacy: MarketDataQuoteMode): ResolvedMarketDataSwitch<MarketDataQuoteMode> {
- resolveMarketDataFundamentalsMode | src/config/marketDataModes.ts:310 | export function resolveMarketDataFundamentalsMode(
- resolveMarketDataResearchMode | src/config/marketDataModes.ts:317 | export function resolveMarketDataResearchMode(
- resolveMarketDataBarsMode | src/config/marketDataModes.ts:324 | export function resolveMarketDataBarsMode(levels: MarketDataModeScopeLevels, legacy: MarketDataBarsMode): ResolvedMarketDataSwitch<MarketDataBarsMode> {
- resolveMarketDataSnapshotMode | src/config/marketDataModes.ts:328 | export function resolveMarketDataSnapshotMode(
- resolveAlpacaReadsMode | src/config/marketDataModes.ts:335 | export function resolveAlpacaReadsMode(
- resolveAlpacaOrderMode | src/config/marketDataModes.ts:348 | export function resolveAlpacaOrderMode(
- resolveMarketDataRestSwitch | src/config/marketDataModes.ts:385 | export function resolveMarketDataRestSwitch( — impl; 7 overload signatures at lines 378–384, collapsed
- resolveNlqMode | src/config/nlqModes.ts:153 | export function resolveNlqMode(levels: NlqModeScopeLevels): ResolvedNlqMode {
- resolvePaymentsFlowModeScoped | src/config/paymentsFlowModes.ts:132 | export function resolvePaymentsFlowModeScoped(
- resolvePrivacyModeScoped | src/config/privacyModes.ts:76 | export function resolvePrivacyModeScoped(
- resolveQuoteExpiryMode | src/config/quoteModes.ts:260 | export function resolveQuoteExpiryMode(levels: QuoteScopeLevels, legacy: QuoteExpiryMode): ResolvedQuoteSwitch
- resolveQuoteHttpProviderMode | src/config/quoteModes.ts:271 | export function resolveQuoteHttpProviderMode(
- resolveQuoteAlpacaKeyMode | src/config/quoteModes.ts:278 | export function resolveQuoteAlpacaKeyMode(
- resolveQuoteFallbackMode | src/config/quoteModes.ts:285 | export function resolveQuoteFallbackMode(
- resolveQuoteEtradeUnknownMode | src/config/quoteModes.ts:292 | export function resolveQuoteEtradeUnknownMode(
- resolveQuoteYahooOpenMode | src/config/quoteModes.ts:299 | export function resolveQuoteYahooOpenMode(
- resolveQuoteYahooIndicatorsMode | src/config/quoteModes.ts:306 | export function resolveQuoteYahooIndicatorsMode(
- resolveResearchStageModes | src/config/researchJobConfig.ts:143 | export function resolveResearchStageModes(
- resolveAuditWriteMode | src/config/restTwinsModes.ts:153 | export function resolveAuditWriteMode(
- resolveAuditWriteRestSwitch | src/config/restTwinsModes.ts:209 | export function resolveAuditWriteRestSwitch(
- resolveSchemaMigrationMode | src/config/schemaMigrationModes.ts:107 | export function resolveSchemaMigrationMode(
- resolveSchemaMigrationModeFromEnv | src/config/schemaMigrationModes.ts:136 | export function resolveSchemaMigrationModeFromEnv(env?: {
- resolveScreenerDefaultExecutionMode | src/config/screenerExecutionMode.ts:37 | export function resolveScreenerDefaultExecutionMode(
- resolveAgenticPaymentsCommandMode | src/mcps/openaimp/agenticPaymentCommands.ts:38 | function resolveAgenticPaymentsCommandMode(
- resolveCommandMode | src/mcps/openaimp/commands.ts:284 | function resolveCommandMode(
- resolvePaymentsCommandMode | src/mcps/openaimp/commands.ts:318 | function resolvePaymentsCommandMode(
- resolveNlqCommandMode | src/mcps/openaimp/commands.ts:1045 | function resolveNlqCommandMode(
- resolvePrivacyDsarMode | src/privacy/privacyDsar.ts:54 | export function resolvePrivacyDsarMode(envValue: unknown): {
- resolveAgentAccessMode | src/security/agentAccess.ts:1189 | export function resolveAgentAccessMode(
- resolveMembershipIndexRepairMode | src/security/iaaaMembershipStore.ts:221 | export function resolveMembershipIndexRepairMode(
- resolveStaleCleanupMode | src/security/iaaaStaleCleanup.ts:96 | export function resolveStaleCleanupMode(raw: string | undefined): StaleCleanupMode {
- resolveFundamentalsJoinMode | src/services/enrichJobs.ts:349 | export function resolveFundamentalsJoinMode(
- resolveTechnicalsJoinMode | src/services/enrichJobs.ts:367 | export function resolveTechnicalsJoinMode(
- resolveSentimentJoinMode | src/services/enrichJobs.ts:388 | export function resolveSentimentJoinMode(
- resolveExecutionMode | src/services/jobPipelineConfig.ts:133 | export function resolveExecutionMode(raw: unknown): JobExecutionMode {
- resolveLedgerReadMode | src/services/runLedgerReads.ts:41 | export async function resolveLedgerReadMode(env: Partial<Env>): Promise<RunLedgerReadMode> {
- resolveScheduledEffectiveMode | src/services/scheduledEffectiveMode.ts:63 | export async function resolveScheduledEffectiveMode(args: {
- resolveDiscoveryRunMode | src/services/scheduledTasks.ts:531 | async function resolveDiscoveryRunMode(
- resolveCopilotExecutionMode | src/services/stockCopilotExecutionMode.ts:33 | export function resolveCopilotExecutionMode(opts?: {
- resolveRequestedStockCopilotRsiMode | src/services/stockCopilotRsiMode.ts:51 | function resolveRequestedStockCopilotRsiMode(opts?: {
- resolveStockCopilotRsiModeState | src/services/stockCopilotRsiMode.ts:83 | export function resolveStockCopilotRsiModeState(opts?: {
- resolveStockCopilotRsiMode | src/services/stockCopilotRsiMode.ts:95 | export function resolveStockCopilotRsiMode(opts?: {
- resolveStrategyMode | src/trading/options/strategyChoice.ts:54 | export function resolveStrategyMode(input: {

### B — tenant/broker/provider/platform (51)

- resolvePromptBrokerTools | src/agents/chatPrompt.ts:211 | export function resolvePromptBrokerTools(
- resolveSubmissionTenant | src/agents/orchestrator/asyncJobs.ts:418 | async function resolveSubmissionTenant(env: Env, userLogin: string): Promise<string | null> {
- resolveBackfillTenant | src/agents/orchestrator/usageEventsReconcile.ts:143 | export async function resolveBackfillTenant(args: {
- resolveBrokerEnvironment | src/agents/routes/brokerEnvironment.ts:46 | export function resolveBrokerEnvironment(stored: string | null | undefined): BrokerEnvironment {
- resolveBrokerEnvironmentDefault | src/agents/routes/brokerEnvironment.ts:57 | export function resolveBrokerEnvironmentDefault(_workerEnv: Partial<Env>): BrokerEnvironment {
- resolveBrokerEnvironmentFromSettings | src/agents/routes/brokerEnvironment.ts:65 | export function resolveBrokerEnvironmentFromSettings(
- resolveLoginsForTenant | src/agents/routes/dataLifecycle.ts:961 | async function resolveLoginsForTenant(
- resolveChannelDisposition | src/agents/social/config.ts:105 | export function resolveChannelDisposition(
- resolveSocialSlackChannel | src/agents/social/delivery.ts:68 | export function resolveSocialSlackChannel(env: SlackDeliveryEnv): string | undefined {
- resolveTradingPlatform | src/agents/trading-agent.ts:441 | export function resolveTradingPlatform(
- resolveInitialScreeningProviderId | src/client/screeningAdapters.ts:155 | export function resolveInitialScreeningProviderId(
- resolveProviderDataset | src/config/vocabulary.ts:482 | export function resolveProviderDataset(
- resolveAndVerifyPublisherSlackChannel | src/events/screenerPublishers.ts:129 | async function resolveAndVerifyPublisherSlackChannel(
- resolveScheduleChannelState | src/features/scheduleChannelFlags.ts:82 | export async function resolveScheduleChannelState(
- resolveScheduleChannelFlagsView | src/features/scheduleChannelFlags.ts:241 | export async function resolveScheduleChannelFlagsView(
- resolveSelectedAlpacaPlatform | src/mcps/openaimp/cancelOrderCommands.ts:124 | async function resolveSelectedAlpacaPlatform(context: McpToolContext) {
- resolvePlatformId | src/security/attributionEnvelope.ts:92 | export function resolvePlatformId(envValue?: string | null): string {
- resolveIaaaTenant | src/security/iaaaGithubEndToEnd.ts:164 | export function resolveIaaaTenant(
- resolveProviderBinding | src/security/iaaaLogin.ts:321 | export async function resolveProviderBinding(
- resolveBrokerFacts | src/security/platformContext.ts:246 | async function resolveBrokerFacts(
- resolvePlatformContext | src/security/platformContext.ts:272 | export async function resolvePlatformContext(
- resolveLoginProvider | src/security/providers.ts:332 | export function resolveLoginProvider(
- resolveTenantLogins | src/security/tenantQueueMapping.ts:106 | export async function resolveTenantLogins(
- resolveAccountTenantId | src/services/accountTenant.ts:25 | export async function resolveAccountTenantId(
- resolveAgentScheduleTenant | src/services/agentScheduleCapability.ts:479 | export function resolveAgentScheduleTenant(env: Env): string {
- resolveEnvChannelRecipientBinding | src/services/channelRecipientVerification.ts:164 | export function resolveEnvChannelRecipientBinding(
- resolveTenantOwnerEmailBinding | src/services/channelRecipientVerification.ts:344 | export async function resolveTenantOwnerEmailBinding(input: {
- resolveCopilotChannel | src/services/copilotChannels.ts:313 | export function resolveCopilotChannel(deps: {
- resolveCopilotChannels | src/services/copilotChannels.ts:337 | export function resolveCopilotChannels(deps: {
- resolveChannelsKnob | src/services/deliverJobs.ts:482 | function resolveChannelsKnob(
- resolveTenantProviderContext | src/services/optionsProviderContext.ts:131 | export function resolveTenantProviderContext(input?: {
- resolveTickTenant | src/services/paidScreenSubmission.ts:283 | export async function resolveTickTenant(
- resolveEffectiveTenantId | src/services/platformIdentity.ts:78 | export function resolveEffectiveTenantId(
- resolveCurrentTenant | src/services/platformIdentity.ts:137 | export function resolveCurrentTenant(input: {
- resolvePlatformIdentity | src/services/platformIdentity.ts:224 | export async function resolvePlatformIdentity(
- resolveRunBrokerContext | src/services/runBrokerContext.ts:86 | export async function resolveRunBrokerContext(input: ResolveRunBrokerContextInput): Promise<RunBrokerContext>
- resolveScheduledStockProvider | src/services/scheduledTasks.ts:497 | export function resolveScheduledStockProvider(
- resolveTenantChannelGate | src/services/tenantChannelGate.ts:108 | export async function resolveTenantChannelGate(
- resolveTenantCredentials | src/services/tenantCredentialStore.ts:369 | export async function resolveTenantCredentials(
- resolveTenantProviders | src/services/tenantProviders.ts:111 | export async function resolveTenantProviders(env: unknown): Promise<TenantProviders> {
- resolveTenantBrokerSelection | src/services/tenantProviders.ts:132 | export async function resolveTenantBrokerSelection(env: unknown): Promise<BrokerId | null> {
- resolveTenantBroker | src/services/tenantProviders.ts:169 | export async function resolveTenantBroker(env: unknown): Promise<BrokerId> {
- resolveTenantDataProviderSelection | src/services/tenantProviders.ts:189 | export async function resolveTenantDataProviderSelection(env: unknown): Promise<string | null> {
- resolveEffectiveTenantProviders | src/services/tenantProviders.ts:306 | export async function resolveEffectiveTenantProviders(env: unknown): Promise<TenantProviders> {
- resolveScreenProviderForRun | src/services/tenantProviders.ts:325 | export async function resolveScreenProviderForRun(env: unknown): Promise<StockScreenProvider | null> {
- resolveManualScreenProviders | src/services/tenantProviders.ts:344 | export async function resolveManualScreenProviders(
- resolveWebSearchProvider | src/services/webSearch.ts:599 | export function resolveWebSearchProvider(env: WebSearchEnv): WebSearchProvider {
- resolveBrokerSelection | src/trading/brokerCatalog.ts:603 | export function resolveBrokerSelection(input: {
- resolveNoSelectionBroker | src/trading/channelBroker.ts:62 | export function resolveNoSelectionBroker(
- resolveChannelBroker | src/trading/channelBroker.ts:113 | export async function resolveChannelBroker(env: unknown, override?: unknown): Promise<ChannelBroker> {
- resolveYahooHistoryProvider | src/trading/platformHistory.ts:124 | export async function resolveYahooHistoryProvider(args: {

### C — config/env/policy/payment knob (114)

- resolveMasMaxSteps | src/agents/chatPrompt.ts:376 | export function resolveMasMaxSteps(env: Partial<Env>): number {
- resolveShadowMaxSteps | src/agents/chatPrompt.ts:386 | export function resolveShadowMaxSteps(env: Partial<Env>): number {
- resolveAsyncJobMaxRuntimeMs | src/agents/orchestrator/asyncJobs.ts:1517 | export function resolveAsyncJobMaxRuntimeMs(env: Record<string, unknown>): number {
- resolveChatAwaitDeadlineMs | src/agents/orchestrator/chatAwaitBudget.ts:78 | export function resolveChatAwaitDeadlineMs(
- resolveChatAwaitPollMs | src/agents/orchestrator/chatAwaitBudget.ts:99 | export function resolveChatAwaitPollMs(
- resolveEmailTier | src/agents/routes/agenticPayments.ts:1150 | const resolveEmailTier = async (userId: string): Promise<StoreTier> => {
- resolvePrice | src/agents/routes/agenticPayments.ts:8677 | const resolvePrice = async (): Promise<number | null> => {
- resolveEnvironmentFor | src/agents/routes/brokerConnect.ts:299 | function resolveEnvironmentFor(
- resolveSharedTradingEnvironment | src/agents/routes/brokerEnvironment.ts:91 | export function resolveSharedTradingEnvironment(
- createMeterTierResolver | src/agents/routes/meter.ts:82 | export function createMeterTierResolver(
- resolvePremiumTier | src/agents/routes/premium.ts:339 | async function resolvePremiumTier(env: Env, userLogin: string): Promise<StoreTier | null> {
- resolveTickerPushStaleAfterIntervals | src/agents/ticker-agent.ts:132 | export function resolveTickerPushStaleAfterIntervals(env: Env | undefined): number {
- resolveTickerPushIntervalSeconds | src/agents/ticker-agent.ts:147 | export function resolveTickerPushIntervalSeconds(env: Env | undefined): number {
- resolveBreakerPolicyFor | src/breakers/breakerPorts.ts:224 | export function resolveBreakerPolicyFor(
- resolvePollingConfig | src/client/pollingConfig.ts:139 | export function resolvePollingConfig(raw?: Record<string, unknown> | null): PollingConfig {
- resolvePollingConfigFromEnv | src/client/pollingConfig.ts:155 | export function resolvePollingConfigFromEnv(
- resolveAnalyticsLakeConfig | src/config/analyticsLakeConfig.ts:74 | export function resolveAnalyticsLakeConfig(env: unknown): AnalyticsLakeConfig {
- resolveJobListEnvelope | src/config/asyncJobModes.ts:227 | export function resolveJobListEnvelope(
- resolveDlqDepthAlertThreshold | src/config/dlqDepthAlert.ts:15 | export function resolveDlqDepthAlertThreshold(env: Record<string, unknown>): number {
- resolveEnvironmentConfig | src/config/environment.ts:102 | export function resolveEnvironmentConfig(env?: Partial<Env>, overrideEnv?: string): ResolvedEnvironment {
- resolveHeartbeatIntervalSeconds | src/config/heartbeatWatchdog.ts:86 | export function resolveHeartbeatIntervalSeconds(
- resolveHeartbeatWatchdogStaleAfterMs | src/config/heartbeatWatchdog.ts:103 | export function resolveHeartbeatWatchdogStaleAfterMs(
- resolveHeartbeatWatchdogConfig | src/config/heartbeatWatchdog.ts:122 | export function resolveHeartbeatWatchdogConfig(
- resolveHeartbeatDueCheckConfig | src/config/heartbeatWatchdog.ts:182 | export function resolveHeartbeatDueCheckConfig(
- resolveParameter | src/config/jobDefinitionCatalog.ts:652 | function resolveParameter(raw: unknown, specId: string): JobDefinitionParameter {
- resolveEnumSource | src/config/jobDefinitionParamRegistry.ts:43 | export function resolveEnumSource(name: string, specId: string): string[] {
- resolveMissedScheduleGraceMs | src/config/missedScheduleAlert.ts:37 | export function resolveMissedScheduleGraceMs(env: MissedScheduleGraceEnv): number {
- resolveOtelMetricsSettings | src/config/otelModes.ts:910 | export function resolveOtelMetricsSettings(
- resolveOtelTracesSettings | src/config/otelModes.ts:993 | export function resolveOtelTracesSettings(
- resolveOtelBackendSettings | src/config/otelModes.ts:1054 | export function resolveOtelBackendSettings(
- resolveOtelArchiveSettings | src/config/otelModes.ts:1155 | export function resolveOtelArchiveSettings(
- resolveOtelAlertingSettings | src/config/otelModes.ts:1218 | export function resolveOtelAlertingSettings(
- resolveResearchStageTimeouts | src/config/researchJobConfig.ts:312 | export function resolveResearchStageTimeouts(
- resolveResearchStageRetryBuckets | src/config/researchJobConfig.ts:321 | export function resolveResearchStageRetryBuckets(
- resolveResearchSettlementWaitMs | src/config/researchJobConfig.ts:397 | export function resolveResearchSettlementWaitMs(
- resolveResearchJobConfig | src/config/researchJobConfig.ts:463 | export function resolveResearchJobConfig(
- resolveScheduledJobAlertThreshold | src/config/scheduledJobAlert.ts:16 | export function resolveScheduledJobAlertThreshold(env: Record<string, unknown>): number {
- resolveScreenerNdGate | src/config/screenerModes.ts:191 | export function resolveScreenerNdGate(envValue: unknown): ResolvedScreenerNdGate {
- resolveScreenerNdGateFromEnv | src/config/screenerModes.ts:202 | export function resolveScreenerNdGateFromEnv(env: unknown): ResolvedScreenerNdGate {
- resolveScreenerNdGateResolved | src/config/screenerModes.ts:217 | export function resolveScreenerNdGateResolved(deps: {
- resolveScreenerNdGateForHost | src/config/screenerModes.ts:249 | export function resolveScreenerNdGateForHost(deps: {
- resolveIdleTimeoutMs | src/config/sessionLimits.ts:65 | export function resolveIdleTimeoutMs(
- resolveSessionStoreConfig | src/config/sessionStoreConfig.ts:93 | export function resolveSessionStoreConfig(raw: unknown): {
- resolveSloThresholds | src/config/sloThresholds.ts:133 | export function resolveSloThresholds(
- resolveStuckRunAlertThresholdMs | src/config/stuckRunAlert.ts:35 | export function resolveStuckRunAlertThresholdMs(env: StuckRunAlertEnv): number {
- resolveTurnStepTimeoutMs | src/config/turnStepTimeout.ts:80 | export function resolveTurnStepTimeoutMs(stored: unknown, tenantId = "primary"): number {
- resolveWorkflowRunsStageReadLimit | src/config/workflowRunsStageRead.ts:25 | export function resolveWorkflowRunsStageReadLimit(
- resolveAuditPolicy | src/data/auditPolicyPorts.ts:253 | export async function resolveAuditPolicy(port: AuditPolicyPort): Promise<AuditPolicy> {
- resolveUnlimitedFreeGrantUpdate | src/data/commercialPorts.ts:110 | export function resolveUnlimitedFreeGrantUpdate(
- resolveD1QueryLoggerPolicy | src/data/d1QueryLogger.ts:80 | export function resolveD1QueryLoggerPolicy(
- resolveD1RetryPolicy | src/data/d1RetryPolicy.ts:156 | export function resolveD1RetryPolicy(
- resolveProductPrice | src/data/productCatalogue.ts:150 | export function resolveProductPrice(
- resolveEffectiveTier | src/data/subscriptionPorts.ts:334 | export function resolveEffectiveTier(
- resolveTierTransition | src/data/subscriptionPorts.ts:372 | export function resolveTierTransition(
- resolveGatewayConfig | src/gateway/gatewayConfig.ts:36 | export function resolveGatewayConfig(env: GatewayEnvLike): GatewayConfig {
- resolveRequestedEnv | src/mcps/openaimp/brokerOrderCommands.ts:315 | async function resolveRequestedEnv(context: McpToolContext) {
- resolveJobListEnvelopeForTool | src/mcps/openaimp/commands.ts:438 | function resolveJobListEnvelopeForTool(
- resolveOtelMetricsConfig | src/observability/otelMetricsProvider.ts:97 | export function resolveOtelMetricsConfig(
- resolveOtelLoggingConfig | src/observability/otelProvider.ts:97 | export function resolveOtelLoggingConfig(
- resolveOtelTracesConfig | src/observability/otelTracesProvider.ts:95 | export function resolveOtelTracesConfig(
- resolveAttributionEnvelope | src/security/attributionEnvelope.ts:108 | export function resolveAttributionEnvelope(
- resolveGrantDefaultExpiryDays | src/security/grantRules.ts:76 | export function resolveGrantDefaultExpiryDays(
- resolveWiredFreshnessMs | src/security/iaaaEnforcement.ts:163 | export function resolveWiredFreshnessMs(
- resolveOutboundRateLimitConfig | src/security/outboundRateLimiter.ts:106 | export function resolveOutboundRateLimitConfig(
- resolvePayerWalletIdentity | src/security/payerWalletIdentity.ts:47 | export async function resolvePayerWalletIdentity(input: {
- resolvePdpPolicySource | src/security/pdpPorts.ts:167 | export function resolvePdpPolicySource(
- resolveRetentionWindowDays | src/security/storageRetention.ts:318 | export function resolveRetentionWindowDays(
- resolveRetentionDays | src/security/storageRetention.ts:333 | export function resolveRetentionDays(
- resolveScheduleWebhookIdempotencyTtlMs | src/security/webhookReplay.ts:93 | export function resolveScheduleWebhookIdempotencyTtlMs(value: unknown): number {
- resolveReadThresholds | src/server/routes/otelSlo.ts:98 | async function resolveReadThresholds(
- resolveAdsTier | src/services/adsTier.ts:27 | export function resolveAdsTier(tierAttribute: string | undefined | null): AdsTier {
- resolveServerAdsConfig | src/services/adsTier.ts:52 | export function resolveServerAdsConfig(
- resolveAgentConfig | src/services/agentConfigResolver.ts:340 | export function resolveAgentConfig(
- resolveAiSearchCacheConfig | src/services/aiSearchCache.ts:36 | export function resolveAiSearchCacheConfig(env?: unknown): AiSearchCacheConfig {
- resolveAnalyzeThresholds | src/services/analyzeJobs.ts:235 | export function resolveAnalyzeThresholds(
- resolveRuleSetsKnob | src/services/analyzeJobs.ts:364 | function resolveRuleSetsKnob(
- resolveAutopilotVerdictTrendPolicy | src/services/autopilotVerdictTrend.ts:58 | export function resolveAutopilotVerdictTrendPolicy(
- resolveBrowserPaymentScope | src/services/checkoutDisplay.ts:57 | export function resolveBrowserPaymentScope(raw: unknown): BrowserPaymentScope {
- resolveCheckoutPortTimeoutMs | src/services/checkoutPortGuard.ts:114 | export function resolveCheckoutPortTimeoutMs(
- resolveStringKnob | src/services/deliverJobs.ts:473 | function resolveStringKnob(
- resolveElementsKnob | src/services/enrichJobs.ts:328 | function resolveElementsKnob(
- resolveFeedJobTimeoutMs | src/services/feedJobTimeouts.ts:110 | export function resolveFeedJobTimeoutMs(
- resolveFeedJobTimeouts | src/services/feedJobTimeouts.ts:133 | export function resolveFeedJobTimeouts(
- resolveFeedJobCadenceMinutes | src/services/feedJobs.ts:275 | export function resolveFeedJobCadenceMinutes(
- resolveFeedJobStaleMinutes | src/services/feedJobs.ts:283 | export function resolveFeedJobStaleMinutes(
- resolveListKnob | src/services/generateJobs.ts:334 | function resolveListKnob(
- resolveOwnerLoginKnob | src/services/generateJobs.ts:348 | function resolveOwnerLoginKnob(
- resolveFeedExecutionDeadlineMs | src/services/jobPipelineEngine.ts:154 | export function resolveFeedExecutionDeadlineMs(
- resolveJudgeScoreFeedbackPolicy | src/services/judgeScoreFeedback.ts:71 | export function resolveJudgeScoreFeedbackPolicy(
- resolveMemoryConsolidationPolicy | src/services/memoryConsolidation.ts:101 | export function resolveMemoryConsolidationPolicy(
- resolveMeteredTier | src/services/meteredPaymentGate.ts:94 | export async function resolveMeteredTier(
- resolveFetchTimeoutMs | src/services/pipelinePolicy.ts:248 | export function resolveFetchTimeoutMs(
- resolvePipelinePolicy | src/services/pipelinePolicy.ts:267 | export function resolvePipelinePolicy(
- resolveTier | src/services/provisioningWelcome.ts:86 | async function resolveTier(env: UnknownEnv, userId: string): Promise<StoreTier> {
- resolveMeterProvenance | src/services/receiptSurface.ts:154 | export function resolveMeterProvenance(protocol: string | null): {
- resolveGatewayProvenance | src/services/receiptSurface.ts:170 | export function resolveGatewayProvenance(row: {
- createPayPerRunPaymentResolver | src/services/refundPaymentIntent.ts:91 | export function createPayPerRunPaymentResolver(
- createBundlePaymentResolver | src/services/refundPaymentIntent.ts:145 | export function createBundlePaymentResolver(
- createSubscriptionPaymentResolver | src/services/refundService.ts:126 | export function createSubscriptionPaymentResolver(subs: SubscriptionStore): RefundPaymentSourceResolver {
- resolveDeliveryGate | src/services/screenerFollowupDelivery.ts:77 | async function resolveDeliveryGate(
- resolveScreenerFollowupConfig | src/services/screenerFollowups.ts:223 | export function resolveScreenerFollowupConfig(
- resolveStageTimeoutMs | src/services/stageTimeouts.ts:50 | export function resolveStageTimeoutMs(env: Record<string, unknown> = {}): number {
- resolveStageTimeoutMsForNode | src/services/stageTimeouts.ts:80 | export function resolveStageTimeoutMsForNode(
- resolveGoalScreenAwaitDeadlineMs | src/services/stageTimeouts.ts:111 | export function resolveGoalScreenAwaitDeadlineMs(env: Record<string, unknown> = {}): number {
- resolveStockScreenAwaitDeadlineMs | src/services/stageTimeouts.ts:120 | export function resolveStockScreenAwaitDeadlineMs(env: Record<string, unknown> = {}): number {
- resolveCopilotCadence | src/services/stockCopilotCadence.ts:76 | export function resolveCopilotCadence(deps: {
- resolveCopilotLearningPolicyThresholds | src/services/stockCopilotLearningPolicy.ts:90 | export function resolveCopilotLearningPolicyThresholds(
- resolveRefundProvenance | src/services/usageBillingSurface.ts:108 | export function resolveRefundProvenance(row: RefundRecord): {
- resolveTradingLimits | src/trading/limits.ts:215 | export function resolveTradingLimits(input: {
- resolveDiscoveryFitGate | src/trading/options/discoveryExpression.ts:99 | export function resolveDiscoveryFitGate(
- resolveScreenerPdfSectionConfig | src/trading/screenerReportTemplate.ts:183 | export function resolveScreenerPdfSectionConfig(
- resolveStageConfig | src/workflows/stageConfig.ts:128 | export function resolveStageConfig(env: StageConfigEnv = {}): StageConfig {
- resolveStageRetryBudget | src/workflows/stageRunnerPorts.ts:315 | export function resolveStageRetryBudget(
- resolveUniverseDepsFromStageInput | src/workflows/universeDepsResidency.ts:82 | export async function resolveUniverseDepsFromStageInput(

### D — user/account/identity/binding (28)

- resolveAgentDidDocument | src/agents/did.ts:86 | export function resolveAgentDidDocument(did: string): AgentDidDocument {
- resolveStockCopilotActiveBinding | src/agents/orchestrator/meshStockCopilotDoor.ts:433 | export async function resolveStockCopilotActiveBinding(
- resolveScheduledLogin | src/agents/orchestrator/scheduleMaintenance.ts:77 | export function resolveScheduledLogin(
- resolveTrustedScheduleIdentity | src/agents/routes/schedules.ts:433 | export function resolveTrustedScheduleIdentity(input: {
- resolveTokenServiceLogin | src/agents/routes/serviceUser.ts:538 | function resolveTokenServiceLogin(ctx: ServiceUserRouteContext): string | null {
- resolveServiceLoginForEtrade | src/agents/routes/serviceUser.ts:732 | function resolveServiceLoginForEtrade(
- resolveSnapIdentity | src/config/restTwinsModes.ts:307 | export function resolveSnapIdentity(
- resolveCaptureUserLogin | src/data/providerCapturePorts.ts:208 | export function resolveCaptureUserLogin(
- resolveAliasLogin | src/security/etradeOAuth.ts:119 | async function resolveAliasLogin(
- resolveEntryUserId | src/security/iaaaGithubEndToEnd.ts:500 | async function resolveEntryUserId(
- resolveGithubBinding | src/security/iaaaLogin.ts:362 | export async function resolveGithubBinding(
- resolveDoNameForUser | src/security/iaaaMigration.ts:475 | export async function resolveDoNameForUser(
- resolveOrCreateBinding | src/security/identityBinding.ts:220 | export async function resolveOrCreateBinding(
- resolveLogins | src/security/identityDisplay.ts:40 | export async function resolveLogins(
- resolveIdentityFacts | src/security/platformContext.ts:226 | async function resolveIdentityFacts(
- resolveDispatchCandidate | src/security/serviceDispatch.ts:146 | export function resolveDispatchCandidate(
- resolveAsyncJobIdentity | src/security/serviceDispatch.ts:169 | export function resolveAsyncJobIdentity(
- resolveUserRequestQuota | src/security/userRequestQuota.ts:104 | export function resolveUserRequestQuota(
- resolveUserAccountBinding | src/services/accountBindings.ts:125 | export async function resolveUserAccountBinding(
- resolveExecutionAccountTuple | src/services/accountBindings.ts:385 | export async function resolveExecutionAccountTuple(
- resolveExecutionAccountContext | src/services/accountBindings.ts:520 | export async function resolveExecutionAccountContext(
- resolveValidatedExecutionAccountContext | src/services/accountBindings.ts:619 | export async function resolveValidatedExecutionAccountContext(
- resolveScheduleBindingDefaults | src/services/accountBindings.ts:738 | export async function resolveScheduleBindingDefaults(args: {
- resolveEtradeAuthorizerDid | src/services/etradeExecutionGate.ts:72 | export function resolveEtradeAuthorizerDid(sessionIdOrLogin: string): string {
- resolvePaidScreenAccount | src/services/paidScreenSubmission.ts:212 | export async function resolvePaidScreenAccount(
- resolveAccountId | src/services/publicData.ts:268 | async function resolveAccountId(
- resolveEffectiveAccountBinding | src/trading/accountBindings.ts:260 | export function resolveEffectiveAccountBinding(
- resolveAccountByLabel | src/trading/accountBindings.ts:709 | export function resolveAccountByLabel(

### E — job/pipeline/chain/stage/schedule (49)

- resolveChainAuthority | src/agentic/chainGovernance.ts:188 | export function resolveChainAuthority(
- resolveJobProvenance | src/agents/orchestrator/asyncJobs.ts:340 | export function resolveJobProvenance(job: AsyncJobSubmission): {
- resolveFeedDispatchJobId | src/agents/orchestrator/asyncJobs.ts:958 | function resolveFeedDispatchJobId(
- resolveFeedDispatchPipelineRunId | src/agents/orchestrator/asyncJobs.ts:1015 | async function resolveFeedDispatchPipelineRunId(
- resolveJobFailureCode | src/agents/orchestrator/asyncJobs.ts:1566 | export function resolveJobFailureCode(error: unknown): string {
- resolveScheduleFlagsCaller | src/agents/routes/schedules.ts:685 | async function resolveScheduleFlagsCaller(
- resolveStage | src/config/jobDefinitionCatalog.ts:443 | function resolveStage(raw: unknown, specId: string, path: string): JobStageSpec {
- resolveStageSchedule | src/config/jobDefinitionCatalog.ts:512 | function resolveStageSchedule(
- resolveJobDefinitionSpec | src/config/jobDefinitionCatalog.ts:542 | export function resolveJobDefinitionSpec(raw: unknown): JobDefinitionSpec {
- resolveScheduleListStatusFilters | src/config/scheduleListModes.ts:91 | export function resolveScheduleListStatusFilters(
- resolveScheduleListFilters | src/config/scheduleListModes.ts:145 | export function resolveScheduleListFilters(
- resolveScheduleListDefaultFilter | src/config/scheduleListModes.ts:156 | export function resolveScheduleListDefaultFilter(
- resolveScheduleRowColumns | src/config/scheduleRowModes.ts:119 | export function resolveScheduleRowColumns(
- resolveGoalScheduleSections | src/config/scheduleSections.ts:148 | export function resolveGoalScheduleSections(
- resolveGoalScheduleDefaultSection | src/config/scheduleSections.ts:159 | export function resolveGoalScheduleDefaultSection(
- resolveQueueScheduleSections | src/config/scheduleSections.ts:172 | export function resolveQueueScheduleSections(
- resolveQueueScheduleDefaultSection | src/config/scheduleSections.ts:183 | export function resolveQueueScheduleDefaultSection(
- resolveScheduleSourceFilters | src/config/scheduleSourceModes.ts:143 | export function resolveScheduleSourceFilters(
- resolveJobSubset | src/config/vocabulary.ts:414 | export function resolveJobSubset(
- resolveLinkedJobRunId | src/data/runLedgerProjection.ts:92 | export function resolveLinkedJobRunId(
- resolveJobPipelineControlObservers | src/observability/otelJobPipelineObservers.ts:190 | export function resolveJobPipelineControlObservers(
- resolvePendingScheduleApproval | src/services/agentScheduleCapability.ts:529 | export function resolvePendingScheduleApproval(
- resolveAnalyzeJob | src/services/analyzePipelineJobs.ts:141 | export function resolveAnalyzeJob(
- resolveAnalyzeStepJob | src/services/analyzePipelineJobs.ts:278 | function resolveAnalyzeStepJob(
- resolveEnrichJob | src/services/enrichPipelineJobs.ts:162 | export function resolveEnrichJob(
- resolveDeliverJob | src/services/deliverPipelineJobs.ts:152 | export function resolveDeliverJob(
- resolveFeedJob | src/services/feedPipelineJobs.ts:360 | export function resolveFeedJob( — id/alias → job definition; 63 mentions
- resolveGenerateJob | src/services/generatePipelineJobs.ts:139 | export function resolveGenerateJob(
- resolvePipelineChain | src/services/chainPipelineJobs.ts:168 | export function resolvePipelineChain(
- resolveCronEntryPoint | src/services/consolidatedCronEntries.ts:125 | export function resolveCronEntryPoint(
- resolveSchedule | src/services/jobPipelineConfig.ts:176 | function resolveSchedule(raw: unknown): JobScheduleConfig {
- resolveJobDefinition | src/services/jobPipelineConfig.ts:342 | export function resolveJobDefinition(raw: unknown): JobDefinitionInput {
- resolveScheduleRunJobId | src/services/jobRunRecords.ts:315 | export function resolveScheduleRunJobId(
- resolveScheduleRunTrigger | src/services/jobRunRecords.ts:363 | export function resolveScheduleRunTrigger(payload: unknown): JobRunTrigger {
- resolveSubJob | src/services/jobStageStatus.ts:124 | export function resolveSubJob(
- resolveScheduleUpdate | src/services/scheduleManagement.deprecated.ts:113 | export function resolveScheduleUpdate( — deprecated file
- resolveScheduledFirerHostDispatch | src/services/scheduledTasks.ts:616 | export async function resolveScheduledFirerHostDispatch(
- resolveHttpJobChain | src/services/screenerFollowups.ts:924 | export function resolveHttpJobChain(
- resolveShardChainSource | src/services/shardExecutors.ts:179 | export async function resolveShardChainSource(
- resolveScheduleSource | src/services/unifiedScheduleManagement.ts:316 | export function resolveScheduleSource(input: ScheduleSourceInput): ScheduleSource {
- resolveScheduleUpdate | src/services/unifiedScheduleManagement.ts:2512 | export function resolveScheduleUpdate(
- resolveWebSearchChain | src/services/webSearch.ts:569 | export function resolveWebSearchChain(env: WebSearchEnv): WebSearchProvider[] {
- resolveScheduleBranch | src/services/workflowLifecycle.ts:449 | export function resolveScheduleBranch(event: {
- resolveStageNode | src/services/workflowStageSchedule.ts:53 | export function resolveStageNode(root: JobNodeConfig, nodePath: string): JobNodeConfig {
- resolveWorkflowStage | src/services/workflowStageSchedule.ts:172 | export async function resolveWorkflowStage(
- resolveChainSourceForRequest | src/workflows/brokerChainSourceResidency.ts:92 | export function resolveChainSourceForRequest( — 12 mentions
- resolveOptionsStageId | src/workflows/optionsScreenEngine.ts:408 | export function resolveOptionsStageId(params: unknown): OptionsPipelineStage {
- resolveScreenJobId | src/workflows/optionsStageControl.ts:300 | async function resolveScreenJobId(
- resolveWorkflowRunId | src/workflows/workflowInstanceSeam.ts:200 | export function resolveWorkflowRunId(

### F — routing/DI/registry/manifest (4)

- resolveAgentCapabilityManifest | src/actors/capabilityManifest.ts:532 | export function resolveAgentCapabilityManifest(
- resolveUnitDriver | src/agentic/unitDrivers.ts:281 | export function resolveUnitDriver(capabilityId: string): UnitDriver {
- resolveRouteId | src/client/routes.ts:125 | export function resolveRouteId(id: string): RouteId {
- resolveChallengerOutcome | src/services/championChallenger.ts:679 | export function resolveChallengerOutcome(

### G — generic duplicated helper (34)

- resolveCaller | src/agents/routes/adminTenantQueues.ts:104 | async function resolveCaller(
- resolveOperator | src/agents/routes/dataLifecycle.ts:327 | async function resolveOperator(
- resolveCaller | src/agents/routes/kvWipe.ts:139 | async function resolveCaller(
- resolvePorts | src/agents/routes/platformAccounts.ts:250 | function resolvePorts(ctx: PlatformAccountRouteContext): PlatformAccountPorts {
- resolveOperator | src/agents/routes/platformChannels.ts:154 | async function resolveOperator(
- resolveOperator | src/agents/routes/platformTenants.ts:183 | async function resolveOperator(
- resolvePorts | src/agents/routes/platformUsers.ts:182 | function resolvePorts(ctx: PlatformUsersRouteContext): {
- resolveCaller | src/agents/routes/serviceUser.ts:177 | export async function resolveCaller(
- resolveSwitch | src/config/agenticPaymentsModes.ts:182 | function resolveSwitch(
- resolveSwitch | src/config/etradeModes.ts:165 | function resolveSwitch<T extends string>(...)
- resolveSwitch | src/config/goalChainModes.ts:165 | function resolveSwitch<T extends string>(...)
- resolveSwitch | src/config/marketDataModes.ts:262 | function resolveSwitch<T extends string>(...)
- resolveOne | src/config/otelModes.ts:914 | const resolveOne = <T>(switchName, levels, normalize, builtin): T => { — local to resolveOtelMetricsSettings
- resolveOne | src/config/otelModes.ts:997 | const resolveOne = <T>(...) — local to resolveOtelLogsSettings
- resolveOne | src/config/otelModes.ts:1058 | const resolveOne = <T>(...) — local to resolveOtelTracesSettings
- resolveOne | src/config/otelModes.ts:1159 | const resolveOne = <T>(...) — local to resolveOtelBackendSettings
- resolveOne | src/config/otelModes.ts:1222 | const resolveOne = <T>(...) — local to resolveOtelAlertingSettings
- resolveSwitch | src/config/quoteModes.ts:217 | function resolveSwitch<T extends string>(...)
- resolveDays | src/data/doSqliteJobOutcomeAdapter.ts:55 | function resolveDays(value: number | string | null | undefined): number {
- resolveDays | src/data/inMemoryJobOutcomeAdapter.ts:27 | function resolveDays(value: number | string | null | undefined): number {
- resolveMinutesKnob | src/services/analyzeJobs.ts:352 | function resolveMinutesKnob(
- resolvePositiveInt | src/services/autopilotVerdictTrend.ts:43 | function resolvePositiveInt(raw: string | undefined, fallback: number): number {
- resolveBool | src/services/autopilotVerdictTrend.ts:50 | function resolveBool(raw: string | undefined, fallback: boolean): boolean {
- resolveMinutesKnob | src/services/deliverJobs.ts:461 | function resolveMinutesKnob(
- resolveMinutesKnob | src/services/enrichJobs.ts:316 | function resolveMinutesKnob(
- resolveMinutesKnob | src/services/feedJobs.ts:263 | function resolveMinutesKnob(
- resolveMinutesKnob | src/services/generateJobs.ts:322 | function resolveMinutesKnob(
- resolveInt | src/services/judgeScoreFeedback.ts:55 | function resolveInt(raw: string | undefined, fallback: number): number {
- resolveBool | src/services/judgeScoreFeedback.ts:62 | function resolveBool(raw: string | undefined, fallback: boolean): boolean {
- resolvePositiveInt | src/services/memoryConsolidation.ts:76 | function resolvePositiveInt(raw: string | undefined, fallback: number): number {
- resolveBool | src/services/memoryConsolidation.ts:83 | function resolveBool(raw: string | undefined, fallback: boolean): boolean {
- resolveMinutesKnob | src/services/pipelineChains.ts:169 | function resolveMinutesKnob(
- resolvePositiveInt | src/services/stockCopilotLearningPolicy.ts:69 | function resolvePositiveInt(raw: string | undefined, fallback: number): number {
- resolveBoolean | src/services/stockCopilotLearningPolicy.ts:76 | function resolveBoolean(raw: string | undefined, fallback: boolean): boolean {

### H — pipeline OrThrow wrapper (6)

- resolveFeedJobOrThrow | src/agents/orchestrator/meshDoors.ts:534 | function resolveFeedJobOrThrow(source: string) {
- resolveEnrichJobOrThrow | src/agents/orchestrator/meshDoors.ts:714 | function resolveEnrichJobOrThrow(source: string) {
- resolveAnalyzeJobOrThrow | src/agents/orchestrator/meshDoors.ts:838 | function resolveAnalyzeJobOrThrow(source: string) {
- resolveGenerateJobOrThrow | src/agents/orchestrator/meshDoors.ts:962 | function resolveGenerateJobOrThrow(source: string) {
- resolveDeliverJobOrThrow | src/agents/orchestrator/meshDoors.ts:1086 | function resolveDeliverJobOrThrow(source: string) {
- resolvePipelineChainOrThrow | src/agents/orchestrator/meshDoors.ts:1210 | function resolvePipelineChainOrThrow(source: string) {

### I — symbols/universe/scope (22)

- resolveScopeSymbols | src/agents/nlqOptionsStrategy.ts:1230 | async function resolveScopeSymbols(
- resolveTapeSymbols | src/client/quotes/symbolSetResolver.ts:88 | export function resolveTapeSymbols(
- resolveFeedSnapshotForSymbol | src/data/feedSnapshotPorts.ts:186 | export function resolveFeedSnapshotForSymbol(args: {
- resolveToolScope | src/mcps/openaimp/mcpPermissionPorts.ts:494 | export function resolveToolScope(toolName: string): McpScope | null {
- resolveScopesWithRoleAdapter | src/mcps/openaimp/mcpPermissionPorts.ts:595 | export async function resolveScopesWithRoleAdapter(
- resolveRunUniverse | src/services/feedJobs.ts:149 | export function resolveRunUniverse(
- resolveUniverseListWithHydration | src/services/feedJobs.ts:900 | async function resolveUniverseListWithHydration(
- resolveUniverseIndex | src/services/feedPipelineJobs.ts:1019 | export function resolveUniverseIndex(params: Record<string, unknown>): IndexId {
- resolveGoalStockLegSymbols | src/services/screenerPipelineJobs.ts:1583 | export function resolveGoalStockLegSymbols(
- resolveGoalOptionsLegSymbols | src/services/screenerPipelineJobs.ts:1621 | export function resolveGoalOptionsLegSymbols(
- resolveCopilotUniverse | src/services/stockCopilotConfiguration.ts:215 | export function resolveCopilotUniverse(opts?: {
- resolveCopilotUniverseFull | src/services/stockCopilotConfiguration.ts:275 | export async function resolveCopilotUniverseFull(opts?: {
- resolveCopilotUniversePreset | src/services/stockCopilotConfiguration.ts:367 | export function resolveCopilotUniversePreset(universe: readonly string[]): string | null {
- resolveDynamicFlowSymbols | src/trading/options/flows/flowService.ts:1702 | export async function resolveDynamicFlowSymbols(
- resolveTrackedSymbols | src/trading/options/ivCollector.ts:132 | export function resolveTrackedSymbols(
- resolveSymbol | src/trading/options/llmIdeas.ts:419 | const resolveSymbol = (symbol: string) => {
- resolveOptionsReportScope | src/trading/optionsReportScope.ts:325 | export function resolveOptionsReportScope(
- resolveStockSector | src/trading/screener.ts:42 | export function resolveStockSector(symbol: string, companyName?: string, rawSector?: string): string | undefined {
- resolveAllListings | src/trading/screenerPipeline.ts:805 | async function resolveAllListings(
- resolveUniverseListings | src/trading/screenerPipeline.ts:830 | async function resolveUniverseListings(
- resolveUniverseSymbols | src/trading/stockQuoteSource.ts:126 | export async function resolveUniverseSymbols(
- resolveUniverse | src/trading/universes.ts:198 | export function resolveUniverse(

### J — other domain-specific (176)

- resolveA2AAgent | src/a2a/resolution.ts:96 | export function resolveA2AAgent(name: string): A2AResolution | undefined {
- resolveA2AInstanceName | src/a2a/resolution.ts:105 | export function resolveA2AInstanceName(
- resolveAgentEmailNamespace | src/actors/agentEmailRouting.ts:121 | export function resolveAgentEmailNamespace(
- resolveEmailSecret | src/actors/agentEmailRouting.ts:163 | export function resolveEmailSecret(env: object | null | undefined): string | undefined {
- createPortThinkEmailResolver | src/actors/agentEmailRouting.ts:189 | export function createPortThinkEmailResolver<Env extends object>(options): EmailResolver<Env>
- resolveThinkWebhookSecret | src/actors/thinkPortMapping.ts:207 | export function resolveThinkWebhookSecret(env: unknown): string | undefined {
- resolveThinkWorkspacePath | src/actors/thinkPortMapping.ts:325 | export function resolveThinkWorkspacePath(
- resolveStoredReportForServe | src/agentic/compositionMemory.ts:206 | export async function resolveStoredReportForServe(
- resolveServeLeg | src/agentic/compositionMemory.ts:221 | export async function resolveServeLeg(
- resolveCopilotTradingSelection | src/agents/copilotTradingMode.ts:94 | export async function resolveCopilotTradingSelection(
- resolveStrategyProfile | src/agents/nlqOptionsStrategy.ts:737 | async function resolveStrategyProfile(
- resolveStub | src/agents/orchestrator/meshDoors.ts:413 | function resolveStub<T>(namespace, instanceName, door): T {
- resolveStockCopilotMcpActivation | src/agents/orchestrator/meshMcpClient.ts:437 | export function resolveStockCopilotMcpActivation(deps: {
- resolveThesis | src/agents/orchestrator/meshOptionsStrategyDoor.ts:448 | function resolveThesis(raw: string | undefined, firstStrategyId: string | undefined): OptionThesis {
- resolveRiskProfile | src/agents/orchestrator/meshOptionsStrategyDoor.ts:466 | function resolveRiskProfile(raw: string | undefined): RiskProfile {
- resolveCallbackDispatch | src/agents/orchestrator/scheduledCallbacks.ts:105 | async function resolveCallbackDispatch(
- resolveAdsViewer | src/agents/routes/adsRevenueReferrals.ts:177 | async function resolveAdsViewer(
- resolveAuditAspects | src/agents/routes/audit.ts:123 | function resolveAuditAspects(payload: Record<string, unknown>): ResolvedAuditAspects | null {
- resolveSide | src/agents/routes/brokerConnect.ts:112 | function resolveSide(
- resolveStores | src/agents/routes/dataLifecycle.ts:285 | function resolveStores(ctx: DataLifecycleRouteContext): ResolvedStores {
- resolveWiredCaller | src/agents/routes/dataLifecycle.ts:382 | async function resolveWiredCaller(
- resolveDelegationCaller | src/agents/routes/delegations.ts:111 | export async function resolveDelegationCaller(
- resolveEvaluateHostDispatch | src/agents/routes/etradeOptionsEvaluate.ts:114 | export function resolveEvaluateHostDispatch(
- resolveAdmin | src/agents/routes/orchestratorMigration.ts:174 | async function resolveAdmin(
- resolveCheckoutPorts | src/agents/routes/paymentAssuranceLive.ts:174 | function resolveCheckoutPorts(ctx: PaymentAssuranceLiveContext): CheckoutPorts | null {
- resolveOperatorCaller | src/agents/routes/platformUsers.ts:253 | async function resolveOperatorCaller(
- resolveFlagManagedBy | src/agents/routes/schedules.ts:664 | function resolveFlagManagedBy(ctx: SchedulesRouteContext): "flagship" | "environment" | "in-memory" {
- resolveResearchSql | src/agents/routes/screenerResearch.ts:688 | const resolveResearchSql = (): SqlStorage | undefined => {
- resolveResearchD1 | src/agents/routes/screenerResearch.ts:695 | const resolveResearchD1 = (): D1Database | undefined =>
- resolveTokenStore | src/agents/routes/serviceUser.ts:534 | function resolveTokenStore(ctx: ServiceUserRouteContext): KvLike {
- resolveActingSession | src/agents/routes/serviceUser.ts:718 | export async function resolveActingSession(
- resolveReaderHalt | src/agents/scheduled-agent.ts:301 | async function resolveReaderHalt(
- resolveScreenerAgentName | src/agents/screenerAgentName.ts:28 | export function resolveScreenerAgentName(env: Env, userLogin?: string): string {
- resolveBriefDate | src/agents/social/briefStore.ts:51 | export function resolveBriefDate(nowMs: number, timeZone: string, dayOffset: 0 | 1): string {
- resolvePublishTarget | src/agents/social/publisher.ts:336 | export function resolvePublishTarget(
- resolveSubmissionEndpoint | src/agents/social/publisher.ts:368 | export function resolveSubmissionEndpoint(channel: string): string {
- resolvePostUrl | src/agents/social/publisher.ts:388 | export function resolvePostUrl(channel: string, platformPostId?: string | null): string | null {
- resolveErrorAspect | src/aspects/errorCodes.ts:320 | export function resolveErrorAspect(err: unknown): ErrorResolutionAspect {
- resolveSelectedRun | src/client/ScreenersHub.tsx:167 | export function resolveSelectedRun<T extends { timestamp: string }>(...)
- resolveSelectedRun | src/client/StockHub.tsx:243 | export function resolveSelectedRun<T extends { timestamp: string }>(...)
- resolveCatalogStrategyLabels | src/client/options/strategyLibrary.ts:1662 | export function resolveCatalogStrategyLabels<T extends { id: string; name?: string; label?: string }>(...)
- resolveETradeBaseUrl | src/config/environment.ts:73 | export function resolveETradeBaseUrl(rawUrl: string): string {
- resolveDueHourUtc | src/config/heartbeatWatchdog.ts:137 | function resolveDueHourUtc(
- resolveHeartbeatRenewalDueHourUtc | src/config/heartbeatWatchdog.ts:157 | export function resolveHeartbeatRenewalDueHourUtc(
- resolveHeartbeatRetentionDueHourUtc | src/config/heartbeatWatchdog.ts:172 | export function resolveHeartbeatRetentionDueHourUtc(
- resolveIbkrMcpUrl | src/config/ibkr.ts:43 | export function resolveIbkrMcpUrl(env?: { IBKR_MCP_SERVER_URL?: string }): string {
- resolveSpecAxes | src/config/jobDefinitionCatalog.ts:622 | function resolveSpecAxes(raw: unknown, specId: string): Partial<Record<Axis, string>> | undefined {
- resolveNumberField | src/config/jobDefinitionCatalog.ts:768 | function resolveNumberField(
- resolveParamDerivation | src/config/jobDefinitionParamRegistry.ts:56 | export function resolveParamDerivation(name: string, specId: string): ParamDerivationFn {
- resolveOrderType | src/config/orderCapabilities.ts:114 | export function resolveOrderType(caps: OrderCapabilities, current: OrderType): OrderType | null {
- resolveTimeInForce | src/config/orderCapabilities.ts:120 | export function resolveTimeInForce(
- resolveOtelDestinationEnabled | src/config/otelModes.ts:629 | export function resolveOtelDestinationEnabled(
- resolveOtelMaster | src/config/otelModes.ts:672 | export function resolveOtelMaster(levels: OtelScopeLevels): ResolvedOtelMaster {
- resolveOtelSignalExporter | src/config/otelModes.ts:708 | export function resolveOtelSignalExporter(
- resolveOtelDomainEnabled | src/config/otelModes.ts:753 | export function resolveOtelDomainEnabled(
- resolveOtelDomainLevel | src/config/otelModes.ts:793 | export function resolveOtelDomainLevel(
- resolveOtelDomainSampling | src/config/otelModes.ts:833 | export function resolveOtelDomainSampling(
- resolvePublicBarsRequest | src/config/publicData.ts:74 | export function resolvePublicBarsRequest(timeframe?: string, limit?: number): PublicBarsRequest {
- resolveQuoteStreamProvenance | src/config/quoteModes.ts:264 | export function resolveQuoteStreamProvenance(
- resolveResearchRules | src/config/researchRules.ts:190 | export function resolveResearchRules(parsed: unknown): ResearchRules {
- resolveRunLedgerFilters | src/config/runLedgerModes.ts:120 | export function resolveRunLedgerFilters(env: RunLedgerFilterEnv = {}): RunLedgerFilter[] {
- resolveRunLedgerDefaultFilter | src/config/runLedgerModes.ts:132 | export function resolveRunLedgerDefaultFilter(
- resolveSections | src/config/scheduleSections.ts:118 | function resolveSections<T extends string>(...)
- resolveSectionDefault | src/config/scheduleSections.ts:136 | function resolveSectionDefault<T extends string>(...)
- resolvePositiveInteger | src/config/sessionStoreConfig.ts:73 | function resolvePositiveInteger(
- resolveShardPacing | src/config/shardPacing.ts:36 | export function resolveShardPacing(env: Record<string, unknown> = {}): ShardPacing {
- resolveValue | src/config/vocabulary.ts:379 | export function resolveValue(axis: Axis, value: string): Resolved<string> {
- resolveFeedQuotesFromArtifact | src/data/feedDatasetPorts.ts:339 | export function resolveFeedQuotesFromArtifact(args: {
- resolveStockScreeningPrimary | src/data/productAccess.ts:241 | export function resolveStockScreeningPrimary(): {
- resolveProductAccess | src/data/productAccess.ts:266 | export function resolveProductAccess(
- resolveEffectiveVersion | src/data/productPorts.ts:136 | export function resolveEffectiveVersion<T extends VersionLike>(...)
- resolveRunContext | src/data/providerCapturePorts.ts:232 | export function resolveRunContext(
- resolveOrphanSweepDelete | src/data/retention1766.ts:106 | export function resolveOrphanSweepDelete(raw: unknown): boolean {
- resolveSnapshotEnabled | src/data/retention1766.ts:198 | export function resolveSnapshotEnabled(raw: unknown): boolean {
- resolveReportLink | src/data/runLedgerProjection.ts:115 | async function resolveReportLink(
- resolveScanBackfillLinkage | src/data/scanRunPorts.ts:104 | export function resolveScanBackfillLinkage(
- resolveStatementText | src/data/schemaComponent/executor.ts:66 | export function resolveStatementText(
- resolveRecreatePlan | src/data/schemaComponent/recreateRunner.ts:393 | export function resolveRecreatePlan(): RecreatePlan {
- resolveSocialRewardAvailability | src/data/socialRewardModel.ts:203 | export function resolveSocialRewardAvailability(
- resolveRunCoverage | src/data/socialRewardModel.ts:425 | export function resolveRunCoverage(input: {
- resolveFreeMonthEligibility | src/data/socialRewardModel.ts:442 | export function resolveFreeMonthEligibility(input: {
- resolveTokenSet | src/data/tokenFamilyKvImpl.ts:135 | async function resolveTokenSet(
- resolveEnrichmentSelection | src/enrichment/enrichmentPorts.ts:56 | export function resolveEnrichmentSelection(opts: {
- resolveMinuteTimeframe | src/enrichment/enrichmentPorts.ts:106 | export function resolveMinuteTimeframe(
- resolveAndVerifyPublisherWebhookUrl | src/events/screenerPublishers.ts:164 | async function resolveAndVerifyPublisherWebhookUrl(
- resolveAndVerifyPublisherEmailTo | src/events/screenerPublishers.ts:215 | async function resolveAndVerifyPublisherEmailTo(
- resolveAxisValue | src/mcps/openaimp/bizCopilotTenantCommands.ts:141 | function resolveAxisValue(axis: "provider" | "broker", raw: string): string {
- resolveKnowledgeForTool | src/mcps/openaimp/commands.ts:365 | function resolveKnowledgeForTool(
- resolveMemoryReadForList | src/mcps/openaimp/commands.ts:401 | function resolveMemoryReadForList(
- resolveMcpPrincipalFromHeaders | src/mcps/openaimp/mcpPermissionPorts.ts:721 | export function resolveMcpPrincipalFromHeaders(headers: {
- resolveSlackPost | src/observability/otelAlerting.ts:213 | const resolveSlackPost = (): SlackPostFn => deps.slackPost ?? fetchSlackPost;
- resolveEmailSender | src/observability/otelAlerting.ts:214 | const resolveEmailSender = (): EmailSender | null =>
- resolveLogger | src/observability/otelAlerting.ts:216 | const resolveLogger = (): StructuredLogger =>
- resolveOtelBackendCredentials | src/observability/otelBackend.ts:123 | export function resolveOtelBackendCredentials(
- resolveCatalogMessage | src/observability/otelMessages.ts:358 | export function resolveCatalogMessage(
- resolveCatalogSeverity | src/observability/otelMessages.ts:388 | export function resolveCatalogSeverity(
- resolveAlertRule | src/observability/otelMessages.ts:448 | export function resolveAlertRule(ruleId: string): AlertRuleResolution {
- resolveRecordKind | src/observability/tenantObservabilityView.ts:65 | function resolveRecordKind(
- resolveSocialFeedSource | src/orchestrations/socialDigestFeed.ts:60 | export function resolveSocialFeedSource(levels: SocialFeedSourceLevels): ResolvedSocialFeedSource {
- resolveOutcome | src/outcomes/outcomeAspects.ts:111 | export function resolveOutcome(code: string): OutcomeResolution {
- resolveRunDetailMessage | src/outcomes/outcomeAspects.ts:163 | export function resolveRunDetailMessage(
- resolveDraftOwner | src/payments/draftOwners.ts:133 | export async function resolveDraftOwner(env: Env, draftId: string): Promise<string | null> {
- resolveActorAttribution | src/security/backgroundAttribution.ts:111 | export function resolveActorAttribution(
- resolveLedgerWriteContext | src/security/commercialExecutionContext.ts:154 | export async function resolveLedgerWriteContext(
- resolveLedgerWriteContextHeader | src/security/commercialExecutionContext.ts:205 | export async function resolveLedgerWriteContextHeader(
- resolveExecutionContext | src/security/executionContext.ts:315 | export async function resolveExecutionContext(
- resolveAdminGrantProposal | src/security/grantProposals.ts:235 | export async function resolveAdminGrantProposal(
- resolveBootstrapEntries | src/security/iaaaBootstrap.ts:158 | export async function resolveBootstrapEntries(
- resolveOffboardSessions | src/security/iaaaLifecycleWiring.ts:211 | export function resolveOffboardSessions(
- resolveDoNameInput | src/security/iaaaMigration.ts:445 | export function resolveDoNameInput(
- resolveClientSecret | src/security/oidcProvider.ts:207 | async function resolveClientSecret(env: Env, options: OidcProviderOptions): Promise<string | undefined> {
- resolvePublicCredentialRef | src/security/publicOAuth.ts:357 | export async function resolvePublicCredentialRef(
- resolveSessionCap | src/security/sessionCap.ts:69 | export function resolveSessionCap(raw: unknown): number {
- resolveStoreOperatorAccess | src/security/storeOperatorGate.ts:106 | export async function resolveStoreOperatorAccess(
- resolveCurrentList | src/server/routes/auth.ts:2999 | const resolveCurrentList = async (): Promise<{
- resolveNavCaller | src/server/routes/nav.ts:301 | async function resolveNavCaller(
- resolveScreenerHandOff | src/services/analyzeJobs.ts:821 | export function resolveScreenerHandOff(input: unknown): ScreenerHandOffInput {
- resolveLadderExitDeltas | src/services/bracketLadder.ts:34 | export function resolveLadderExitDeltas(input: {
- resolveAndVerifySlackRecipientAtDelivery | src/services/channelRecipientVerification.ts:511 | export async function resolveAndVerifySlackRecipientAtDelivery(input: {
- resolveAndVerifyWebhookRecipientAtDelivery | src/services/channelRecipientVerification.ts:690 | export async function resolveAndVerifyWebhookRecipientAtDelivery(input: {
- resolveComparisonHostDispatch | src/services/comparisonHostDispatch.ts:118 | export function resolveComparisonHostDispatch(
- resolveLedgerTrigger | src/services/consolidatedScheduling.ts:105 | export function resolveLedgerTrigger(
- resolveTimingForm | src/services/consolidatedScheduling.ts:345 | export function resolveTimingForm(
- resolveLifecycleAction | src/services/consolidatedScheduling.ts:420 | export function resolveLifecycleAction(
- resolveVoiceBackend | src/services/copilotVoiceBackend.ts:286 | export function resolveVoiceBackend(deps: {
- resolveCopilotVoiceBackend | src/services/copilotVoiceBackend.ts:313 | export function resolveCopilotVoiceBackend(deps: {
- resolveFeedInputArtifact | src/services/enrichJobs.ts:1059 | export async function resolveFeedInputArtifact(
- resolveEnrichHandOffInput | src/services/enrichPipelineJobs.ts:440 | async function resolveEnrichHandOffInput(
- resolveGoalLegHostDispatch | src/services/goalLegHostDispatch.ts:139 | export async function resolveGoalLegHostDispatch(
- resolveSpyPutContract | src/services/hedgeProposals.ts:315 | export async function resolveSpyPutContract(etrade: ETradeService): Promise<SpyPutContract | null> {
- resolveStoredIndexList | src/services/indexListConsumer.ts:66 | export async function resolveStoredIndexList(args: {
- resolveNode | src/services/jobPipelineConfig.ts:212 | function resolveNode(raw: unknown, path: string): JobNodeConfig {
- resolveWiredObservers | src/services/jobPipelineControlFactory.ts:171 | function resolveWiredObservers(
- resolveRunNowTrigger | src/services/jobPipelineEngine.ts:232 | export function resolveRunNowTrigger(_definition: JobDefinition): JobRunTrigger {
- resolveMarketDataQuotes | src/services/marketDataService.ts:79 | export function resolveMarketDataQuotes(
- resolvePrefixes | src/services/memoryConsolidation.ts:91 | function resolvePrefixes(raw: string | undefined, fallback: readonly string[]): readonly string[] {
- resolveOptionsRunEmailRecipient | src/services/optionsRunEmail.ts:24 | export function resolveOptionsRunEmailRecipient(
- resolvePaidScreenAction | src/services/paidScreenSubmission.ts:124 | export function resolvePaidScreenAction(input: {
- resolvePositionsSnapshot | src/services/portfolioRisk.ts:393 | export async function resolvePositionsSnapshot(
- resolveScreenSelection | src/services/providerConnections.ts:294 | export async function resolveScreenSelection(
- resolveScreenExecutionContext | src/services/providerConnections.ts:503 | export async function resolveScreenExecutionContext(
- resolveSignupReferrer | src/services/referralAttribution.ts:75 | export async function resolveSignupReferrer(
- resolveResearchVenue | src/services/researchVenue.ts:95 | export function resolveResearchVenue(input: ResearchVenueInput = {}): ResearchVenue {
- resolveRunDetailMessage | src/services/runDetails.ts:72 | export function resolveRunDetailMessage(
- resolveCanonicalReportBodyWithBackfill | src/services/scheduledReports.ts:1280 | export async function resolveCanonicalReportBodyWithBackfill(
- resolveCanonicalReportBody | src/services/scheduledReports.ts:1312 | export async function resolveCanonicalReportBody(
- resolvePresetFilter | src/services/screenerPresetResolution.ts:42 | export function resolvePresetFilter(
- resolveShardHostDispatch | src/services/shardExecutors.ts:574 | export async function resolveShardHostDispatch(
- resolveCopilotStrategies | src/services/stockCopilotConfiguration.ts:386 | export function resolveCopilotStrategies(opts?: {
- resolveCopilotProposalFiler | src/services/stockCopilotProposalFiling.ts:58 | export function resolveCopilotProposalFiler(
- resolveCopilotSessions | src/services/stockCopilotSessions.ts:147 | export function resolveCopilotSessions(
- resolveStockReportFormatStatus | src/services/stockReportFormatStatus.ts:54 | export function resolveStockReportFormatStatus(input: {
- resolveUnifiedScanHostDispatch | src/services/unifiedScanHostDispatch.ts:113 | export async function resolveUnifiedScanHostDispatch(
- resolveOffer | src/services/upgradeOffers.ts:347 | export async function resolveOffer(input: ResolveOfferInput): Promise<OfferPayload> {
- resolveSubscriptionProvenance | src/services/usageBillingSurface.ts:84 | export function resolveSubscriptionProvenance(row: SubscriptionRecord): {
- resolveEmailDestination | src/services/userEmailDestination.ts:155 | export function resolveEmailDestination(input: ResolveEmailDestinationInput): string | undefined {
- resolveBulkMovePopulation | src/services/versionMoves.ts:296 | async function resolveBulkMovePopulation(
- resolveX402Network | src/services/x402Networks.ts:44 | export function resolveX402Network(network: string | undefined): X402NetworkInfo | null {
- resolveAlpacaPair | src/trading/alpaca/credentialResolution.ts:71 | export async function resolveAlpacaPair(
- resolveAlpacaTradingBase | src/trading/alpaca/optionsData.ts:130 | export function resolveAlpacaTradingBase(
- resolveBaseBreakoutCaps | src/trading/baseBreakout.ts:260 | export function resolveBaseBreakoutCaps(
- resolveCancelTargets | src/trading/cancelFilters.ts:369 | export function resolveCancelTargets(
- resolvePrincipal | src/trading/channels/intake.ts:298 | export async function resolvePrincipal(
- resolveSessionWindow | src/trading/limits.ts:158 | function resolveSessionWindow(
- resolveScanTarget | src/trading/options/opportunityScanner.ts:797 | export function resolveScanTarget(
- resolveScanClock | src/trading/options/opportunityScanner.ts:1100 | function resolveScanClock(options: OpportunityScanOptions): Date {
- resolveAllowedStrategyIds | src/trading/options/strategyChoice.ts:104 | export function resolveAllowedStrategyIds(allowedStrategies: readonly string[]): { ids: string[]; unknown: string[] } {
- resolvePanelFetchBands | src/trading/options/strategyChoice.ts:217 | export function resolvePanelFetchBands(
- resolveScoreWeights | src/trading/options/strategyEngine.ts:353 | export function resolveScoreWeights(bias?: number): StrategyScoreBreakdown["weights"] {
- resolveNoViewScoreWeights | src/trading/options/strategyEngine.ts:380 | export function resolveNoViewScoreWeights(bias?: number): NoViewScoreWeights {
- resolveYahooHistoryDeps | src/trading/platformHistory.ts:290 | export async function resolveYahooHistoryDeps(args: {
- resolveTastytradeBaseUrl | src/trading/tastytrade/credentials.ts:84 | export function resolveTastytradeBaseUrl(env: Env, overrideEnv?: string): string {
- resolveTastytradeCredentials | src/trading/tastytrade/credentials.ts:197 | export async function resolveTastytradeCredentials(
- resolveStockCopilotVoiceActivation | src/trading/voice/stockCopilotVoiceActivation.ts:60 | export function resolveStockCopilotVoiceActivation(deps: {
- resolveResearchDatasets | src/workflows/researchDataPorts.ts:47 | export async function resolveResearchDatasets(input: {
- resolveResearchEngineAdapters | src/workflows/researchScreenEngine.ts:185 | export function resolveResearchEngineAdapters(input: {

## 4. Class methods, Resolver types, and exclusions

### `resolve*` class methods (17 implementations — separate from the 557)

- `resolveId` | src/data/doSqliteRunRegistryAdapter.ts:160 | `resolveId(id: string): ResolveIdResult {`
- `resolveId` | src/data/inMemoryRunRegistryAdapter.ts:105 | `resolveId(id: string): ResolveIdResult {`
- `resolveApiKey` | src/patterns/paymentStrategies.ts:75 | `resolveApiKey(env: Env): { apiKey?: string; mode: "sandbox" \| "live" } {`
- `resolveUncached` | src/services/betaService.ts:140 | `private async resolveUncached(symbol: string): Promise<BetaResolution> {`
- `resolveDeliveryTenant` | src/services/scheduledTasks.ts:1558 | `private async resolveDeliveryTenant(userLogin: string): Promise<string \| null> {`
- `resolveWatchlistSymbols` | src/services/scheduledTasks.ts:4834 | `private resolveWatchlistSymbols(name: string, userLogin: string): string[] \| null {`
- `resolveTokenIdentity` | src/trading/etrade/platform.ts:176 | `private resolveTokenIdentity() {`
- `resolveMany` | src/trading/options/strategies/registry.ts:46 | `resolveMany(names: readonly string[]): { ids: string[]; unknown: string[] } {`
- `resolveEngineClient` | src/trading/options/unifiedOptionsService.ts:662 | `async resolveEngineClient(): Promise<{ engineClient: ETradeRestClient \| OptionChainSource; platformRunId?: string }> {`
- `resolveStrategyProfile` | src/trading/options/unifiedOptionsService.ts:794 | `async resolveStrategyProfile(req: UnifiedOptionsRequest): Promise<{ profile?: StrategyProfile; error?: string }> {` — duplicate of the standalone fn in nlqOptionsStrategy.ts:737
- `resolveUnderlyings` | src/trading/optionsScreener.ts:522 | `async resolveUnderlyings(filter: OptionScreenerFilter): Promise<string[]> {`
- `resolveAccount` | src/trading/public/platform.ts:326 | `private async resolveAccount(): Promise<{ account: BrokerAccount; accountId: string }> {`
- `resolveDefaultAccountNumber` | src/trading/tastytrade/platform.ts:301 | `private async resolveDefaultAccountNumber(accountKey?: string): Promise<string> {`
- `resolveSymbols` | src/retrieval/d1MarketGraphAdapter.ts:167 | `async resolveSymbols(tenantId: string, candidates: string[]): Promise<string[]> {`
- `resolveSymbols` | src/retrieval/inMemoryMarketGraphAdapter.ts:72 | `async resolveSymbols(tenantId: string, candidates: string[]): Promise<string[]> {`
- `resolveChargePricing` | src/services/nativeMonetization.ts:335 | `async resolveChargePricing(family: NativeScreenerFamily, segment: string, …)`
- `resolveCalibratedPrompt` | src/telemetry/telemetryPorts.ts:553 | `async resolveCalibratedPrompt(tenantId: string, actorKey: string, promptKey: string): Promise<string \| null> {`
- `resolveRoute` | src/trading/dataProviders/registry.ts:189 | `resolveRoute(capability, configs, routes, callerTier?): CapabilityAssignment {`

### `*Resolver` types (9) and interface method declarations (3)

- `RefundPaymentSourceResolver` — interface, src/data/refundPorts.ts:542 — `resolve(originalPaymentRef: string): Promise<RefundPaymentSource | null>` (its appearances in refundService.ts:75 and premium.ts:90 for `WalletLoginResolver` are imports, not definitions)
- `McpRoleResolver` — type, src/mcps/openaimp/mcpPermissionPorts.ts:571
- `ProviderResolver` — type, src/security/iaaaLoggedInUsers.ts:65
- `ProviderIssuerResolver` — type, src/security/iaaaLoginKey.ts:35
- `WalletLoginResolver` — interface, src/security/payerWalletIdentity.ts:19
- `SettingResolver` — type, src/services/jobDefinitionParamBinders.ts:36 — `(settingKey: string) => unknown`
- `JobPipelineControlOtelResolver` — type, src/services/jobPipelineControlFactory.ts:106 (setter `setJobPipelineControlOtelResolver` at :119)
- `BetaResolver` — type, src/services/portfolioRisk.ts:330 — `(symbol: string) => Promise<BetaResolution>`
- `BrokerChainSourceResolver` — type, src/workflows/brokerChainSourceResidency.ts:64
- Interface method declarations: `resolveId` (src/data/runRegistryPorts.ts:139), `resolveSymbols` (src/retrieval/retrievalPorts.ts:107), `resolveStage` (src/services/agentScheduleCapability.ts:593, in `AgentWorkflowStageScheduleAdapter`).
- Not counted: `PortThinkEmailResolverOptions` (src/actors/agentEmailRouting.ts:170) is an options interface for a factory, not a Resolver type.

### Not counted / excluded

- **Aliases (2, not independent resolvers):** `resolveTradeEnvironmentFromSettings = resolveSharedTradingEnvironment` (src/agents/routes/brokerEnvironment.ts:105); `resolveCanonicalWorkspacePath = resolveThinkWorkspacePath` (src/agents/routes/workspace.ts:28). Re-export `export { resolveIdleTimeoutMs }` (src/security/sessionPolicy.ts:235) also not a new definition.
- **Generic `resolve()` methods (8, name is exactly `resolve`, not `resolve*`):** `src/services/jobPipelineSteps.ts:100`, `src/trading/dataProviders/registry.ts:161`, `src/trading/options/strategies/registry.ts:41`, `src/trading/screeningProvider.ts:279`, `src/services/betaService.ts:132`, plus the `resolve` method inside the three `create*PaymentResolver` objects (refundPaymentIntent.ts:95,150; refundService.ts:128).
- **Tests-only resolvers (7, excluded from the count):** `resolveVar` (tests/checkout_ui_top_up_wcag_3574.test.tsx:486), `resolvePositive` (tests/s2_tenant_isolation_matrix.test.ts:231), `resolveCommercialBarePaths` (tests/schedule-3121-s0-parity.test.ts:68), `resolveCombinedSteps` (tests/schema_equality_harness.ts:187), `resolveCommercialPrefixes` (tests/server_route_inventory_2902.test.ts:254), `resolveImport` (tests/template_route_tree.ts:91), `resolveCommercialRefs` (tests/thin_router_inventory.test.ts:1455).
- **scripts/:** only `resolveBase` (scripts/lint-changed.mjs:31) — a CI lint helper, not a production code path; excluded. No `resolve*` definitions in top-level `config/`.
- **Not searched:** `node_modules`, generated files, `docs/`, `specs/`, `evaluations/`, `tmp/`, `g.txt`, `pr-body.md`.

### What could not be verified (resolver side)

- **Caller coverage for all 557:** mention totals were counted only for the central resolvers (`resolveIaaaTenant` 157, `resolveTenantBroker` 95, `resolveEnvironmentConfig` 64, `resolveFeedJob` 63, `resolveTenantProviders` 26, `resolveBrokerEnvironmentFromSettings` 21, `resolveTradeEnvironmentFromSettings` 17, `resolveAgentConfig` 14, `resolveScreenerAgentName` 13, `resolveChainSourceForRequest` 12, `resolveScheduledLogin` 10). The 134 non-exported resolvers may include dead or single-use local helpers — no dead-code analysis was done, so it cannot be said which of the 557 are actually called.
- **Full multi-line signatures:** the list above shows each definition's first line only (truncated at 110 chars); several signatures span multiple lines and return types were not all captured verbatim.
- **`EmailResolver` type definition:** `createPortThinkEmailResolver` returns `EmailResolver<Env>` imported from `"agents/email"`, but no `type/interface EmailResolver` definition was found under `src/` (no `src/agents/email.ts` exists) — its definition lives outside the searched tree or in a built artifact; not counted.
- **Kind classification is name-based** (plus file location); a full body read of all 557 was not feasible, so a few rows may belong in a neighbouring kind — the file+line is exact regardless.
- **DI-fallback boundary** as disclosed in §1 (±4–6 if you count/exclude all `a ?? b` resolver picks uniformly).

## 5. Issue coverage — context / resolver / common capabilities

Method (read-only, no writes): live public GitHub API only. One candidate (#6487) was verified via the core issues endpoint before the shared unauthenticated core quota hit zero (60/hr on the egress IP, `X-RateLimit-Remaining: 0`, reset ~18:01 UTC). The other candidates were verified live via the Search API instead (search bucket never exhausted; a number-text query returns the issue itself first, with number/title/state/labels/body snippet). No candidate was assumed — every row below was returned live. Parentage is stated only where the title/body snippet shows it; otherwise marked "not visible in snippet".

### Verified candidates

| # | Title | State | Parent | One-line coverage | Home / duplicate flag |
|---|---|---|---|---|---|
| 6491 | [6487] Consolidate the Worker text vars into one JSON config var (Free-plan cap 10055) | open | #6487 (title prefix) | Cuts the Worker's 93 env vars to fit the Free plan's 64-var cap | **NOT an env-context home — correction:** this is Cloudflare Worker *env vars*, not ExecutionContext. Filing universal-env-context here would be miscategorised, not a duplicate. |
| 6487 | [Bug] - Main deploys fail on Cloudflare Free plan: CPU limits rejected (100328), five consecutive pushes | **closed** | — (incident parent itself) | Deploy incident: `Deploy Worker` step rejected CPU limits on Free plan | Not a home. Closed parent; its live children are #6491, #6493, #6494. |
| 6172 | [Enhancement] - Universal context across the API layer: every route handler carries the validated ExecutionContext | open | not visible in snippet | Every API route handler carries the validated ExecutionContext | **Strongest existing home for universal-context work (API layer).** Implementation issue #6247 "feat(6172): API layer carries the validated execution context" is already **closed** — #6172 may be stale-open or awaiting verification/close. A new universal-context issue overlapping the API layer would duplicate #6172; check why it is still open first. |
| 3216 | [Enhancement] - Platform-wide broker and provider agnosticism: broker selection drives every screen, trade, and message | open | — (program parent) | One persisted broker/mode selection governing every screen, trade, message | **Program home for broker/mode-as-environment.** A new issue on "one persisted environment source of truth" would substantially duplicate #3216 (and its slice #3460 below) unless scoped to a gap it doesn't cover. |
| 3121 | [Enhancement] - Consolidate scheduled implementations and schedule surfaces into one scheduler and one surface family, losslessly | open | — (program parent) | One scheduler + one schedule surface family; agent context lives here via #3122 | Home for *scheduling* agent context only. Not a home for universal env context generally. |
| 3122 | [Enhancement] - Agentic scheduling: an agent can create, update, pause, resume, trigger, delete, and list a schedule for any task (scheduling consolidation #3121) | open | **#3121** (stated in title) | Agent-operable schedules (create/update/pause/resume/trigger/delete/list) | Home for agent *schedule-action* context. Not a general universal-context home. |
| 1069 | Multi-dimensional System | open | — (root requirement) | Platform must support many dimensions: tenants, users, roles, environments, agents, execution contexts, etc. | Root requirement naming execution contexts as a dimension. Too broad to be a working home; its epic #1070 (below) is the actionable child. A new universal-context issue would be *under* #1069, not duplicating it. |
| 3260 | Harmonize the data-access mechanisms under the ports: one standard per plane (Drizzle / ORM core / hand-written SQL) | open | — (CDO data-layer program) | One data-access standard per plane; D1/ORM/DO residency decisions | Home for data-plane standardisation, not for context/resolver. Overlaps only if the new work is about where context is *stored* — then it belongs under #3260/#5852. |
| 5852 | [Decision] One run-ledger store, or residency-driven stores? — /api/ledger/runs reads DO halves, not D1/ORM | open | not visible in snippet | Decides single vs residency-driven run-ledger store(s) | Decision home for ledger-store residency. Not a context/resolver home. |
| 4253 | [3121] Externalize DEFAULT_SCHEDULES to config — built-in goals configurable, removal durable | open | **#3121** (title prefix) | Built-in scheduled goals externalised to config, durably removable | Home for externalised-config *of schedules* only. Implementation issue #5422 "feat(4253)…" is already **closed** while #4253 stays open — same stale-open pattern as #6172. Not a general config/context home. |
| 6409 | [GitOps Optimization] | open | not visible in snippet | PR merge cycle (branch → Tier 1 → push → CI → queue) takes 1–2 hrs vs main landing pin bumps every 15–30 min | No relation to context/resolver/common capabilities. Not a home; no duplication risk. |

### Additional genuine-coverage issues found by search

**"universal" in title (12 hits; the real ones):**
- **#6173 open** — [Enhancement] - Universal context across the MCP layer: every MCP tool call carries the validated ExecutionContext + role-derived scope. **Sibling home (MCP layer).** Implementation #6431 "feat(6173)…" already closed — same stale-open caveat as #6172.
- **#6174 open** — [Enhancement] - Universal context dimensions in observability: recorder, log events, and the SLO endpoint read dimensions from the validated ExecutionContext. **Sibling home (observability).**
- **#6204 closed** — feat(1078): Validated ExecutionContext carries the universal field list. The field-list work itself; landed.
- **#6427 open** — [data-foundation] Identify and address all data gaps — universal-context masters (broker/mode/asset-type/account) + missing masters. **Home for universal-context *master data*.**
- **#1314 open** — [platform] Single environment source, universal exception handling/logging, externalized errors, secure-by-default. **Home for "single environment source" work** — the closest existing home for a universal *environment* context. A new universal-env-context issue would overlap #1314 unless scoped to a surface it doesn't cover.
- #3754 open — Copilot Evolution (Phase 2): Universal Broker-Agnostic Execution Port for Equities & Options. Related (execution port, broker-focused), not a general-context home.
- #1070 open — [epic] Multi-dimensional system (#1069) — security first, remaining dimensions as follow-up. Child/epic of #1069; the actionable home for remaining dimensions incl. execution contexts.

**"execution context" in title (7 hits; the real ones):**
- **#6384, #6385, #6386, #6387 — all open** — Engine D1 run records / report rows / async jobs / engine instance records, checkpoints & stage-output artifacts carry the full execution context (parents [5109]/[6324] in titles). Homes for execution-context *propagation to stored records*.
- #1965 open — [Bug] Scheduled runs hit AUTH_003 while manual runs pass auth: saved execution context login differs from session login. A bug, not a home.
- #6247 closed / #6431 closed — feat implementations of #6172/#6173 (see above).

**"resolver" in title (8 hits; the real ones):**
- **#3786 open** — Resolver consistency: census + standard + shrink-only pin (one resolver per question). **Live home for resolver work.** A new resolver issue would duplicate #3786 unless it is about a different question/resolver.
- **#3921 closed** — feat(config): the one per-agent resolver — capabilities and choices, externalized (#3741). The one per-agent resolver already landed.
- #4151 open — [Epic 4148] Slice 1 — money path + signal params (one resolver, no new surfaces). One-resolver slice, money-path scoped.
- #6178 closed — fix(6036): one OODA research venue resolver that refuses invalid broker/mode pairs. Landed.
- #5821/#5800/#5733 closed — feat(5175): id resolver API + MCP resolve_id (triplicate, landed).

**"common" / "common capabilities" in title: 0 hits for both queries.** No issue is *about* "common capabilities" by title. Closest existing homes for shared/common capability work: #1314 (single environment source), #3739 open — Broker-neutrality uniformity closeout: every capability broker-neutral, everywhere, #5880 open — [3121] One externalized job catalogue (single unique job list), and #3260 (one standard per plane). A genuinely new "common capabilities" issue would not duplicate any single issue by title, but must be scoped against #1314 / #3739 / #3260 to avoid overlap.

### Bottom line for reuse-first planning

- **Universal context already has a home family: #6172 (API) + #6173 (MCP) + #6174 (observability), plus #6427 (masters) and #1314 (single environment source).** Do not file a new universal-context issue without first establishing what gap these don't cover — and note #6172/#6173 look possibly already-implemented (their feat issues #6247/#6431 are closed while the enhancements stay open).
- **Resolver already has a live home: #3786** (plus landed #3921). New resolver work duplicates #3786 unless it names a different resolver/question.
- **Broker/mode environment source of truth already has a program home: #3216**, slice #3460 (one dynamic broker/mode selection governing every run).
- **#6491 is not env-context work** (Worker env-var count under deploy incident #6487) — do not cite it as context coverage.
- **Unverified detail:** parentage for #6172, #5852, #3260, #3216, #6409, #1069 was not visible in search snippets, and the core issues endpoint was rate-limited (shared IP, 0 remaining, reset ~18:01 UTC) so per-issue bodies weren't re-read. If parent links matter, re-check those six via the core endpoint after the reset. Search usage: 15 queries total, never rate-limited.
