# CBO commercial/platform UX actions — enumerated from code

Grounded in `origin/main` at `cd094b6f28877dcb3f6e6b74e2b53ff0484fffc4` (2026-11-18 05:34 EST; `git fetch origin main` run first; all reads via `git show origin/main:<path>` / `git grep ... origin/main`). Analysis only; nothing was written to GitHub. All paths below are under `src/client/` unless stated; line numbers are on that tip.

## How to read this

- `B` = `/api/payments/agentic/commercial` (`COMMERCIAL_API_BASE`, `src/data/commercialUrlCatalog.ts:30`). Most commercial calls go through `commercialPath(id)` (`commercialUrlCatalog.ts:159`) or `${BASE}/…`; the resolved path is shown.
- **Counting rule.** One row per distinct labeled control. A control repeated once per data row (per tenant, version, code, subscription) is one *pattern* row marked `(per row)`. A control repeated over a small fixed set (4 families, 3 issuers, 5 channels) gets one row per member, because each is a separately labeled control. Tab switches, expand/collapse, modal open/close, clipboard copies, draft-only form controls, and external share links are listed as `local` / `nav` rows, not counted as HTTP actions.
- **Totals.** 134 HTTP-issuing action rows (see per-surface counts at the end), plus local/navigation rows listed inline. Two broker/trading surfaces that the task file list includes (`AccountPanels.tsx`, `OmnichannelPanel.tsx`) are enumerated but subtotaled separately: excluding them, the CBO commercial/platform total is 114 HTTP actions.
- **Route families seen.** Commercial catalog `B/…`; platform accounts `/api/platform/accounts/…`; platform tenants `/api/platform-tenants/…`; platform channels `/api/platform-channels/…`; legacy payments `/api/payments/…` (PaymentsPage, receipts); referrals/ads `/api/referrals`, `/api/ads`, `/api/external-ads/…`; assurance `/api/assurance/payment-workflow/…`; broker `/api/etrade/…`, `/api/broker/order/cancel`, `/api/trading/…`, `/slack/interactions`; catalog read `/api/products/catalog`.

## 1. View → panel map

Top-level tab routing lives in `Chat.tsx` (`TAB_CONTENT`): `platform-admin` → `PlatformAdminPage` (`Chat.tsx:1069`), `product-hub` → `ProductHub` (`Chat.tsx:1105`), `billing` → `BillingServicingPanel` (`Chat.tsx:1110`), `payment-assurance` → `PaymentWorkflowAssurance` (`Chat.tsx:1121`), `checkout` → `CheckoutPanel` (`Chat.tsx:1126`), `payments` → `PaymentsPage` (`Chat.tsx:1163`). `ReferralsTab` mounts inside `MarketingHubHome.tsx:82` with inner-tab param `referralsTab`.

### `?tab=platform-admin&view=<section>` — PlatformAdminPage.tsx:92-100, 185-246

Config: `platformAdminConfig.ts` (sections/items from `nav-config.json` `platformAdminSections`; ids `ads, provenance, api-keys, tenants, channels, accounts, engine-tuning`). Tab selection calls `handleSelectTab` (`PlatformAdminPage.tsx:141`) → `navigateToTab("platform-admin", section)`.

| view | Panel rendered |
|---|---|
| `ads` | `AdsSection` (PlatformAdminPanel.tsx:77) — banner toggles, localStorage only |
| `provenance` | `ProvenanceSection` (PlatformAdminPanel.tsx:189) — read-only diagnostics text |
| `api-keys` | `ApiKeysPanel` (not in scope) |
| `tenants` | `TenantAdminPanel` |
| `channels` | `ChannelsAdminPanel` |
| `accounts` | `AccountAdminPanel` (embeds SubscriptionGrantSection, UnlimitedFreeGrantSection, FreeAccessGrantSection, AccountVersionMoveSection) |
| `engine-tuning` | `EngineTuningPanel` (options/EtapiConfigModal; not in scope) |

Note: `PlatformAdminPanel.tsx` is the deprecated drawer (`@deprecated`, line 5); its tenants/channels/accounts tabs render `{null}` (lines 387-398) — only ads/provenance/api-keys render there. The page above is canonical. Retired views (`free-runs`, `products` → product-hub; schedules/security sections → their hubs) redirect; see `PlatformAdminPage.tsx:15-42`.

### `?tab=product-hub&view=<tab>` — ProductHub.tsx:81-87, 229-307

| view | Panel rendered |
|---|---|
| `products` | `ProductCatalogPanel` (catalog table + `onSubscribe`/`onPreviewDraft` callbacks into the hub) |
| `selling-options` | `SellingSection` (in ProductCatalogPanel.tsx; hub fetches `GET /api/products/catalog` once on first visit, ProductHub.tsx:148) |
| `marketing-draft-preview` | `MarketingDraftPreviewSection` (in ProductCatalogPanel.tsx; draft composed locally by the hub, ProductHub.tsx:167) |
| `admin-products` | `ProductsSection` (sub-tabs below) + `PriceCatalogueSection` (adjacent, not in task file list — not enumerated) |
| `free-runs` | `FreeRunAllowanceSection` |

`ProductsSection` sub-tabs on param `adminTab` (ProductsSection.tsx:289-293): `products` (list + per-product detail), `create-product`, `create-version`.

### `?tab=billing&view=<tab>` — BillingServicingPanel.tsx:116-128, 269-479

| view | Panel rendered |
|---|---|
| `overview` | Inline read-only cards (tier, subscription, receipts, plans, bundles, referral credits) |
| `refund-policy` | `RefundPolicySection` (adjacent, not in task file list — not enumerated) |
| `refund-flow` | `RefundFlowSection` (adjacent, not enumerated) |
| `usage-billing` | `UsageBillingSection` |
| `referral-codes` | `ReferralCodesSection` |
| `approved-free-quota` | `ApprovedFreeQuotaSection` |
| `top-up-limits` | `TopUpLimitsSection` (adjacent, not enumerated; uses `setTopUpLimits`, billingPolicyApi.ts:167) |
| `offer-rules` | `OfferRulesSection` |
| `plan-stripe-price` | `PlanStripePriceSection` (adjacent, not enumerated; uses `setStripePriceByPlan`, billingPolicyApi.ts:223) |
| `billing-policy` | `BillingPolicySection` |
| `support-snapshot` | Inline read-only card |

### `?tab=checkout` — CheckoutPanel.tsx:800-802 (tabs `pay`, `subscriptions`, `topup`; deep links use `checkoutTab=`)

One component, three tab bodies; identity display shared by all tabs. `UpgradeOffer` (quota-exhausted) embeds in the pay tab (CheckoutPanel.tsx:918); `AmbientOfferCompare` embeds in the subscriptions tab (CheckoutPanel.tsx:1003).

### `?tab=payments&view=<tab>` — PaymentsPage.tsx:28-34

| view | Panel rendered |
|---|---|
| `gateways` | Inline gateway cards (read-only) |
| `stats` | Inline stat cards (read-only) |
| `wallet` | `AgenticWalletPanel` (adjacent, not enumerated) |
| `create` | Inline create-payment form |
| `ledger` | Inline transaction ledger with HITL authorize/reject |

### `?tab=payment-assurance&view=<tab>` — PaymentWorkflowAssurance.tsx:413-417

| view | Panel rendered |
|---|---|
| `simulation` | Inline simulator (in-browser fakes only, no HTTP) |
| `live` | Inline live-workflow controls (`/api/assurance/payment-workflow/…`) |
| `prices` | `PriceApprovalSection` (same file) |
| `operators` | `StoreOperatorsPanel` (adjacent, not enumerated) |

### ReferralsTab inner tabs — chat/tabs/ReferralsTab.tsx:64-69

`share`, `activity`, `links`, `community`. All handlers arrive as props from `Chat.tsx`; routes resolved there (see table).

## 2. Actions per surface

### 2.1 PlatformAdminPage.tsx — 0 HTTP actions

Tab switches only (`handleSelectTab`, :141, navigation, no HTTP). The ads toggles rendered here are `AdsSection` (counted in 2.2). No buttons of its own. Read-only display: none beyond tab strip and section headers.

### 2.2 PlatformAdminPanel.tsx (AdsSection / ProvenanceSection / AdminAccessSection) — 1 HTTP action

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Workspace Banners OFF/ON | PlatformAdminPanel.tsx:106 | `onToggleMaster` prop → `toggleMaster` (PlatformAdminPage.tsx:159) | none — local | `saveStoredAdBannerConfig` (adBannerConfig.ts, via PlatformAdminPage.tsx:153) | localStorage only; no HTTP |
| Sponsor Spotlight OFF/ON | PlatformAdminPanel.tsx:124 | `onToggleOption` prop → `toggleOption` (PlatformAdminPage.tsx:164) | none — local | as above | localStorage only |
| Ad Network Strip OFF/ON | PlatformAdminPanel.tsx:139 | `onToggleOption` prop | none — local | as above | localStorage only |
| Google Ad Units OFF/ON | PlatformAdminPanel.tsx:154 | `onToggleOption` prop | none — local | as above | localStorage only |
| Browse Partner Deals & Cloud Credits (External) | PlatformAdminPanel.tsx:171 | inline `onClick` (:173) | none — local | — | calls `onOpenPartnerDeals` prop or dispatches `open-partner-deals-modal` event; no HTTP in this file |
| Request admin access | PlatformAdminPanel.tsx:266 | `onRequest` prop → `requestAdminAccess` (SecurityHubHome.tsx:77) | POST `/api/iaaa/access-request` | direct `fetch` (SecurityHubHome.tsx:81) | Payload `{requestedRole: "tenant-admin"}`; 201/409/status text shown. NOTE: this section is mounted in SecurityHubHome.tsx:131, not in Platform Admin; the drawer never renders it |

Read-only display: `ProvenanceSection` (:189) — static DID/architecture/attestation/ledger text, no actions.

### 2.3 TenantAdminPanel.tsx — 7 HTTP actions

Helper: `tenantAdminApi.ts` (all calls via `apiFetch` with 30s bound, :29/73).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Create tenant | TenantAdminPanel.tsx:179 | `handleCreate` (:111) | POST `/api/platform-tenants` | `createTenant` (tenantAdminApi.ts:88) | `{tenantId}`; created `tenantId` shown in success notice; list reloaded, detail opened |
| Manage (per row) | TenantAdminPanel.tsx:200 | `loadDetail` (:94) | GET `/api/platform-tenants/:id` + GET `/api/iaaa/memberships` | `fetchTenantDetail` (tenantAdminApi.ts:98); `fetchMemberships` (iaaaAdminApi.ts:204) | Detail + memberships filtered by tenant rendered below; no write |
| Ads enabled for this tenant (checkbox) | TenantAdminPanel.tsx:220 | `handleSaveSettings` (:137) | PATCH `/api/platform-tenants/:id/settings` | `updateTenantSettings` (tenantAdminApi.ts:112) | `{adsEnabled}`; returned settings replace detail; list reloaded |
| Auto-refresh enabled (checkbox) | TenantAdminPanel.tsx:226 | `handleSaveSettings` (:137) | PATCH `/api/platform-tenants/:id/settings` | `updateTenantSettings` (tenantAdminApi.ts:112) | `{autoRefresh: {enabled, intervalS}}`; as above |
| Auto-refresh interval, on blur | TenantAdminPanel.tsx:236 | inline `onBlur` (:241) → `handleSaveSettings` | PATCH `/api/platform-tenants/:id/settings` | `updateTenantSettings` (tenantAdminApi.ts:112) | `{autoRefresh: {enabled, intervalS}}` (only if positive integer); as above |
| Data provider id, on blur | TenantAdminPanel.tsx:250 | inline `onBlur` (:254) → `handleSaveSettings` | PATCH `/api/platform-tenants/:id/settings` | `updateTenantSettings` (tenantAdminApi.ts:112) | `{providers: {dataProviderId, brokerId}}` (only if non-empty); as above |
| Broker id, on blur | TenantAdminPanel.tsx:262 | inline `onBlur` (:266) → `handleSaveSettings` | PATCH `/api/platform-tenants/:id/settings` | `updateTenantSettings` (tenantAdminApi.ts:112) | `{providers: {dataProviderId, brokerId}}` (only if non-empty); as above |

Read-only display: tenant list table; account-members table; IAAA memberships table (explicitly read-only — grants/revokes live on IAAA Admin).

### 2.4 ChannelsAdminPanel.tsx — 6 HTTP actions

Helper: `channelAdminApi.ts`. Channel list: `TENANT_CHANNEL_META` (channelAdminApi.ts:19).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Tenant select button (per row; label = tenant id) | ChannelsAdminPanel.tsx:128 | `loadChannels` (:79) | GET `/api/platform-channels/:id` | `fetchTenantChannels` (channelAdminApi.ts:49) | Config rendered as checkboxes; no write |
| Email (checkbox) | ChannelsAdminPanel.tsx:145 | `handleToggle` (:93) | PATCH `/api/platform-channels/:id/channels` | `updateTenantChannels` (channelAdminApi.ts:59) | `{channels: {email: bool}}`; returned config replaces state |
| Slack (checkbox) | ChannelsAdminPanel.tsx:145 | `handleToggle` (:93) | PATCH `/api/platform-channels/:id/channels` | `updateTenantChannels` (channelAdminApi.ts:59) | `{channels: {slack: bool}}`; as above |
| Webhook (checkbox) | ChannelsAdminPanel.tsx:145 | `handleToggle` (:93) | PATCH `/api/platform-channels/:id/channels` | `updateTenantChannels` (channelAdminApi.ts:59) | `{channels: {webhook: bool}}`; as above |
| Copilot card (checkbox) | ChannelsAdminPanel.tsx:145 | `handleToggle` (:93) | PATCH `/api/platform-channels/:id/channels` | `updateTenantChannels` (channelAdminApi.ts:59) | `{channels: {copilot: bool}}`; config-only (no dispatch consults it yet) |
| Docs (checkbox) | ChannelsAdminPanel.tsx:145 | `handleToggle` (:93) | PATCH `/api/platform-channels/:id/channels` | `updateTenantChannels` (channelAdminApi.ts:59) | `{channels: {docs: bool}}`; config-only |

Read-only display: tenant list (buttons above); per-channel description text. No URLs/tokens/secrets are collected. Tenant list read: `fetchTenants` (tenantAdminApi.ts:80).

### 2.5 OmnichannelPanel.tsx — 8 HTTP actions (trading-desk simulators; handlers in parent hub)

Props-driven; all handlers arrive from `ETradeTradingHub.tsx:2408`. Routes resolved in the hub, not this file. Included because the task file list names it; it is a trading surface, not a commercial surface.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Quote NVDA / Screen Price Range / Buy 10 NVDA (email preset chips) | OmnichannelPanel.tsx:141,149,157 | inline `onClick` (set subject/body) | none — local | — | Fills the email form only |
| APPROVE {orderId} (chip, when a draft exists) | OmnichannelPanel.tsx:166 | inline `onClick` | none — local | — | Fills the email form only |
| Send Test Email to Agent | OmnichannelPanel.tsx:177 | `handleSimulateEmail` prop → ETradeTradingHub.tsx:507 | POST `/api/trading/email/inbound` | direct `fetch` (ETradeTradingHub.tsx:511) | `{from, to: "trade@agent.openaimp.com", subject, text}` + `x-environment`; reply rendered; orders refetched on preview/approval |
| Install to Workspace (link) | OmnichannelPanel.tsx:237 | `href` | GET `/slack/install` (navigation, new tab) | — | Slack OAuth install; no response consumed here |
| Quote NVDA (Slack chip) | OmnichannelPanel.tsx:255 | `handleSimulateSlack` prop → ETradeTradingHub.tsx:533 | POST `/api/trading/slack/test` | direct `fetch` (ETradeTradingHub.tsx:538) | `{type: "event_callback", event: {type: "app_mention", text: "@<bot> quote NVDA", channel, user, ts}}`; Block Kit result rendered |
| Screen Price Range (Slack chip) | OmnichannelPanel.tsx:263 | `handleSimulateSlack` prop | POST `/api/trading/slack/test` | direct `fetch` (ETradeTradingHub.tsx:538) | As above, screen prompt text |
| Buy 10 NVDA Ticket (Slack chip) | OmnichannelPanel.tsx:271 | `handleSimulateSlack` prop | POST `/api/trading/slack/test` | direct `fetch` (ETradeTradingHub.tsx:538) | As above, preview-buy prompt text |
| Portfolio (Slack chip) | OmnichannelPanel.tsx:279 | `handleSimulateSlack` prop | POST `/api/trading/slack/test` | direct `fetch` (ETradeTradingHub.tsx:538) | As above, portfolio prompt text |
| Simulate Slack Message | OmnichannelPanel.tsx:289 | `handleSimulateSlack()` prop | POST `/api/trading/slack/test` | direct `fetch` (ETradeTradingHub.tsx:538) | As above, free-typed prompt text |
| Block Kit action buttons (per element; label from server block) | OmnichannelPanel.tsx:340 | `handleSlackActionButton` prop → ETradeTradingHub.tsx:564 | POST `/slack/interactions` | direct `fetch` (ETradeTradingHub.tsx:567) | Form-encoded `payload` `{type: "block_actions", actions: [{action_id, value: orderId}]}`; `replacementBlocks` replace the card; orders/positions refetched |

Read-only display: desk info cards (inbound address, URLs, commands); agent email reply; Slack Block Kit card viewer.

### 2.6 AccountAdminPanel.tsx — 4 HTTP actions

Direct `apiFetch` calls (no dedicated helper); commercial paths via `commercialPath`.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Set up account (only when no account) | AccountAdminPanel.tsx:339 | `runSetup` (:179) | POST `/api/platform/accounts/setup` | direct `apiFetch` (:183) | No body; `created` flag picks the note text; self view reloaded |
| Look up account | AccountAdminPanel.tsx:415 | `runLookup` (:202) | GET `/api/platform/accounts/lookup?userId=<login>` | direct `apiFetch` (:213) | Result prefills tier/credits/included-runs; mutation forms + grant sections appear |
| Save account | AccountAdminPanel.tsx:446 | `runUpsert` (:238) | POST `B/account` | direct `apiFetch` + `commercialPath("account")` (:243) | `{userId, tenantId, tier, creditsUSD?, includedRuns?}`; note shown; lookup re-run |
| Adjust credits | AccountAdminPanel.tsx:456 | `runCreditAdjust` (:268) | POST `B/account/credits` | direct `apiFetch` + `commercialPath("accountCredits")` (:278) | `{userId, deltaUSD}`; note shows delta; lookup re-run |

Read-only display: own identity block; subscriptions table; price-catalogue bindings table. Self read on mount: GET `/api/platform/accounts/self` (:154, `loadSelf`). Grant/version-move sections embedded here are counted in 2.8–2.11.

### 2.7 AccountPanels.tsx — 12 HTTP actions (broker surface, count separately)

E*TRADE broker panel inside the trading hub, NOT the platform accounts surface. Helper: `accountApi.ts` (broker API; all calls send `x-environment` header, `accountApi.ts:58/65`). Two-step destructive flow: first click arms, second confirms (`armOrRun`, :131); labels show `Sure?` while armed.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| ↻ reload alerts | AccountPanels.tsx:171 | `loadAlerts` (:81) | GET `/api/etrade/alerts?count=50` | `fetchAlerts` (accountApi.ts:88) | List refreshed |
| ↻ reload transactions | AccountPanels.tsx:198 | `loadTransactions` (:92) | GET `/api/etrade/transactions` | `fetchTransactions` (accountApi.ts:106) | List refreshed |
| ↻ reload watchlists | AccountPanels.tsx:228 | `loadWatchlists` (:102) | GET `/api/etrade/watchlists` | `fetchWatchlists` (accountApi.ts:117) | List refreshed |
| ↻ reload orders | AccountPanels.tsx:259 | `loadOrders` (:112) | GET `/api/etrade/orders` | `fetchRemoteOrders` (accountApi.ts:161) | List refreshed |
| Alert row button (label = alert name) | AccountPanels.tsx:178 | inline → `loadAlertDetail` | GET `/api/etrade/alerts/:id` | `fetchAlertDetails` (accountApi.ts:95) | Detail rendered inline |
| Transaction row button | AccountPanels.tsx:205 | inline → `loadTransactionDetail` | GET `/api/etrade/transactions/:id` | `fetchTransactionDetails` (accountApi.ts:111) | Detail rendered inline |
| Watchlist row button | AccountPanels.tsx:234 | inline → `loadWatchlistDetail` | GET `/api/etrade/watchlists/:id` | `fetchWatchlistDetails` (accountApi.ts:122) | Detail rendered inline |
| Delete alert (two-step, per row) | AccountPanels.tsx:182 | `armOrRun` (:131) → `runDeleteAlert` | DELETE `/api/etrade/alerts/:id` | `deleteAlert` (accountApi.ts:100) | List reloaded |
| Delete watchlist (two-step, per row) | AccountPanels.tsx:238 | `armOrRun` → `runDeleteWatchlist` | DELETE `/api/etrade/watchlist/delete?id=<id>` | `deleteWatchlist` (accountApi.ts:155) | List reloaded |
| Create (watchlist) | AccountPanels.tsx:250 | `runCreateWatchlist` | POST `/api/etrade/watchlist/create` | `createWatchlist` (accountApi.ts:147) | `{name, symbols}`; list reloaded |
| Save as screen (watchlist) | AccountPanels.tsx:251 | `runSaveScreen` | POST `/api/etrade/watchlist/save-screen` | `saveScreenAsWatchlist` (accountApi.ts:151) | `{name, symbols}`; list reloaded |
| Cancel order (two-step, OPEN orders only) | AccountPanels.tsx:271 | `armOrRun` → `runCancelOrder` | POST `/api/broker/order/cancel` | `cancelRemoteOrder` (accountApi.ts:166) | `{orderId}`; list reloaded |

Local only: panel collapse toggles (AccountPanels.tsx:150). Read-only display: the four lists themselves.

### 2.8 AccountVersionMoveSection.tsx — 2 HTTP actions

Direct `apiFetch` with literal suffix paths on the commercial base (these suffixes are NOT ids in `commercialUrlCatalog`). POSTs send no explicit `Content-Type` header (:110/:138).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Move to vN (per subscription row) | AccountVersionMoveSection.tsx:203 | `move` (:104) | POST `B/subscriptions/:id/move` | direct `apiFetch` (:110) | `{toVersionId, reason: string \| null}`; note shown; account + products reloaded |
| Change segment | AccountVersionMoveSection.tsx:244 | `changeSegment` (:128) | POST `B/accounts/:userId/segment` | direct `apiFetch` (:138) | `{segment, reason: string \| null}`; note shown; account reloaded |

Read-only display: account summary; subscriptions list; versions per product. Load on mount (:67): GET `B/account?userId=` (:72) + GET `B/products` (:73).

### 2.9 SubscriptionGrantSection.tsx — 1 HTTP action

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Grant subscription | SubscriptionGrantSection.tsx:137 | `runGrant` (:70) | POST `B/subscription/grant` | direct `apiFetch` + `commercialPath("subscriptionGrant")` (:76) | `{userId: targetLogin, planId}`; note shows included runs + period end; `onGranted` re-runs the account lookup |

Read-only display: plan select (local state; options from `listPlans`, commercialApi.ts:294, loaded on mount).

### 2.10 UnlimitedFreeGrantSection.tsx — 2 HTTP actions

Both write the whole account record via the account upsert (no dedicated grant route).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Grant unlimited free | UnlimitedFreeGrantSection.tsx:228 | `runGrant` (:171) → `postGrant` (:131) | POST `B/account` | direct `apiFetch` + `commercialPath("account")` (:137) | Full upsert `{userId, tenantId, tier, creditsUSD, includedRuns, unlimitedFreeGrant: {…}}`; note + `onGranted` reload |
| Revoke grant | UnlimitedFreeGrantSection.tsx:234 | `runRevoke` → `postGrant` (:131) with `null` | POST `B/account` | direct `apiFetch` + `commercialPath("account")` (:137) | Same upsert with `unlimitedFreeGrant: null`; note + reload |

Read-only display: current grant state (granted-by/at, reason). Load on mount: GET `B/account?userId=` (:100).

### 2.11 FreeAccessGrantSection.tsx — 2 HTTP actions

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Grant free access | FreeAccessGrantSection.tsx:298 | `runGrant` (:160) | POST `B/free-access/grant` | direct `apiFetch` + `commercialPath("freeAccessGrant")` (:182) | `{userId, kind, expiresAtMs, reason}`; grant reloaded; note shown |
| Revoke grant | FreeAccessGrantSection.tsx:304 | `runRevoke` (:207) | POST `B/free-access/revoke` | direct `apiFetch` + `commercialPath("freeAccessRevoke")` (:211) | `{userId}`; 404 means "already gone, reloaded"; note shown |

Read-only display: current grant (kind, expiry, reason). Load on mount: GET `B/free-access?userId=` (:125).

### 2.12 FreeRunAllowanceSection.tsx — 4 HTTP actions

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Save Stock allowance | FreeRunAllowanceSection.tsx:174 | `saveFamily` (:114) | POST `B/free-run-allowance` | direct `apiFetch` + `commercialPath("freeRunAllowance")` (:125) | `{family: "stock", runs}`; allowance reloaded; note shown |
| Save Goal allowance | FreeRunAllowanceSection.tsx:174 | `saveFamily` (:114) | POST `B/free-run-allowance` | direct `apiFetch` + `commercialPath("freeRunAllowance")` (:125) | `{family: "goal", runs}`; as above |
| Save Options allowance | FreeRunAllowanceSection.tsx:174 | `saveFamily` (:114) | POST `B/free-run-allowance` | direct `apiFetch` + `commercialPath("freeRunAllowance")` (:125) | `{family: "options", runs}`; as above |
| Save Strategy allowance | FreeRunAllowanceSection.tsx:174 | `saveFamily` (:114) | POST `B/free-run-allowance` | direct `apiFetch` + `commercialPath("freeRunAllowance")` (:125) | `{family: "strategy", runs}`; as above |

Read-only display: current allowance per family (numbers). Families: `FREE_RUN_FAMILIES` = stock/goal/options/strategy.

### 2.13 ApprovedFreeQuotaSection.tsx — 8 HTTP actions

Helper: `approvedFreeQuotaApi.ts`. Operator gating via `isStoreOperator` (:225, through `listOperators` → GET `B/operators`).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Retry (after load error) | ApprovedFreeQuotaSection.tsx:251 | `load` (:136) | GET `B/approved-free-quota` (+ `B/operators` probe) | `getApprovedFreeQuota` (approvedFreeQuotaApi.ts:160); `isStoreOperator` (:225) | Fresh quota + settings rendered |
| Look up quota | ApprovedFreeQuotaSection.tsx:285 | `lookup` (:230) | GET `B/approved-free-quota?userId=<login>` | `getApprovedFreeQuota` (approvedFreeQuotaApi.ts:160) | Other user's quota rendered |
| Save Stock cap | ApprovedFreeQuotaSection.tsx:309 | `saveCap` (:171) | POST `B/approved-free-quota` | `setApprovedFreeQuotaCap` (approvedFreeQuotaApi.ts:166) | `{family: "stock", capRuns}`; response only feeds the note; fresh read rendered |
| Save Goal cap | ApprovedFreeQuotaSection.tsx:309 | `saveCap` (:171) | POST `B/approved-free-quota` | `setApprovedFreeQuotaCap` (approvedFreeQuotaApi.ts:166) | `{family: "goal", capRuns}`; as above |
| Save Options cap | ApprovedFreeQuotaSection.tsx:309 | `saveCap` (:171) | POST `B/approved-free-quota` | `setApprovedFreeQuotaCap` (approvedFreeQuotaApi.ts:166) | `{family: "options", capRuns}`; as above |
| Save Strategy cap | ApprovedFreeQuotaSection.tsx:309 | `saveCap` (:171) | POST `B/approved-free-quota` | `setApprovedFreeQuotaCap` (approvedFreeQuotaApi.ts:166) | `{family: "strategy", capRuns}`; as above |
| Save quota window | ApprovedFreeQuotaSection.tsx:331 | `saveWindow` (:198) | POST `B/approved-free-quota` | `setApprovedFreeQuotaSettings` (approvedFreeQuotaApi.ts:195) | `{windowKind}`; as above |
| Save at-limit action | ApprovedFreeQuotaSection.tsx:346 | `saveAction` (:214) | POST `B/approved-free-quota` | `setApprovedFreeQuotaSettings` (approvedFreeQuotaApi.ts:195) | `{atLimitAction}`; as above |

Read-only display: current caps, window, at-limit action, per-user usage counts.

### 2.14 ProductsSection.tsx — 17 HTTP actions

Direct `apiFetch` + `commercialPath`; several routes are literal suffixes not in the URL catalog (marked `*`). Sub-tabs on param `adminTab` (:289-293). Forms dispatch by product kind (:1202-1218): `subscription` → version form, `per-run` → catalogue form, `runs_pack` → pack form. All non-Free products show referral panels (:561-1199).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Save ladder position (per product, except Free) | ProductsSection.tsx:270 | `saveRank` (:230) | POST `B/products/:id/rank` * | direct `apiFetch` (:245) | `{rank: number \| null}`; product list reloaded |
| Create product | ProductsSection.tsx:499 | `createProduct` (:343) | POST `B/products` | direct `apiFetch` + `commercialPath("products")` (:364) | `{name, kind, description, rank?}`; product list reloaded; form cleared |
| Save rule (platform admin issuer) | ProductsSection.tsx:798 | `saveRule` (:683) | POST `B/referral-code-rules` | direct `apiFetch` (:715) | 10 fields incl. `runsPerCode, reusable, expiryDays, attributionMode, caps, active`; rules reloaded |
| Save rule (tenant admin issuer) | ProductsSection.tsx:798 | `saveRule` (:683) | POST `B/referral-code-rules` | direct `apiFetch` (:715) | Same 10 fields, issuer `tenant_admin`; as above |
| Save rule (user issuer) | ProductsSection.tsx:798 | `saveRule` (:683) | POST `B/referral-code-rules` | direct `apiFetch` (:715) | Same 10 fields, issuer `user`; as above |
| Issue code | ProductsSection.tsx:983 | `issueCode` (:900) | POST `B/referral-codes/issue` | direct `apiFetch` (:910) | `{productId, issuerKind}`; plaintext code shown ONCE; codes reloaded |
| Revoke (per code) | ProductsSection.tsx:1011 | `revokeCode` (:937) | POST `B/referral-codes/revoke` | direct `apiFetch` (:941) | `{codeId}`; codes reloaded |
| Approve vN (per version) | ProductsSection.tsx:1174 | `approveVersion` (:1045) | POST `B/products/:id/versions/:vid/approve` * | direct `apiFetch` (:1050) | `{}`; versions reloaded |
| Deactivate vN (per version) | ProductsSection.tsx:1183 | `deactivateVersion` (:1062) | POST `B/products/:id/versions/:vid/deactivate` * | direct `apiFetch` (:1067) | `{}`; versions reloaded |
| Create version (subscription kind) | ProductsSection.tsx:1434 | `createVersion` (:1297) | POST `B/products/:id/versions` | direct `apiFetch` (:1332) | `{priceUSD, periodDays, includedRuns, trialDays, segment, effectiveFromMs, effectiveToMs, billingPeriod, features, stripePriceId}`; versions reloaded |
| Create catalogue version (per-run kind) | ProductsSection.tsx:1553 | `createCatalogueVersion` (:1473) | POST `B/catalogue/versions` | direct `apiFetch` + `commercialPath("catalogueVersions")` (:1493) | `{family, priceUSD, segment, effectiveFromMs, effectiveToMs}`; catalogue reloaded |
| Preview move | ProductsSection.tsx:1702 | `runPreview` (:1607) | POST `B/products/:id/bulk-move` * | direct `apiFetch` (:1602) | `{segmentScope, reason, dryRun: true}`; affected-holder count shown |
| Move N holders | ProductsSection.tsx:1743 | `runMove` (:1629) | POST `B/products/:id/bulk-move` * | direct `apiFetch` (:1602) | `{segmentScope, reason}`; move record + history reloaded |
| Resume bulk move (from result) | ProductsSection.tsx:1761 | `runMove` (:1629) | POST `B/products/:id/bulk-move` * | direct `apiFetch` (:1602) | `{segmentScope, reason, resumeBulkMoveId}`; as above |
| Resume (from history, per move) | ProductsSection.tsx:1797 | `runMove` (:1629) | POST `B/products/:id/bulk-move` * | direct `apiFetch` (:1602) | `{resumeBulkMoveId}` + scope/reason; as above |
| Show/Hide per-customer moves (per history row) | ProductsSection.tsx:1793 | `loadDetail` (:1649) | GET `B/products/:id/bulk-moves/:moveId` * | direct `apiFetch` (:1654) | Per-customer move rows expanded inline |
| Create pack version (runs_pack kind) | ProductsSection.tsx:1933 | `createPackVersion` (:1848) | POST `B/products/:id/versions` | direct `apiFetch` (:1873) | `{runs, priceUSD, segment, effectiveFromMs, effectiveToMs}`; versions reloaded |

Local only: `View versions`/`Collapse` (:450), Cancel buttons, New-version/catalogue/pack openers, `Use suggestion` (:1383, fills price field), segment filter (:1094), sub-tab switches, link to `?tab=payment-assurance` (:1167, navigation). Read-only display: product list; version tables; referral code list; bulk-move history.

### 2.15 ProductCatalogPanel.tsx (ProductCatalogPanel + SellingSection + MarketingDraftPreviewSection) — 8 HTTP actions

Local `getJson`/`postJson` helpers (:258/:271, direct `fetch`, no named `*Api.ts`). Catalog read: GET `/api/products/catalog` (:1073).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Show selling options | ProductCatalogPanel.tsx:730 | `openSellingOptions` (:474) | GET `B/subscription` + GET `B/plans` + GET `B/bundles` | `getJson` (:258) via `commercialPath` | Identity + subscription + plans + bundles rendered |
| Start checkout (per plan) | ProductCatalogPanel.tsx:783 | `subscribe` (:494) | POST `B/subscription/billing-checkout` | `postJson` (:271) via `commercialPath("subscriptionBillingCheckout")` (:499) | `{planId}`; `checkoutUrl` opened in a new tab; mint id + price shown |
| Start free trial (per plan) | ProductCatalogPanel.tsx:788 | `startTrial` (:588) | POST `B/subscription/trial` | `postJson` via `commercialPath("subscriptionTrial")` (:593) | `{planId}`; trial status + note shown |
| I have paid (per plan) | ProductCatalogPanel.tsx:827 | `confirmPaid` (:518) | POST `B/subscription/billing-purchase` | `postJson` via `commercialPath("subscriptionBillingPurchase")` (:522) | `{checkoutSessionId}` (mint id); activation note; status reloaded |
| Start bundle checkout (per bundle) | ProductCatalogPanel.tsx:857 | `bundleSubscribe` (:542) | POST `B/subscription/bundle-checkout` | `postJson` via `commercialPath("bundleCheckout")` (:547) | `{bundleId}`; `checkoutUrl` opened in a new tab |
| I have paid (per bundle) | ProductCatalogPanel.tsx:884 | `bundleConfirmPaid` (:566) | POST `B/subscription/bundle-purchase` | `postJson` via `commercialPath("bundlePurchase")` (:570) | `{checkoutSessionId}`; activation note; status reloaded |
| Start channel checkout | ProductCatalogPanel.tsx:923 | `channelMint` (:609) | POST `B/channel/checkout` | `postJson` via `commercialPath("channelCheckout")` (:614) | `{family, email}`; expects 201; draft id + expected price shown |
| I have paid (per channel draft) | ProductCatalogPanel.tsx:944 | `channelConfirmPaid` (:635) | POST `B/channel/purchase` | `postJson` via `commercialPath("channelPurchase")` (:639) | `{channelRequestId}`; confirmation note |

Local/navigation only: `Subscribe` (:1122) and `Preview draft` (:1143) are prop callbacks into ProductHub (hub tab switch / local draft compose, no HTTP here); `Manage or cancel` link (:758) navigates to `?tab=checkout&checkoutTab=subscriptions`; purchase-path link (:1133) href comes from server row data (`row.purchasePath.route`) — value not statically enumerable (settled by a live GET `/api/products/catalog` response); trial-end `AmbientOfferCompare` buttons (:710/:719) navigate to checkout with offer params. `MarketingDraftPreviewSection`: channel Select only (:1226), no HTTP. Read-only display: catalog table; plan/bundle/channel cards.

### 2.16 ProductHub.tsx — 0 own HTTP actions

Five tab switches only (:81-87). The selling-options visit triggers a mount-effect GET `/api/products/catalog` (:148) — an effect read, not a button action. `handlePreviewDraft` (:167) composes a draft locally; `handleSubscribe` (:191) switches tab to selling-options. No buttons of its own.

### 2.17 ReferralCodesSection.tsx (self-service, Billing tab) — 7 HTTP actions

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Retry (after load error) | ReferralCodesSection.tsx:260 | `load` (:144) | GET `B/identity` + GET `B/referral-codes/balance` + GET `B/referral-codes/mine` | `fetchPlatformIdentity` (firstRunApi.ts:249); `loadBalance` (:133); `loadOwnCodes` (:127) | Balance + own codes re-rendered |
| Redeem code | ReferralCodesSection.tsx:279 | `redeem` (:168) | POST `B/referral-codes/redeem` | direct `apiFetch` (:182) | `{code}`; `runsGranted`, `codeRunsBalance`, `replayed` shown; balance reloaded |
| Get my referral code (Stock) | ReferralCodesSection.tsx:307 | `mint` (:199) | POST `B/referral-codes/mine` | direct `apiFetch` (:204) | `{productId: "prod-per-run-stock"}`; plaintext code shown once; rule-unavailable 409 hides that family |
| Get my referral code (Goal) | ReferralCodesSection.tsx:307 | `mint` (:199) | POST `B/referral-codes/mine` | direct `apiFetch` (:204) | `{productId: "prod-per-run-goal"}`; as above |
| Get my referral code (Options) | ReferralCodesSection.tsx:307 | `mint` (:199) | POST `B/referral-codes/mine` | direct `apiFetch` (:204) | `{productId: "prod-per-run-options"}`; as above |
| Get my referral code (Strategy) | ReferralCodesSection.tsx:307 | `mint` (:199) | POST `B/referral-codes/mine` | direct `apiFetch` (:204) | `{productId: "prod-per-run-strategy"}`; as above |
| Revoke (own code, per row) | ReferralCodesSection.tsx:330 | `revokeOwn` (:227) | POST `B/referral-codes/mine/revoke` | direct `apiFetch` (:230) | `{codeId}`; codes reloaded |

Read-only display: referral balance; own codes list. `perRunProductId` = `` `prod-per-run-${family}` `` (productPorts.ts:58).

### 2.18 OfferRulesSection.tsx — 2 HTTP actions

Helper: `billingPolicyApi.ts`. Offer-rules shape: `OfferRulesView` (billingPolicyApi.ts:38-55).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Retry (after load error) | OfferRulesSection.tsx:162 | `load` (:71) | GET `B/billing-policy` (+ GET `B/operators` for gating) | `getOfferRules` (billingPolicyApi.ts:234); `listOperators` (refundPolicyApi.ts:142) | Current rules rendered as draft state |
| Save upgrade-offer rules | OfferRulesSection.tsx:250 | `save` (:122) | POST `B/billing-policy` | `setOfferRules` (billingPolicyApi.ts:249) | `{offerRules}` (enabled, triggers, cooldown days, show-proposed, downgrades, runs-packs, mentions); re-read after save |

Local only: 11 draft checkboxes + cooldown input (:173-249, `toggle` :145) — draft state only, no HTTP until Save.

### 2.19 BillingPolicySection.tsx — 2 HTTP actions

Helper: `billingPolicyApi.ts`. `setBillingPolicyFields` (:353) POSTs a partial of 10 fields.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Retry (after load error) | BillingPolicySection.tsx:255 | `load` (:112) | GET `B/billing-policy` (+ GET `B/operators` for gating) | `getBillingPolicyFields` (billingPolicyApi.ts:338); `listOperators` (refundPolicyApi.ts:142) | Current policy rendered as draft state |
| Save billing policy | BillingPolicySection.tsx:386 | `save` (:164) | POST `B/billing-policy` | `setBillingPolicyFields` (billingPolicyApi.ts:353) | All 10 fields (grace period, dunning retry, proration, downgrade timing, billing-period default/allowed, annual discount, repurchase migration, cfpay fixed price, Stripe price by bundle); re-read after save |

Local only: Add/Remove bundle-mapping rows (:377/:369), period checkboxes, selects — draft state only.

### 2.20 UsageBillingSection.tsx — 2 HTTP actions

Helper: `usageBillingApi.ts`. Read-only section: both actions re-read.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Retry (after load error) | UsageBillingSection.tsx:154 | `load` (:108) | GET `B/usage-billing` | `fetchUsageBilling` (usageBillingApi.ts:143) | Receipts, subscriptions, renewals, refunds, referral balances re-rendered |
| Refresh | UsageBillingSection.tsx:196 | `load` (:108) | GET `B/usage-billing` | `fetchUsageBilling` (usageBillingApi.ts:143) | As above |

Read-only display: receipts, subscriptions, renewals, refunds, referral balances; `FreeAccessLine` GETs `B/free-access` on mount (:81), display-only.

### 2.21 CheckoutPanel.tsx — 9 HTTP actions

Helper: `commercialApi.ts` (814 lines). Offer deep-link params (`?plan=&offer=&pack=`) preselect and attach audit-only `offerContext` to the next mint only.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Pay $X and run / Run for free | CheckoutPanel.tsx:897 | `handlePay` (:405) | Goal: POST `B/goal-command`, then POST `B/submit`; other families: POST `B/submit` only. Then 5s polling GET `B/submission-status` | `buildGoalCommand` (commercialApi.ts:336); `submitRun` (:330); `getSubmissionStatus` (:310, polling :366) | Run request id + status polled; `paymentUrl` rendered when payment required |
| I have paid — verify (pay tab) | CheckoutPanel.tsx:930 | `handleCheckPayment` (:464) | POST `B/submission/check-payment` | `checkPayment` (commercialApi.ts:331) | `{runRequestId}`; verified status + delivery note shown |
| Buy (per plan row) | CheckoutPanel.tsx:1044 | `handleBuyCheckout` (:588) | POST `B/subscription/checkout` | `subscriptionCheckout` (commercialApi.ts:343) | `{planId, email, offerContext?}`; mint response carries `checkoutUrl`/`checkoutSessionId` (card) or `checkoutId` + challenge (x402) |
| I have paid — activate subscription | CheckoutPanel.tsx:1081 | `handleBuyPurchase` (:627) | POST `B/subscription/purchase` | `subscriptionPurchase` (commercialApi.ts:357) | Mint reference; activation note; subscription reloaded |
| Create pack checkout | CheckoutPanel.tsx:1111 | `handlePackMint` (:522) | POST `B/runs-packs/checkout` | `packCheckout` (commercialApi.ts:530) | `{versionId, rail, email, offerContext?}`; checkout URL/ID shown |
| I have paid — verify (pack) | CheckoutPanel.tsx:1152 | `handlePackConfirm` (:553) | POST `B/runs-packs/confirm` | `packConfirm` (commercialApi.ts:541) | Mint reference; pack balance note |
| Yes, cancel subscriptions (modal confirm) | CheckoutPanel.tsx:1181 | `handleCancel` (:651) | POST `B/subscription/cancel` | `subscriptionCancel` (commercialApi.ts:365) | `{}`; cancellation note; subscriptions reloaded |
| Create top-up checkout | CheckoutPanel.tsx:1283 | `handleTopUpMint` (:701) | POST `B/top-up/checkout` | `topUpCheckout` (commercialApi.ts:481) | `{amountUSD, rail, email}`; checkout URL/ID shown |
| I have paid — verify (top-up) | CheckoutPanel.tsx:1328 | `handleTopUpConfirm` (:746) | POST `B/top-up/confirm` | `topUpConfirm` (commercialApi.ts:492) | Mint reference; credits note |

Local only: `Stop status polling` (:933); cancel-modal open/close (:1160); compare handlers (:498/:506/:516, state + tab switch); family/rail/email selects (draft). Read-only display: identity block; plan rows; pack rows; subscription rows. `UpgradeOffer` embedded in pay tab (:918); `AmbientOfferCompare` in subscriptions tab (:1003) — buttons counted in 2.22.

### 2.22 UpgradeOffer.tsx + PlanCompare.tsx — 1 HTTP action + 4 navigation actions

`PlanCompare.tsx` is not in the task file list; its buttons are counted once here (they also surface inside CheckoutPanel and SellingSection via `AmbientOfferCompare` — cross-referenced, not recounted).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Not now | UpgradeOffer.tsx:141 | `onDismiss` (:124) | POST `B/offer/dismiss` | `postOfferDismiss` (commercialApi.ts:770) | `{trigger, family}`; offer dismissed for the cooldown |
| Choose plan (per plan) | PlanCompare.tsx:152 | host callback → UpgradeOffer :96 | none — nav | — | Navigates to `?tab=checkout&checkoutTab=subscriptions&plan=<id>&offer=<trigger>` |
| Choose annual (per plan) | PlanCompare.tsx:158 | host callback → UpgradeOffer :106 | none — nav | — | As above with `billingPeriod=annual` |
| Buy pack (per pack) | PlanCompare.tsx:283 | host callback → UpgradeOffer :114 | none — nav | — | Navigates to checkout with `pack=<versionId>&offer=<trigger>` |
| Buy credits | PlanCompare.tsx:355 | host callback | none — nav | — | Navigates to `?tab=checkout&checkoutTab=topup` |

Mount/effect reads: POST `B/offer` (UpgradeOffer.tsx:75, `postOffer` commercialApi.ts:759) fetches the offer; GET `B/offer/compare` (PlanCompare.tsx:389, `getOfferCompare` commercialApi.ts:766) fetches comparison rows. CheckoutPanel/SellingSection host handlers for the PlanCompare buttons are local state/tab-switch only.

### 2.23 PaymentsPage.tsx — 5 HTTP actions (legacy `/api/payments/*` family, NOT the commercial catalog)

Direct `fetch` calls; no named helper. Wallet tab mounts `AgenticWalletPanel` (adjacent, not enumerated).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Refresh | PaymentsPage.tsx:189 | `fetchPaymentsData` (:80) | GET `/api/payments/transactions` + GET `/api/payments/gateways` | direct `fetch` (:84-85) | Transactions + gateways re-rendered |
| Create checkout link (form submit) | PaymentsPage.tsx:354 | `handleCreatePayment` (:115) | POST `/api/payments/create` | direct `fetch` (:126) | `{amount, currency, customer, gateway, description}`; draft + checkout link rendered |
| Authorize & Settle (per draft) | PaymentsPage.tsx:404 | `handleAuthorizeDraft` (:158) | POST `/api/payments/confirm` | direct `fetch` (:160) | `{draftId, decision: "authorize"}`; draft status updated |
| Reject (per draft) | PaymentsPage.tsx:411 | `handleAuthorizeDraft` (:158) | POST `/api/payments/confirm` | direct `fetch` (:160) | `{draftId, decision: "reject"}`; as above |
| Checkout Link (per draft, external) | PaymentsPage.tsx:423 | `href` | Server-provided checkout URL (external) | — | Opens the payment page; URL value not statically enumerable |

Local only: `Inspect DID Proof` (:435) opens a local modal (:453). Read-only display: gateway cards; stats; ledger rows.

### 2.24 BillingServicingPanel.tsx — 1 HTTP action + 1 navigation link

The view is read-only by design (scope note :240: never charges/purchases/cancels/deactivates). Direct `fetchJson` (:72); hosted sections counted in their own tables (2.17–2.20) or listed as adjacent below.

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Retry (after load error) | BillingServicingPanel.tsx:260 | `load` (:167) | GET `B/identity` + GET `B/subscription` + GET `/api/payments/receipts` + GET `B/plans` + GET `B/referral-codes/balance` | `fetchPlatformIdentity` (firstRunApi.ts:249); direct `fetchJson` (:176-179) | Overview cards re-rendered |
| Manage or cancel subscriptions (link) | BillingServicingPanel.tsx:284 | `href` | none — nav | — | Navigates to `?tab=checkout&checkoutTab=subscriptions` |

Read-only display: overview cards; support-snapshot card. Hosted but NOT in the task file list (not enumerated): `RefundPolicySection`, `RefundFlowSection`, `TopUpLimitsSection`, `PlanStripePriceSection`.

### 2.25 PaymentWorkflowAssurance.tsx — 18 HTTP actions + 2 local-only simulator actions

`PriceApprovalSection` (same file) sends an `x-user-login` header on price POSTs. Live calls go through `liveCall` (:934).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Refresh prices | PaymentWorkflowAssurance.tsx:779 | `loadPrices` (:488) | GET `B/pricing` + GET `B/prices` + POST `B/prices` `{}` operator probe | direct `apiFetch` (:499/:524/:561) | Current + proposed prices rendered. NOTE: the POST `{}` probe may seed proposed defaults on a fresh store — a read action with a possible write side effect |
| Save (Stock) | PaymentWorkflowAssurance.tsx:850 | `savePrice` (:718) → `postPrice` (:700) | POST `B/prices` | direct `apiFetch` (:705) | `{family: "stock", priceUSD}`; note shown; prices reloaded |
| Save (Goal) | PaymentWorkflowAssurance.tsx:850 | `savePrice` → `postPrice` | POST `B/prices` | direct `apiFetch` (:705) | `{family: "goal", priceUSD}`; as above |
| Save (Options) | PaymentWorkflowAssurance.tsx:850 | `savePrice` → `postPrice` | POST `B/prices` | direct `apiFetch` (:705) | `{family: "options", priceUSD}`; as above |
| Save (Strategy) | PaymentWorkflowAssurance.tsx:850 | `savePrice` → `postPrice` | POST `B/prices` | direct `apiFetch` (:705) | `{family: "strategy", priceUSD}`; as above |
| Save & approve (Stock) | PaymentWorkflowAssurance.tsx:859 | `saveAndApprove` (:724) | POST `B/prices` | direct `apiFetch` (:705) | `{family: "stock", priceUSD, approvalStatus: "approved"}`; as above |
| Save & approve (Goal) | PaymentWorkflowAssurance.tsx:859 | `saveAndApprove` (:724) | POST `B/prices` | direct `apiFetch` (:705) | `{family: "goal", priceUSD, approvalStatus: "approved"}`; as above |
| Save & approve (Options) | PaymentWorkflowAssurance.tsx:859 | `saveAndApprove` (:724) | POST `B/prices` | direct `apiFetch` (:705) | `{family: "options", priceUSD, approvalStatus: "approved"}`; as above |
| Save & approve (Strategy) | PaymentWorkflowAssurance.tsx:859 | `saveAndApprove` (:724) | POST `B/prices` | direct `apiFetch` (:705) | `{family: "strategy", priceUSD, approvalStatus: "approved"}`; as above |
| Approve (Stock) | PaymentWorkflowAssurance.tsx:868 | `approvePrice` (:580) | POST `B/prices` | direct `apiFetch` (:585) | `{family: "stock", approvalStatus: "approved"}`; as above |
| Approve (Goal) | PaymentWorkflowAssurance.tsx:868 | `approvePrice` (:580) | POST `B/prices` | direct `apiFetch` (:585) | `{family: "goal", approvalStatus: "approved"}`; as above |
| Approve (Options) | PaymentWorkflowAssurance.tsx:868 | `approvePrice` (:580) | POST `B/prices` | direct `apiFetch` (:585) | `{family: "options", approvalStatus: "approved"}`; as above |
| Approve (Strategy) | PaymentWorkflowAssurance.tsx:868 | `approvePrice` (:580) | POST `B/prices` | direct `apiFetch` (:585) | `{family: "strategy", approvalStatus: "approved"}`; as above |
| Run this scenario | PaymentWorkflowAssurance.tsx:1135 | `runOne` (:1021) | none — local | `runAssuranceScenario` (:118, in-browser fakes) | Simulated result rendered; NO HTTP |
| Run all 9 preset tests | PaymentWorkflowAssurance.tsx:1136 | `runSuite` (:1031) | none — local | `runAssuranceScenario` (:118) | As above; NO HTTP |
| Start live run | PaymentWorkflowAssurance.tsx:1206 | `startLive` (:946) | POST `/api/assurance/payment-workflow/start` | `liveCall` (:934) → direct `apiFetch` (:950) | `{mode, scheduleKind, authorizedAtSubmission}`; `workflowId` stored and polled |
| Refresh status | PaymentWorkflowAssurance.tsx:1207 | `refreshLive` (:965) | GET `/api/assurance/payment-workflow/status?workflowId=` | `liveCall` (:934) → direct `apiFetch` (:970) | Workflow status + steps rendered |
| Approve (live) | PaymentWorkflowAssurance.tsx:1208 | `sendLiveEvent` (:978) | POST `/api/assurance/payment-workflow/event` | `liveCall` (:934) → direct `apiFetch` (:983) | `{workflowId, type: "approval", approved: true}`; status refreshed |
| Reject (live) | PaymentWorkflowAssurance.tsx:1209 | `sendLiveEvent` (:978) | POST `/api/assurance/payment-workflow/event` | `liveCall` (:934) → direct `apiFetch` (:983) | `{workflowId, type: "approval", approved: false}`; as above |
| Check payment and deliver verified | PaymentWorkflowAssurance.tsx:1210 | `checkLivePayment` (:997) | POST `/api/assurance/payment-workflow/check-payment` | `liveCall` (:934) → direct `apiFetch` (:1002) | `{workflowId}`; verified/delivered status shown |

Read-only display: scenario list; live step timeline; price table. Operators tab mounts `StoreOperatorsPanel` (adjacent, not enumerated).

### 2.26 chat/tabs/ReferralsTab.tsx — 5 HTTP actions

Fully props-driven; every handler lives in `Chat.tsx` (file:lines below are `Chat.tsx` unless the control itself is cited). Inner tabs: `share` / `activity` / `links` / `community` (ReferralsTab.tsx:64-69). The activity tab is read-only stat cards (:281-322, no buttons).

| Action (label) | Component file:line | Handler | Route (method + path) | API helper file:line | Payload / response use |
|---|---|---|---|---|---|
| Refresh | ReferralsTab.tsx:95 | `fetchReferrals` prop → `loadReferrals` (Chat.tsx:629) | GET `/api/referrals` | direct `fetch` (Chat.tsx:632) | Referral list re-rendered |
| 🚀 Publish Referral Link (form submit) | ReferralsTab.tsx:391 | `handleCreateReferral` prop → Chat.tsx:695 | POST `/api/referrals` | direct `fetch` (Chat.tsx:705) | `{title, url, category, rewardText}`; new referral prepended; success note shown |
| Test Link ↗ (per link) | ReferralsTab.tsx:431 | `handleReferralClick` prop → Chat.tsx:671 | POST `/api/referrals/click` | direct `fetch` (Chat.tsx:673) | `{id}`; then `window.open(ref.url)` (Chat.tsx:684) |
| 🗑️ Delete (per link, two-step) | ReferralsTab.tsx:448 | `handleDeleteReferral` prop → Chat.tsx:687 (sets confirm target) → confirm `Delete` (Chat.tsx:1312) → `confirmDeleteTarget` (Chat.tsx:977) | DELETE `/api/referrals?id=<id>` | direct `fetch` (Chat.tsx:983) | Row removed from list on confirm; Cancel (Chat.tsx:1316) aborts |
| Ad click (inside GoogleAdUnit) | ReferralsTab.tsx:726 | `handleExternalAdClick` prop → Chat.tsx:868 | POST `/api/external-ads/click` | direct `fetch` (Chat.tsx:870) | `{id}`; then `window.open(ad.url)`; the click target is rendered by `GoogleAdUnit`, not this file |

Local/external only: `Copy Link` (:132, Chat.tsx:573, clipboard); `Discord Embed` copy (:269, Chat.tsx:579, clipboard); per-link Discord copy (:537, Chat.tsx:586, clipboard); 10 share-intent buttons (:141-267: X, LinkedIn, Reddit, Facebook, WhatsApp, Telegram, Threads, Bluesky, Hacker News, Pinterest — external share URLs, new tab, no first-party HTTP); 7 per-link share icon buttons (:460-537, same external networks); `📢 Share Link` toggle (:439, expands the per-link share row); 12 community external links (:569-701: GitHub, Discord, X, YouTube, Telegram, LinkedIn, Reddit, Bluesky, Threads, Instagram, TikTok, WhatsApp — plain `<a>` links).

## 3. Per-surface counts (HTTP actions)

| Surface | HTTP actions |
|---|---|
| PlatformAdminPage.tsx | 0 |
| PlatformAdminPanel.tsx (ads/provenance/access) | 1 |
| TenantAdminPanel.tsx | 7 |
| ChannelsAdminPanel.tsx | 6 |
| OmnichannelPanel.tsx (trading, count separately) | 8 |
| AccountAdminPanel.tsx | 4 |
| AccountPanels.tsx (broker, count separately) | 12 |
| AccountVersionMoveSection.tsx | 2 |
| SubscriptionGrantSection.tsx | 1 |
| UnlimitedFreeGrantSection.tsx | 2 |
| FreeAccessGrantSection.tsx | 2 |
| FreeRunAllowanceSection.tsx | 4 |
| ApprovedFreeQuotaSection.tsx | 8 |
| ProductsSection.tsx | 17 |
| ProductCatalogPanel.tsx | 8 |
| ProductHub.tsx | 0 |
| ReferralCodesSection.tsx | 7 |
| OfferRulesSection.tsx | 2 |
| BillingPolicySection.tsx | 2 |
| UsageBillingSection.tsx | 2 |
| CheckoutPanel.tsx | 9 |
| UpgradeOffer.tsx + PlanCompare.tsx | 1 (+ 4 navigation-only) |
| PaymentsPage.tsx | 5 |
| BillingServicingPanel.tsx | 1 (+ 1 navigation link) |
| PaymentWorkflowAssurance.tsx | 18 (+ 2 local-only simulator runs) |
| chat/tabs/ReferralsTab.tsx | 5 |
| **Grand total (all enumerated surfaces)** | **134** |
| **CBO commercial/platform total (excluding AccountPanels + Omnichannel)** | **114** |

## 4. API helpers — route index (all read on origin/main)

- `tenantAdminApi.ts`: `fetchTenants` :80 GET `/api/platform-tenants`; `createTenant` :88 POST same; `fetchTenantDetail` :98 GET `/api/platform-tenants/:id`; `updateTenantSettings` :112 PATCH `/api/platform-tenants/:id/settings`.
- `accountApi.ts` (BROKER, not platform accounts): alerts/transactions/watchlists/orders under `/api/etrade/*` (:88-166) + `cancelRemoteOrder` :166 POST `/api/broker/order/cancel`.
- `channelAdminApi.ts`: `fetchTenantChannels` :49 GET `/api/platform-channels/:id`; `updateTenantChannels` :59 PATCH `/api/platform-channels/:id/channels`; meta :19 (email, slack, webhook, copilot, docs).
- `copilotChannelsApi.ts`: NOT imported by any in-scope file (callers: `ETradeTradingHub.tsx`, `chat/AgentChatTabContent.tsx`, `voiceBackend.ts`). Projection read + voice STT/TTS under `/api/copilot-channels*` and `/api/voice/*`. No in-scope action uses it.
- `approvedFreeQuotaApi.ts`: `getApprovedFreeQuota` :160 GET `B/approved-free-quota[?userId=]`; `setApprovedFreeQuotaCap` :166 POST; `setApprovedFreeQuotaSettings` :195 POST; `isStoreOperator` :225 via `listOperators`.
- `billingPolicyApi.ts`: `getOfferRules` :234 / `setOfferRules` :249 / `getBillingPolicyFields` :338 / `setBillingPolicyFields` :353 / `setTopUpLimits` :167 / `setStripePriceByPlan` :223 — all on GET/POST `B/billing-policy`.
- `usageBillingApi.ts`: `fetchUsageBilling` :143 GET `B/usage-billing` only.
- `commercialApi.ts` (814 lines): `getPricing` :262, `getIdentity` :293, `listPlans` :294, `getSubscriptionStatus` :295, `getSubmissionStatus` :310, `submitRun` :330, `checkPayment` :331, `buildGoalCommand` :336, `subscriptionCheckout` :343, `subscriptionPurchase` :357, `subscriptionCancel` :365, bundle fns :395-418, `subscriptionTrial` :425, `topUpCheckout` :481, `topUpConfirm` :492, `packCheckout` :530, `packConfirm` :541, `postOffer` :759, `getOfferCompare` :766, `postOfferDismiss` :770.
- `firstRunApi.ts`: `fetchPlatformIdentity` :249 GET `B/identity` (base :60). `refundPolicyApi.ts`: `listOperators` :142 GET `B/operators`. `iaaaAdminApi.ts`: `fetchMemberships` :204 GET `/api/iaaa/memberships`.
- `src/data/commercialUrlCatalog.ts`: `COMMERCIAL_API_BASE` :30; `commercialPath` :159. Catalog ids used above: account, accountCredits, freeRunAllowance, plans, subscriptionCheckout/Purchase/Cancel/Trial/Grant, subscriptionBillingCheckout/BillingPurchase, billingPolicy, topUpCheckout/Confirm, runsPackCheckout/Confirm, referralCodeRules/Issue/Codes/Revoke/Redeem/Mine/MineRevoke/Balance, products, offer, offerCompare, offerDismiss, catalogueVersions, freeAccessGrant/Revoke, freeAccess, usageBilling, approvedFreeQuota, pricing, prices, operators, referralBalance, subscription, bundles, bundleCheckout/bundlePurchase, channelCheckout/Purchase.
- Literal suffixes NOT in the catalog (recorded verbatim from component code): `B/products/:id/rank`, `B/products/:id/versions/:vid/approve`, `B/products/:id/versions/:vid/deactivate`, `B/products/:id/bulk-move`, `B/products/:id/bulk-moves/:id`, `B/subscriptions/:id/move`, `B/accounts/:userId/segment`.

## 5. Unclear / undetermined — with what would settle each

1. **ProductCatalogPanel purchase-path link** (:1133): href comes from server row data (`row.purchasePath.route`). Not statically enumerable. Settled by a live GET `/api/products/catalog` response.
2. **PaymentsPage checkout link** (:423): href is the server-provided checkout URL on the draft. Not statically enumerable. Settled by a live GET `/api/payments/transactions` response.
3. **PriceApprovalSection POST `B/prices` `{}` probe** (:561): whether the empty probe writes (seeds defaults) or only probes operator status depends on server behavior. Settled by the server handler for POST `B/prices` (worker route code, out of scope here).
4. **OmnichannelPanel / ReferralsTab / AdminAccessSection handlers** live in parent files (`ETradeTradingHub.tsx`, `Chat.tsx`, `SecurityHubHome.tsx`) — resolved in this document by reading those parents; the component files themselves contain no routes.
5. **No action's route was left wholly undetermined.** Every HTTP action above has a method + path grounded in code read on origin/main.

## 6. Adjacent surfaces mounted by in-scope shells but NOT in the task file list (not enumerated)

- `PriceCatalogueSection.tsx` (ProductHub `admin-products` tab).
- `RefundPolicySection.tsx`, `RefundFlowSection.tsx`, `TopUpLimitsSection.tsx`, `PlanStripePriceSection.tsx` (BillingServicingPanel tabs).
- `AgenticWalletPanel.tsx` (PaymentsPage `wallet` tab).
- `StoreOperatorsPanel.tsx` (PaymentWorkflowAssurance `operators` tab).
- `ApiKeysPanel.tsx`, `EngineTuningPanel.tsx` (Platform Admin views).
- `PlanCompare.tsx` — enumerated once under UpgradeOffer (§2.22); its buttons also surface in CheckoutPanel/SellingSection via `AmbientOfferCompare`.

## 7. Out of scope (one line each, per task)

- `LedgerPanel.tsx` — trade ledger display; trading surface.
- `ScheduleRunLedgerPanel.tsx` — scheduled-run ledger; trading/research surface.
- `runLedgerOptionsRuns.ts` / `runLedgerReportRuns.ts` — run-ledger data helpers; research-job surface.
- `AccountBindingSelector.tsx` — broker account bindings; broker surface, not platform accounts.
- `IaaaAdminPanel.tsx` — IAAA memberships/grants; identity/CISO-owned.
- `RoleGrantsPanel.tsx` — role grants; identity/CISO-owned.
- `UserAdminPanel.tsx` — user administration; identity/CISO-owned.
- `AdminQueueWipePanel.tsx` — queue wipe; operations surface.
- Anything trading/order-ticket or research-job related — excluded by task scope (OmnichannelPanel/AccountPanels enumerated only because the file list named them, subtotaled separately in §3).
