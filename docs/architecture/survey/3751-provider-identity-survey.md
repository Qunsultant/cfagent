# #3751 ProviderIdentity — survey against current origin/main

- **Survey date:** 2026-11-09 (read-only; no files edited, no GitHub writes)
- **Tip SHA:** `ccf01c11aff0641f528b13542f7e02a2fc3098c2` — `fix(3911): census disposition for the stage-order rule's Yahoo row #CISO-bhdm`
- **Worktree:** `~/workspace/w3751/wt-survey` (detached at origin/main)
- **Recorded shape under verification:** issue body `~/workspace/w3525/issue-provider-identity-context.md` + the 2026-11-08 shape correction (extend the existing composed pair, consolidate the three display-name copies into the one map in `src/services/tenantProviders.ts`, no new resolver).

Headline findings:

1. **The recorded fail-to-legacy default `{etrade, etrade}` no longer exists.** Issue #3812 (owner rule on #3451) changed the platform default broker to **Alpaca (paper mode)**: `DEFAULT_TENANT_PROVIDERS = { dataProviderId: "etrade", brokerId: "alpaca" }` (`src/data/commercialPorts.ts:168-171`). The `{etrade, etrade}` pair now survives only as (a) stale doc-comments and (b) the genuinely separate legacy-*surface* fallback in `resolveTenantBroker` (absent selection → `"etrade"` for email/Slack/voice/E*TRADE-route surfaces). The build must pin the CURRENT default and must not touch either mechanism.
2. **Call-site counts are far below the recorded ~37.** The pair has exactly **2 composition sites** (both at the recorded files, one path moved) and `resolveTenantProviders` has **9 call sites** in 7 files. `TenantProviderContext` is consumed by exactly **2 files**.
3. **A fourth and fifth name source exist** that the recorded consolidation did not name: the provider registry adapters carry `name` (`src/trading/dataProviders/adapters.ts`), and `BROKER_CATALOG` carries `label` (`src/trading/brokerCatalog.ts`). The recorded "no second provider list" requirement now has to reckon with the registry's own names.
4. **No short name and no help/docs URL exists anywhere for a provider** — identity fields beyond display name are greenfield data that must be authored, and the code does not say where they should live (open question Q1).
5. **The server's `DATA_PROVIDER_DISPLAY_NAMES` map is dead code** — exported at `src/services/tenantProviders.ts:32`, zero consumers in `src/` or `tests/`. Consolidation starts from a map nothing reads.

---

## 1. The composed pair, `TenantProviderContext`, call sites, and the default

### 1.1 `resolveTenantProviders` (async half)

- **Definition:** `src/services/tenantProviders.ts:61` — `export async function resolveTenantProviders(env: unknown): Promise<TenantProviders>`.
- Behaviour: dynamically imports `createCommercialAdapter` (`src/data/createCommercialPorts.ts`); if no adapter (no `AGENT_DB`), returns `{ ...DEFAULT_TENANT_PROVIDERS }`; otherwise resolves the tenant via `resolveIaaaTenant` (`src/security/iaaaGithubEndToEnd.ts`) and returns `adapter.getTenantProviders(tenantId)`. Never throws — any error returns `{ ...DEFAULT_TENANT_PROVIDERS }` (tenantProviders.ts:61-74).
- `TenantProviders` type: `src/data/commercialPorts.ts` (imported at tenantProviders.ts:25); the port is `getTenantProviders(tenantId)` at commercialPorts.ts:296.
- Adapter-side defaulting (`src/data/d1CommercialAdapter.ts:338-361`): absent row → `{ ...DEFAULT_TENANT_PROVIDERS }`; per-field, an empty/non-string stored value falls back to that field's `DEFAULT_TENANT_PROVIDERS` value. The port doc (commercialPorts.ts:298-307) explicitly notes `getTenantBrokerSelection` applies NO default, precisely so callers can distinguish "no selection stored" from a stored `etrade`.

### 1.2 `resolveTenantProviderContext` (sync half) and `TenantProviderContext`

- **Definition:** `src/services/optionsProviderContext.ts:100-114` — `export function resolveTenantProviderContext(input?: { dataProviderId?: unknown; brokerId?: unknown } | null): TenantProviderContext`. Pure normalization: `normalizeId` (optionsProviderContext.ts:84-90) trims/lowercases, accepts known ids, otherwise returns the default with `fellBack: true`, **per field**.
- **`TenantProviderContext` today** (optionsProviderContext.ts:73-80) — exactly four fields, ids and fallback flags only, no identity/presentation fields:

```ts
export interface TenantProviderContext {
  dataProviderId: DataProviderId;
  brokerId: BrokerId;
  dataProviderFellBack: boolean;
  brokerFellBack: boolean;
}
```

- Its defaults are derived, never a second copy: `DEFAULT_DATA_PROVIDER_ID` / `DEFAULT_BROKER_ID` (optionsProviderContext.ts:60-61) re-export `DEFAULT_TENANT_PROVIDERS`' fields, pinned equal by test.
- Same module also holds: the declared capability matrix `DATA_PROVIDER_CAPABILITIES` (optionsProviderContext.ts:65-71), `showEtradeBrokerSurface` (:117), `dataProviderSupportsCapability` / `dataCapabilityUnavailable` (:122-148), `brokerSurfaceUnavailable` (:163-171), and `withProviderProvenance` (:185-190) — the helper that stamps `dataProviderId`/`brokerId` onto a provenance object. **This is the natural home for the identity extension**: adding identity fields inside `resolveTenantProviderContext` reaches every consumer of the context with no signature change.

### 1.3 Call sites (complete, current)

`resolveTenantProviderContext(` — **2 composition sites, exactly the recorded pair of surfaces**:

| Site | Form |
|---|---|
| `src/agents/routes/etradeOptionsScreen.ts:317` | `resolveTenantProviderContext(await resolveTenantProviders(ctx.env))` → `withProviderProvenance({}, …)` |
| `src/workflows/manualOptionsScreen.ts:109` | `resolveTenantProviderContext(await resolveTenantProviders(ctx.env as never))` → `withProviderProvenance({}, …)` |

(Recorded paths were `src/services/etradeOptionsScreen.ts:317` and `src/services/manualOptionsScreen.ts:109` — the line numbers are unchanged; the files moved, see drift table.)

`resolveTenantProviders(` — **9 call sites in 7 files** (plus its definition and one doc mention):

| File | Lines | Use |
|---|---|---|
| `src/agents/routes/etradeOptionsScreen.ts` | 317 | composed into the context (above) |
| `src/agents/routes/etradeOptions.ts` | 756 | spread into a request/provenance object |
| `src/agents/routes/etradeOptionsNoView.ts` | 99 | spread into a request/provenance object |
| `src/agents/routes/optionsProviderGate.ts` | 98 | feed-gate capability decision |
| `src/agents/routes/schedules.ts` | 667 | schedule creation tenant providers |
| `src/services/scheduledTasks.ts` | 1514, 2599, 2772 | scheduled engine paths (3 calls) |
| `src/workflows/manualOptionsScreen.ts` | 109 | composed into the context (above) |

`TenantProviderContext` (the type) is referenced outside its defining module by exactly the same 2 files (`etradeOptionsScreen.ts`, `manualOptionsScreen.ts`). Nothing else in `src/` consumes the context object today — the client never receives it (see §3).

### 1.4 Where the default lives — and the second, separate legacy fallback

- **The default pair:** `DEFAULT_TENANT_PROVIDERS` at `src/data/commercialPorts.ts:168-171` = **`{ dataProviderId: "etrade", brokerId: "alpaca" }`**. Its comment (commercialPorts.ts:160-167) records why: issue #3812, owner rule on #3451 — platform default broker is Alpaca in paper mode; the data provider stays `etrade`; paper is a mode default applied elsewhere, not stored here. It is consumed by: `resolveTenantProviders` (no-adapter/error path), both commercial adapters' `getTenantProviders`, `optionsProviderContext`'s derived defaults, `src/client/tenantProviders.ts`'s mirrored `DEFAULT_TENANT_PROVIDERS_STATE` (:31-38, pinned equal server-side), and tests.
- **Stale `{etrade, etrade}` traces:** `src/services/optionsProviderContext.ts:5` (module doc: "fail-open `etrade`/`etrade` fallback"), `src/services/tenantProviders.ts:13` (module doc: "Defaults are etrade / etrade") and `src/agents/routes/reports.ts:554` (route comment: "Absent row = etrade / etrade") all still describe the pre-#3812 default. The characterization test's *title* at `tests/options_product_slice2_provider_context.test.ts:45` also says "defaults to etrade/etrade" while its assertions correctly expect `DEFAULT_DATA_PROVIDER_ID`/`DEFAULT_BROKER_ID`. Doc/comment drift only — no code path returns `{etrade, etrade}` as the tenant default.
- **The separate legacy-surface fallback (do not conflate, do not touch):** `resolveTenantBrokerSelection` (tenantProviders.ts:85-100, presence-aware, null when nothing stored) and `resolveTenantBroker` (tenantProviders.ts:114-117: `stored ?? "etrade"`) exist so legacy E*TRADE surfaces (email, Slack, voice, E*TRADE options routes) keep their pre-#3812 behaviour when a tenant has stored no selection. The tenantProviders.ts:102-113 comment documents the two-defaults split as deliberate. This is a *broker-for-a-surface* rule, not the tenant default pair.
- **Fail-closed neighbours:** the settings route itself 503s when its store is unbound (reports.ts:562-564), and `brokerStoreUnavailableResponse` (tenantProviders.ts:139-150) is the broker gate's named 503 refusal to fail open. Both stay untouched.

**Build consequence:** the identity extension inherits whatever `resolveTenantProviderContext` resolves — for an absent/unknown stored value that is now data=`etrade` (fellBack) and broker=`alpaca` (fellBack). The issue's acceptance line "unconfigured/unknown resolves to an honest neutral identity, never a guessed brand" therefore needs an explicit decision against the *flags*: when `dataProviderFellBack`/`brokerFellBack` is true, does the surface render the default provider's identity (today's implicit behaviour everywhere) or the neutral identity? The code does not answer this — see Q2.

---

## 2. The display-name copies

### 2(a) `src/services/tenantProviders.ts` — the recorded consolidation target

Current contents relevant to identity:

- `BROKER_IDS = ["etrade", "alpaca"]` (:29) and `BrokerId` (:30).
- `DATA_PROVIDER_DISPLAY_NAMES: Record<string, string>` (:32-38): etrade→"E*TRADE", public→"Public.com", yahoo→"Yahoo Finance", nasdaq→"Nasdaq Listings", alpaca→"Alpaca". **Zero consumers** — no import anywhere in `src/` or `tests/` (verified by repo-wide grep; only the definition matches).
- `BROKER_DISPLAY_NAMES: Record<string, string>` (:40-43): etrade→"E*TRADE", alpaca→"Alpaca". Consumers: `src/services/scheduledBrokerGuard.ts:31,165` and `src/agents/routes/schedules.ts:44,708` (both render `MAP[id] ?? id`); one test mock reference (`tests/scheduled_effective_mode_3655.test.ts:14`).
- Also in the file: `isDataProviderId` / `isBrokerId` (:45-51), `normalizeTenantProviders` (:53-59), the resolution functions of §1, and the coded unavailable responses. No short names, no URLs, no options lists (the id vocabulary `DATA_PROVIDER_IDS` is imported from `../trading`, defined at `src/trading/dataProviders/contract.ts:73`).

### 2(b) `src/client/tenantProviders.ts` — client state module + options lists

This file is more than a name copy: it is the client's tenant-provider state store (server row is truth; in-memory cache + localStorage mirror; `cfagent-tenant-providers-changed` event). Identity-relevant exports:

- `DATA_PROVIDER_OPTIONS: Array<{id, label}>` (:39-45): etrade "E*TRADE", public "Public.com", yahoo "Yahoo Finance", nasdaq "Nasdaq Listings", alpaca "Alpaca" — an exact duplicate of the server's `DATA_PROVIDER_DISPLAY_NAMES`, in list form.
- `BROKER_OPTIONS: Array<{id, label}>` (:47-50): etrade "E*TRADE", alpaca "Alpaca" — duplicate of `BROKER_DISPLAY_NAMES`.
- `TenantProvidersState { dataProviderId, brokerId }` (:26-29), `DEFAULT_TENANT_PROVIDERS_STATE` (:31-38, etrade/alpaca — matches the current server default), `TENANT_PROVIDERS_ENDPOINT` (:21), `readTenantProvidersState` (:90), `loadTenantProvidersFromServer` (:96), `saveTenantProviders` (:117), `useTenantProviders` (:143, see §3), `brokerUnavailableNotice(brokerId, brokerLabel)` (:169-174 — caller passes the label in).

Importers of this module (13 files): `src/client/AccountPanels.tsx:23`, `BrokerDynamicMenu.tsx:32`, `Chat.tsx:6`, `ETradeTradingHub.tsx:10`, `FirstRunScreen.tsx:66` (state only), `IvHistoryPanel.tsx:10`, `OptionsScreenerPage.tsx:35`, `StockHub.tsx:13` (state only), `TradingApprovalsQueue.tsx:37`, `brokerEndpoints.ts:15`, `components/StockSearchBar.tsx:7`, `options/DiscoveryRunsPanel.tsx:47`, `scheduledOptionsManager/ScheduleFormModal.tsx:3`.

**Boundary constraint on consolidation:** the client module deliberately does not import the server module — it imports `isBrokerId`/`BrokerId` from `../trading` (client/tenantProviders.ts:17) and mirrors values, with the mirror pinned equal by tests. FirstRun's step module documents the same boundary: "That keeps `src/client/*.ts` out of `src/trading` (the boundary, #290)" (`src/client/firstRunBrokerStep.ts:12-15`). So "consolidate into the one map in `src/services/tenantProviders.ts`" cannot be a literal client import of the server file; the build must either serve the identity through the providers route (§3) or duplicate-with-pin as today. See Q3.

### 2(c) `src/client/stockCopilotApi.ts` — the third copy

- Recorded at ~:218; today the map is at **:231-234**: a module-private `const BROKER_DISPLAY_NAMES: Record<string, string> = { alpaca: "Alpaca", etrade: "E*TRADE" }` (note reversed key order vs the server copy — same two entries).
- Sole consumer: `copilotSelectionLabel(status)` (:243-251, same file) → renders e.g. `"Alpaca · Paper"` / `"Alpaca · Live"` from the copilot status's `activeBroker`/`activeMode`, falling back to the raw id for unknown brokers.
- Sole UI consumer of that: `src/client/StockCopilotPanel.tsx:46,225`.
- This is a *broker-only* copy; there is no data-provider name map in the file.

### 2(d) Name sources the recorded shape did not name

- **Registry adapters carry display names:** `src/trading/dataProviders/adapters.ts` — etrade adapter `name: "E*TRADE"` (:283-284), nasdaq `name: "Nasdaq Listings"` (:958-959), public `name: "Public.com"` (:1190-1191), and yahoo/alpaca built via `createMarketDataProvider("yahoo", "Yahoo Finance", …)` (:822) / the alpaca equivalent. The contract type requires it: `DataProvider.name: string` (`src/trading/dataProviders/contract.ts:194`). These five names are character-identical to both display-name maps above.
- **`BROKER_CATALOG` carries broker labels:** `src/trading/brokerCatalog.ts:196` — per-broker rich entries with `label: "E*TRADE"` (:199) and `label: "Alpaca"` (:252), plus credential guidance, copilot support, trading types. FirstRun consumes labels from here, not from any tenantProviders map (§4.1).
- No `shortName` for any provider exists anywhere in `src/` (the only `shortName` hits are app branding, `src/client/branding.ts:28,49`, and company-name fields in marketDataResearch). No provider docs/help/support URL exists anywhere; the only `displayName` in the provider registry area is the *tenant-configurable per-provider override* in the lifecycle store (`src/trading/dataProviders/lifecycle.ts:187,206,492,590` → `config.displayName`, surfaced in the Data Providers panel's configure dialog) — a different concept from identity metadata.

---

## 3. The delivery path

### 3.1 `GET /api/tenant/settings/providers`

- **Verified at the recorded line:** `src/agents/routes/reports.ts:556` — `if (path.endsWith("/tenant/settings/providers"))`. One handler serves GET and POST (block runs :556-~625).
- Store handling: `createCommercialAdapter(ctx.env)`; no adapter → **503** `{ error: "Tenant store unavailable: AGENT_DB is not bound." }` (:562-564). Tenant resolved server-side via `resolveIaaaTenant` (:566); `ensureCommercialSchema` awaited first.
- **GET response shape (exactly three fields):** `Response.json({ tenantId, dataProviderId, brokerId })` (:568-571). **No identity fields** — no names, no labels, no fallback flags.
- **POST:** body `{ dataProviderId?, brokerId? }` validated by `normalizeTenantProviders` (unknown ids → 400, :578-580); writes via `adapter.setTenantProviders`; audits `tenant_providers.changed`; best-effort `ctx.notifySettingsChanged({ kind: "broker_selection_changed", … })` for the caller's own instance (#3471, :589-605); responds `{ tenantId, dataProviderId, brokerId, updatedAtMs }`.

### 3.2 `useTenantProviders()`

- **Defined:** `src/client/tenantProviders.ts:143-167`. Returns the tuple `[TenantProvidersState, (state) => Promise<TenantProvidersState>]` (state + `saveTenantProviders`).
- Behaviour: initial state from `readTenantProvidersState()` (memory cache → localStorage mirror → defaults); on mount, `loadTenantProvidersFromServer()` (GETs the endpoint, validates both fields are strings) replaces state; subscribes to the `cfagent-tenant-providers-changed` CustomEvent for cross-surface updates. Identity is **not** part of the state — consumers derive labels from the local `DATA_PROVIDER_OPTIONS`/`BROKER_OPTIONS` lists (§2b).
- Consumers of the hook (from the importer list): `AccountPanels.tsx`, `BrokerDynamicMenu.tsx`, `Chat.tsx`, `ETradeTradingHub.tsx`, `OptionsScreenerPage.tsx`, `components/StockSearchBar.tsx`, `scheduledOptionsManager/ScheduleFormModal.tsx`; state-only readers (`readTenantProvidersState`): `FirstRunScreen.tsx`, `StockHub.tsx`, `IvHistoryPanel.tsx`, `brokerEndpoints.ts`, `options/DiscoveryRunsPanel.tsx`.

**Build consequence:** extending `TenantProviderContext` server-side (§1.2) reaches **no** client surface by itself. Every client consumer renders from ids + the local options lists. For UX surfaces to "consume the extended context", the build must extend the GET response (and the client's state/parse) with identity fields — or accept the options lists as the client-side projection of the one map, pinned equal. That is the central delivery decision of the build (Q3).

---

## 4. The five consumer surfaces

### 4.1 FirstRunScreen broker-step copy

- Files: `src/client/FirstRunScreen.tsx` (step 3, "Connect your brokerage", :98) + the pure decision module `src/client/firstRunBrokerStep.ts` (:49-58) + tests `tests/first_run_broker_step_3371.test.ts`, `tests/first_run_screen_2471.test.tsx`, `tests/onboarding_flow_3256.test.tsx`.
- **How identity renders today:** NOT from any tenantProviders map. `FirstRunScreen.tsx:148-155` reads the stored broker id via `readTenantProvidersState().brokerId`, then takes the label from a fourth source — `BROKER_CATALOG[knownBrokerId].label` (`src/trading/brokerCatalog.ts`) — and the credential kind from `brokerCredentialGuidance(knownBrokerId)`, passing both into `firstRunBrokerStep({ broker, label, credentialKind })`. The step copy then interpolates `{brokerStep.label}` throughout (:500-543: "{label} signs in with an API key pair…", "{label} account is connected.", "Connect {label}").
- **What consuming the extended context requires:** the label input to `firstRunBrokerStep` would come from the identity (client-projected) instead of `BROKER_CATALOG.label`. Note the deliberate design (firstRunBrokerStep.ts header): the caller passes the label so the pure module never invents one, and a third broker needs "a catalogue entry, not a new branch here" — rerouting the label source must preserve the catalogue as the credential-kind source, or explicitly move both. Also note `firstRunBrokerStep` coerces any non-`etrade` broker to `"alpaca"` (:50) — broker identity here is effectively binary today.

### 4.2 StockHub provider default/labels

- Files: `src/client/StockHub.tsx` + `src/client/screeningAdapters.ts`; the hub's provider list itself comes from `getScreeningProviders(assetClass)` (screening-provider registry variants, each with its own `label`, screeningAdapters.ts:31,45).
- **How identity renders today:** two separate things. (a) The *default selection*: `StockHub.tsx:243-245` initialises `providerId` via `resolveInitialScreeningProviderId(readTenantProvidersState().dataProviderId, providers)` (screeningAdapters.ts:92-103; tenant→variant map `etrade→etrade`, `yahoo→yahoo-finance` at :87-90; unknown selection → first available variant). (b) The *labels*: the screening variants' own labels — **not** tenant-provider identity at all. StockHub does not render the tenant's provider name from any display-name map; its only tenantProviders import is `readTenantProvidersState` (:13).
- **What consuming the extended context requires:** honestly, very little on labels — the surface's provider names belong to the screening registry, a different provider population (hub variants) from the tenant data-provider ids. The concrete #3751-shaped change here is the *default*: the tenant dataProviderId already flows in via client state; if identity fields ride the §3 delivery path, the hub could label its "following your Settings provider" state (today implicit) with the identity name. Flagging as the weakest of the five surfaces — see Q4.

### 4.3 Data Providers panel source headings

- Files: `src/client/DataProvidersPanel.tsx` (1,747 lines) + `src/client/dataProvidersApi.ts` + server `src/agents/routes/dataProviders.ts` (`providerView` at :371).
- **How identity renders today:** there is no display-name heading. Each provider card is headed by the raw registry id in a code element — `<code className="dpp-item-id">{view.id}</code>` (DataProvidersPanel.tsx:638) — with `Adapter: {view.adapterKind}`, precedence, lifecycle state alongside. `DataProviderView` (dataProvidersApi.ts:83-120) carries `id`, `adapterKind`, lifecycle, config, capabilities, health — **no name field**; `providerView` (dataProviders.ts:371-…) returns the registry record + adapter capabilities and could add `adapter.name` (the registry name of §2d) trivially. A tenant-set `config.displayName` exists but is used only inside the configure dialog (DataProvidersPanel.tsx:560,590), not as the heading.
- **What consuming the extended context requires:** this panel is provider-*population* facing (all registered providers), not tenant-selection facing — `TenantProviderContext` (one tenant's two selections) is the wrong shape for its headings. The identity source that fits is the registry name (§2d) projected through `providerView` → `DataProviderView.name` → heading render. Whether #3751's scope intends the panel headings to come from the tenant context or from the registry projection is a genuine scope question (Q4) — the issue body says "Data Providers panel source headings" under a tenant-config-first resolution order, but the panel does not render the tenant's selection today.

### 4.4 Provenance badges (screening results)

- Server side: provenance carries **ids only**. `withProviderProvenance` (optionsProviderContext.ts:185-190) stamps `dataProviderId`/`brokerId` onto run-record provenance and canonical-report `body.provenance` (both composition sites, §1.3). Schedule payloads stamp the same ids at creation (#3655, `src/trading/screeningSchemas.ts:1216-1231`). The per-element serving-provider provenance of the #1116 composition lives in the screening pipeline (`src/trading/screeningProvider.ts:81` — "Registry provider id (the provenance id stamped on results)").
- Client side: the one place a provenance-ish provider label is rendered from the tenant selection is `src/client/OptionsScreenerPage.tsx:166-171` — `dataProviderLabel`/`brokerLabel` derived by `.find()` over the local `DATA_PROVIDER_OPTIONS`/`BROKER_OPTIONS` lists with raw-id fallback, rendered as "Data provider: {label} · Broker: {label}" with the coded broker-unavailable notice beneath. Other provenance rendering (e.g. `ScannerPanel.tsx` target-provenance chips, :212-229) is about target/signal provenance, not provider identity.
- **What consuming the extended context requires:** server-side, extending the context (§1.2) automatically extends what *could* be stamped — but `withProviderProvenance` deliberately stamps only the two ids today, and run records are persisted data (adding name fields to stored provenance freezes a name at run time; resolving the name at render from the id is the alternative). Client-side, the OptionsScreenerPage `.find()` derivation is exactly the ad-hoc pattern #3751 removes: it becomes a lookup into the one identity map/projection. The render-time-vs-stamp-time choice is Q5.

### 4.5 Platform-service / agent descriptions neutralized in #3525 S4

- What S4 did (PR #3717, merge `2ae07e18`): reworded `src/services/platformKnowledge.ts`, `src/agents/trading-agent.ts`, `src/trading/interfaces.ts` so descriptions "name capabilities, not provider brands"; pinned by `tests/neutrality_platform_services_3525.test.ts` (167 lines).
- **How identity renders today:** these texts are **static strings with no identity interpolation at all** — platformKnowledge's broker mentions are generic ("connected-broker mode", "Live Option Chain Pricing (connected broker & market-data providers)", platformKnowledge.ts:62,157) plus provider-named *data-source lists* baselined as provenance (see §6). There is no "your broker / the selected provider" placeholder string in the current tree: repo-wide grep for those phrases finds only doc-comments, one chat action label ("Preview with your broker", `src/client/chat/OptionsStrategyCard.tsx:444-447`), one select hint in `ScheduleFormModal.tsx:157` (which already interpolates the raw dataProviderId), and one integration-layer error text (`src/aspects/errorCodes.ts:270`, "your broker (E*TRADE) session…" — an E*TRADE-specific outcome, integration territory).
- **What consuming the extended context requires:** platformKnowledge entries and agent descriptions are static catalogue content served without a per-request tenant context in hand at definition time; injecting the tenant's provider name means resolving identity at the *serve* site and templating the strings — a materially bigger change than the other four surfaces, and it would fight the S4 pin (which pins the neutral wording). The issue body scopes this as "the platform-service/agent descriptions neutralized in #3525 S4 **where they refer to 'your broker / the selected provider'**" — on current code, that referent set is arguably empty. Flagged as Q6: confirm this surface is satisfied by the ScheduleFormModal/OptionsStrategyCard-style call sites, or descope it explicitly in the build issue.

---

## 5. Existing tests — the characterization base

Direct pins on the pair, the maps, and the route:

| Test file | Pins |
|---|---|
| `tests/tenant_providers.test.ts` | Id vocabularies + `normalizeTenantProviders`; migration 0027 defaults; in-memory store: **absent row → etrade data / alpaca broker** (:58); `resolveTenantBroker` fail-open to legacy etrade (:100-105); broker-unavailable coded response; unified-record provenance stamping defaults (:107). Imports the server module directly (:11-21). |
| `tests/options_product_slice2_provider_context.test.ts` | The context itself: defaults derived-not-copied (:38-43); absent input → defaults + both fellBack flags (:45); exact-shape `toEqual` on the 4-field context for an explicit selection (:55-63 — **will need the identity fields added**); per-field fallback (:65); broker-surface gating; capability matrix (optionsChains only etrade/public); provenance stamping preserving existing fields (:124). |
| `tests/first_run_broker_step_3371.test.ts` | The FirstRun step decision (label/credential-kind inputs). |
| `tests/first_run_screen_2471.test.tsx`, `tests/onboarding_flow_3256.test.tsx` | FirstRunScreen rendering incl. step 3. |
| `tests/neutrality_defaults_onboarding_3525.test.ts` | #3525 S3 pins: defaults + onboarding neutrality (the fail-to-legacy contract's home territory). |
| `tests/neutrality_platform_services_3525.test.ts` | S4 static-wording pins for §4.5. |
| `tests/neutrality_census_3525.test.ts` | The census pin (§6). |
| `tests/scheduled_effective_mode_3655.test.ts` | Uses `resolveTenantProviders` + real `BROKER_DISPLAY_NAMES` (mock preserves them, :14); schedule provenance stamping. |
| `tests/stock_copilot_settings_webhook_3471.test.ts` | The providers route's settings-changed notification. |
| `tests/broker_surface_hub_gate_3411.test.tsx` | Client `useTenantProviders`/`BROKER_OPTIONS` consumption in the hub gate. |
| `tests/thin_router_inventory.test.ts`, `tests/console_migration_ratchet_3515.test.ts` | Route inventory entries incl. the providers route (shape-agnostic). |

Plus the wide broker-neutrality family that touches the client module's importers (broker_dynamic_menu_*, broker_menu_mode_3419, channel_desk_notice_3429, dynamic_menu_broker_neutral_3419, portfolio_broker_neutral*, voice_*_broker_neutral_*, etradeDisconnect2386, order_page_broker_mode_3669, account_panel_parity_3359, alpaca_bracket_percent_3812, et al.) — regression surface for any change to `src/client/tenantProviders.ts` exports or `useTenantProviders` behaviour.

**No test currently pins:** the GET route's exact response body for providers (only the webhook side-effect), `DATA_PROVIDER_DISPLAY_NAMES` (dead code — unpinned), `copilotSelectionLabel`'s name map specifically, or the Data Providers panel heading text.

---

## 6. The neutrality pin and the involved files

`tests/neutrality_census_3525.test.ts`: `BASELINE` at :250, currently **1126 rows / 8758 lines** (seed assertion :1447-1457), in four disposition sections — PLATFORM (186 rows, starts :251), INTEGRATION (685 rows, starts :439), HISTORICAL (145), NOT-PROVIDER/FALSE-POSITIVE remainder (110). Rows for every file #3751 touches:

| File | Section | Rows (term → lines) |
|---|---|---|
| `src/services/tenantProviders.ts` | INTEGRATION | alpaca 7, etrade 13, nasdaq 2, public.com 1, yahoo 2 |
| `src/services/optionsProviderContext.ts` | INTEGRATION (+NOT-PROVIDER nasdaq 2) | alpaca 3, etrade 16, yahoo 3 |
| `src/client/tenantProviders.ts` | INTEGRATION | alpaca 8, etrade 5, nasdaq 1, public.com 1, yahoo 1 |
| `src/client/stockCopilotApi.ts` | INTEGRATION | alpaca 2, etrade 1 |
| `src/trading/brokerCatalog.ts` | INTEGRATION | alpaca 18, etrade 26 |
| `src/client/DataProvidersPanel.tsx` | PLATFORM | alpaca 1, etrade 17, nasdaq 2, yahoo 1 |
| `src/client/FirstRunScreen.tsx` | PLATFORM | alpaca 3, etrade 32 |
| `src/client/OptionsScreenerPage.tsx` | PLATFORM | etrade 1 |
| `src/client/StockHub.tsx` | PLATFORM (+NOT-PROVIDER nasdaq 2) | etrade 1 |
| `src/services/platformKnowledge.ts` | PLATFORM (+NOT-PROVIDER nasdaq 18) | alpaca 5, etrade 51, yahoo 12 |

Consequences for the build:

- The recorded disposition rule from the pin header: identity metadata that *names the provider as its job* is INTEGRATION; platform-layer framing is PLATFORM and shrink-only. The server map + context extension sit in INTEGRATION files — adding identity fields there raises those files' counts and needs the established header-note disposition in the same PR (the #3876/#3905 pattern: note + totals move).
- **Consolidation shrinks PLATFORM/INTEGRATION rows in the client copies** if name literals leave `src/client/tenantProviders.ts` / `stockCopilotApi.ts` — shrink is always pin-legal, but the recorded seed totals must be recomputed from the pin's own failure output in a clean checkout (standing rule), and the section subtotals in the array comments (PLATFORM 186 / INTEGRATION 685 headers) updated.
- Watch the interaction: `src/client/tenantProviders.ts` is INTEGRATION-baselined *because* naming providers is its job; if the build moves names out of it entirely (served from the route instead), its rows drop toward zero — fine for the pin, but the file's disposition note in the header should be updated to say why.

---

## Drift table — recorded claim (2026-11-08) vs current fact (ccf01c1)

| # | Recorded | Current fact |
|---|---|---|
| D1 | Fail-to-legacy default is `{etrade, etrade}`; "documented safety contract + OWNER DECISION pending" | **Changed by #3812:** `DEFAULT_TENANT_PROVIDERS = { etrade, alpaca }` (commercialPorts.ts:168). `{etrade, etrade}` survives only in stale comments (optionsProviderContext.ts:5, tenantProviders.ts:13, reports.ts:554, one test title) and as the *separate* legacy-surface rule `resolveTenantBroker → "etrade"` (tenantProviders.ts:114-117). The recorded owner decision was effectively taken by #3812's owner rule on #3451. |
| D2 | Composition sites at `src/services/etradeOptionsScreen.ts:317` and `src/services/manualOptionsScreen.ts:109` | Same line numbers, new homes: `src/agents/routes/etradeOptionsScreen.ts:317` and `src/workflows/manualOptionsScreen.ts:109`. |
| D3 | ~37 call sites of the pair/context | **9** `resolveTenantProviders` call sites (7 files), **2** `resolveTenantProviderContext` call sites, `TenantProviderContext` consumed by **2** files. (37 may have counted the whole tenantProviders family's consumers; the pair itself is narrow.) |
| D4 | Shape note: extend `resolveTenantProviderContext`, fields land on `TenantProviderContext` | Pair confirmed, but the context lives in `src/services/optionsProviderContext.ts`, not beside `tenantProviders.ts`; extension point is optionsProviderContext.ts:73-114. The recorded envelope design (claims vs authority pointers) has **no footprint in code** — no envelope type exists at either site; both sites pass the stored row straight through. Implementing the envelope is greenfield, not an extension. |
| D5 | Three display-name copies to consolidate | There are **five** name sources: the three recorded + registry adapter `name`s (adapters.ts) + `BROKER_CATALOG` labels (brokerCatalog.ts). Plus the server's copy (a) is **dead code** (zero consumers). |
| D6 | Client copy is `DATA_PROVIDER_OPTIONS`/`BROKER_OPTIONS` in `src/client/tenantProviders.ts` | Confirmed verbatim (:39-50) — but the file is also the client *state store* and cannot import the server module (client boundary, #290); "consolidate into the one map" needs a delivery mechanism, not an import. |
| D7 | Third copy at `src/client/stockCopilotApi.ts:218` | Now at **:231-234**; broker-only (2 entries); consumed only by `copilotSelectionLabel` → `StockCopilotPanel`. |
| D8 | Route at `src/agents/routes/reports.ts:556` | **Exact** — :556, GET+POST in one block; GET returns only `{tenantId, dataProviderId, brokerId}` (no identity, no fallback flags). |
| D9 | Issue body: identity fields = display name, short name, docs/help URL "where the registry knows it" | The registry knows **none** of short name / docs URL for any provider; only `name` (contract.ts:194, adapters.ts). Short name + URL must be authored somewhere — the recorded "sourced from the registry declarations, no second provider list" has no existing home for them. |
| D10 | Issue body resolution order: tenant config → serving provenance → neutral fallback | Tenant config exists; serving provenance carries ids only and no surface resolves a *name* from it today (OptionsScreenerPage labels come from the tenant selection, not the run's provenance); the neutral fallback does not exist as a concept — unknown ids fall back to the raw id string in client renders (`?? id`) and to the *default provider* (with flags) in the server context. |
| D11 | S4 descriptions "refer to 'your broker / the selected provider'" | No such placeholder strings exist in current platformKnowledge/trading-agent/interfaces text (S4 made them capability-generic, statically). The phrase survives only at chat/select call sites (OptionsStrategyCard, ScheduleFormModal) outside the S4 file set. |

---

## Proposed build file-list

### Production (9 files)

| File | Change |
|---|---|
| `src/services/tenantProviders.ts` | Become the one identity map: extend the display-name maps into a single identity record per id (display name; short name + docs/help URL **if** Q1 lands them here), covering data providers and brokers; keep `BROKER_DISPLAY_NAMES`/`DATA_PROVIDER_DISPLAY_NAMES` as derived projections for their existing consumers (scheduledBrokerGuard, schedules route) or migrate those two consumers. No change to any resolution function or default. |
| `src/services/optionsProviderContext.ts` | Extend `TenantProviderContext` with identity fields (data-provider identity + broker identity, resolved from the one map inside `resolveTenantProviderContext`, incl. the fellBack-aware neutral-vs-default choice per Q2); extend `withProviderProvenance` only if Q5 chooses stamp-time names (default: ids only, unchanged). |
| `src/agents/routes/reports.ts` | Extend the GET providers response with the resolved identity (names for the tenant's two selections, from the extended context) — POST unchanged; comment at :554 corrected (etrade/alpaca). |
| `src/client/tenantProviders.ts` | Parse + carry identity in `TenantProvidersState` (additive, optional fields so older responses still validate); `DATA_PROVIDER_OPTIONS`/`BROKER_OPTIONS` labels derived from the served identity when present, local lists retained as the pre-load mirror; `brokerUnavailableNotice` unchanged in shape. |
| `src/client/stockCopilotApi.ts` | Delete the private `BROKER_DISPLAY_NAMES` copy; `copilotSelectionLabel` resolves via the client identity projection. |
| `src/client/OptionsScreenerPage.tsx` | Replace the `.find()` label derivations (:166-171) with the identity projection. |
| `src/client/FirstRunScreen.tsx` | Label input to `firstRunBrokerStep` from the identity projection instead of `BROKER_CATALOG[knownBrokerId].label` (credential kind stays catalogue-sourced), **if** Q4 confirms FirstRun in the label migration. |
| `src/agents/routes/dataProviders.ts` + `src/client/dataProvidersApi.ts` (+ `DataProvidersPanel.tsx` heading) | **Only if Q4 includes the panel:** `providerView` adds `name` (registry adapter name); `DataProviderView` gains `name`; the card heading renders name with id beneath. |
| `src/services/scheduledBrokerGuard.ts`, `src/agents/routes/schedules.ts` | Only if the map restructure retires `BROKER_DISPLAY_NAMES` as an export — migrate the two consumers to the identity record. (Otherwise untouched.) |

Explicitly NOT in the list: `src/data/commercialPorts.ts` / adapters (defaults untouched), `src/workflows/manualOptionsScreen.ts` + `src/agents/routes/etradeOptionsScreen.ts` (composition sites — they gain fields for free), `platformKnowledge.ts` / `trading-agent.ts` (Q6), `StockHub.tsx` (Q4 — no label change proposed by default).

### Tests (6 files: 2 adapted-shape, 4 new/extended)

| File | Change |
|---|---|
| `tests/options_product_slice2_provider_context.test.ts` | Adapted (disclosed): the exact-shape `toEqual` at :55-63 gains the identity fields; new pins — identity resolves from the one map for two different configured providers; fellBack selections render per the Q2 rule. |
| `tests/tenant_providers.test.ts` | Extended: identity map covers every id in `DATA_PROVIDER_IDS`/`BROKER_IDS` (no id without an identity, no identity without an id); defaults pin (etrade/alpaca) unchanged and re-asserted. |
| `tests/provider_identity_3751.test.ts` (new) | The #3751 acceptance pins end-to-end: GET route serves identity for the tenant's selections; re-pointing the tenant changes the served identity with no code change; unconfigured → per-Q2 neutral/default behaviour; client state parses identity and older id-only responses still validate. |
| `tests/first_run_broker_step_3371.test.ts` / surface test | Only if FirstRun migrates: label-from-identity pin for both brokers. |
| `tests/neutrality_census_3525.test.ts` | Baseline recomputed from a clean checkout: raises in the two server INTEGRATION files (identity records), shrinks in the client copies if literals leave; header disposition note for #3751 + totals move, per the established pattern. |
| `tests/neutrality_platform_services_3525.test.ts` | Only if Q6 keeps §4.5 in scope (default: untouched). |

**Total proposed: 9 production + 6 test files** (core build: 7 production + 4 tests, before the Q4/Q6 conditionals).

---

## Open questions (only where the code genuinely doesn't answer)

- **Q1 — Where do short name and docs/help URL live?** No provider short name or URL exists anywhere in the tree, and the registry contract carries only `name`. Authoring them into the one map in `tenantProviders.ts` contradicts the issue's "sourced from the registry declarations" for those two fields; adding them to the registry contract/adapters is a registry change the recorded shape didn't scope. Owner decision needed: (a) identity = display name only for this slice, short name/URL deferred; or (b) author all fields in the tenantProviders map as the identity home of record; or (c) extend the registry contract.
- **Q2 — Fell-back selections: default provider's identity or neutral identity?** The issue's acceptance says unconfigured/unknown → "honest neutral identity, never a guessed brand", but the platform's post-#3812 contract is that an unconfigured tenant *is* an etrade-data/alpaca-broker tenant (defaults are real selections, flagged via `*FellBack`). Rendering a neutral identity for a tenant whose data genuinely comes from the default provider would mislabel provenance. The code supports either (flags exist); the issue text and the current contract point opposite ways for the broker field especially.
- **Q3 — Client delivery mechanism for "the one map".** The client cannot import the server map (#290 boundary; the client module mirrors by design). Options the code admits: (a) serve identity on the GET providers response and project it client-side (route + state changes, proposed above); (b) keep the client lists as a pinned-equal mirror of the one map (status quo mechanism, weaker than the issue's "no copy edits" acceptance). (a) is the only route that satisfies "re-pointing/changing registry metadata changes the UX with no copy edits" for client surfaces.
- **Q4 — Scope of the panel and StockHub surfaces.** The Data Providers panel renders *all* providers (registry population) and its headings are raw ids; the tenant context is the wrong shape for it — the registry-name projection fits. StockHub renders screening-variant labels, a third population. Confirm whether #3751 means (i) tenant-selection surfaces only (OptionsScreenerPage, FirstRun, copilot label, menus) with the panel taking the registry projection as a sibling change, or (ii) panel/StockHub explicitly descoped.
- **Q5 — Provenance: stamp names at run time or resolve at render?** Run records are persisted; stamping names freezes identity at run time (arguably correct provenance — it names what served *then*), resolving at render always shows today's name for yesterday's run. `withProviderProvenance` stamps ids today; either choice is implementable, the code expresses no preference.
- **Q6 — Is surface 5 (§4.5) empty on current code?** The S4-neutralized descriptions contain no "your broker / selected provider" placeholder to inject into; they are static capability-generic strings pinned by the S4 test. Confirm descoping §4.5 (leaving ScheduleFormModal/OptionsStrategyCard call sites, which already interpolate ids/labels, to the general surface migration) — or name the specific strings intended.
