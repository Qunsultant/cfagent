# Step 0 survey — #3990 data-provider/broker taxonomy + Public.com live broker

Surveyed on fresh main `7ae832f5` (2026-11-10T13:00:05Z), verify tree `~/workspace/verify-3990/cfagent-main`.
Posted as a comment on #3990 before implementing (brief step 0).

## (a) Capability matrix — what the repo wires vs what the provider's API actually offers

### Repo wiring today (verified in code)

| Provider | Adapter declares (`adapters.ts`) | Notes |
|---|---|---|
| etrade | quotes + optionsChains | |
| public | quotes + optionsChains | via hosted MCP `https://mcp.public.com/mcp` |
| alpaca | quotes + historicalBars + fundamentals | shared `createMarketDataProvider` wrapper; **no optionsChains** |
| yahoo | quotes + historicalBars + fundamentals + news | news via `fetchYahooNewsArticles` (#3932) |
| nasdaq | screenUniverse only | symbols/listings only |

The same matrix is recorded a **second time** as a static map in
`src/services/optionsProviderContext.ts` (`DATA_PROVIDER_CAPABILITIES`),
which the options gate reads — and that copy is already stale: its header
comment says "News is contract-only and declared by no adapter, so it is
unavailable for every provider" (pre-#3932; Yahoo now declares news) and
"Yahoo cannot fix options chains" (see below). One source of truth is a
required part of this fix: the gate must read the adapter declarations,
not a parallel hand-maintained map.

### Alpaca options — the user's assertion is correct

Alpaca's real API **does** provide options market data, and the repo
**already implements it** — just not in the data adapter:

- Market Data API `GET /v1beta1/options/snapshots/{underlying}` — chain
  with NBBO bid/ask, latest trade, day bar, greeks (δ/γ/θ/ν/ρ), provider
  IV; feed `indicative` needs no OPRA subscription.
- Trading API `GET /v2/options/contracts` — contract reference + open interest.
- Repo: `src/trading/alpaca/optionsData.ts` —
  `fetchAlpacaOptionContracts` + `fetchAlpacaOptionSnapshots`, consumed by
  the Alpaca *trading platform's* `getOptionChains` /
  `getOptionExpireDates` (`src/trading/alpaca/platform.ts:534-650`).

**The gap is only the data-adapter registration**: the shared
`createMarketDataProvider` wrapper exposes no `getOptionsChain` /
`getOptionExpiryDates`, so the Alpaca data adapter cannot declare
`optionsChains`. Wiring it means delegating those two methods to the
same `optionsData.ts` functions (the data-adapter construction sites —
`src/agents/routes/dataProviders.ts:274` and
`src/agents/screener-agent.ts:1295` — have `env` and can build the
options config the same way the trading platform does).

### Yahoo options — exists, but unofficial

Yahoo's real API **does** expose full option chains:
`GET https://query2.finance.yahoo.com/v7/finance/options/{symbol}`
(calls/puts, volume, OI, greeks, IV, expirations). Caveats, verified
against Yahoo's published surface:

- It is an **unofficial** endpoint (Yahoo shut its official API in
  2017) requiring a cookie+crumb handshake, with ToS/compliance risk
  for commercial use.
- The repo already uses Yahoo unofficial endpoints (chart/search), so
  wiring Yahoo options would be consistent with existing posture — but
  it must be an **explicit decision**, not assumed. The
  optionsProviderContext comment "Yahoo cannot fix options chains" is
  wrong as stated and must be corrected to "Yahoo chains are available
  only via an unofficial endpoint; not wired unless explicitly decided".

Yahoo enrichment is already real: quotes + historicalBars + fundamentals
+ news are declared and wired, and the screener composes the Yahoo
adapter (`screener-agent.ts:1255`). Alpaca enrichment is likewise
already wired (quotes + bars + fundamentals). The "Alpaca/Yahoo for
enrichment" part of the decision is therefore mostly a matter of
declaring it and routing gap-fill through it — not new fetch code.

### Gap-fill routing today

The registry (`src/trading/dataProviders/`) resolves a per-capability
primary + declared gap-fill from the config store; **quotes never
gap-fill** (#2144 owner ruling); a routed primary that is not servable
fails explicitly (`DataProviderNotFoundError`); an unservable gap-fill
is omitted, never promoted. The options gate
(`src/agents/routes/optionsProviderGate.ts:54`) checks the tenant's
data provider **directly** and never substitutes another provider's
feed — a tenant whose selected provider lacks `optionsChains` gets the
coded `FAILURE_DATA_PROVIDER_UNAVAILABLE` refusal. That strictness is
correct and stays; the fix makes the *default* pair satisfy the gate
instead of relying on substitution.

### Default pair — consequence resolved

`DEFAULT_TENANT_PROVIDERS = { dataProviderId: "etrade", brokerId: "alpaca" }`
(`src/data/commercialPorts.ts:168-171`). History: #2594 introduced the
two selections; #3451's owner rule moved only the *broker* default to
Alpaca in paper mode, saying nothing about the feed; #3812 kept the
data default at etrade "preserving the pre-existing behaviour for
every data read".

Coherent candidate: **data default → alpaca, broker default stays
alpaca**. With the Alpaca `optionsChains` registration landed, chains
work for default tenants (the gate is satisfied by the default's own
declaration, no substitution), the pair is one provider on both axes,
and Yahoo remains the declared gap-fill for fundamentals/news (which
Alpaca lacks — Alpaca declares no news fetcher). The reason will be
recorded in the code comment on the default. If the data default
stayed etrade, chains would also work — but the pair would stay split
across two firms for no reason, and the taxonomy split below would
still be needed. Decision recorded here; implementation follows it.

## (b) Public.com today — and what the live-broker path needs

### What Public has today (data only)

- **Data adapter**: quotes + optionsChains via the hosted MCP
  (`src/trading/dataProviders/adapters.ts:1192`,
  `src/mcps/public/publicMcp.ts`, read helpers in
  `src/services/publicData.ts`: `readPublicQuotes`,
  `readPublicOptionExpirations`, `readPublicOptionChain`,
  `extractAccountId`).
- **Credential**: the signed-in user's Public token set
  (`src/security/publicOAuth.ts`). OAuth scopes in the repo:
  `"openid offline_access marketdata trading.read"` — **no
  `trading.write`**. The OAuth metadata-document flow is refused by
  Public's authorization server in practice; the verified working
  credential path is a pasted personal access token (kind "personal").
- **Hard refusal by construction**: `PUBLIC_DATA_TOOL_ALLOWLIST`
  (`publicMcp.ts:38-43`) is exactly `get_accounts`, `get_quotes`,
  `get_option_expirations`, `get_option_chain`. The module comment
  states order-placing tools "are not merely unused, they are refused:
  the data-provider platform never exposes them at all."
- **No broker (trading) adapter**: `BROKER_IDS`
  (`src/services/tenantProviders.ts`) is `["etrade", "alpaca"]` —
  "the only brokers with a route implementation in this build".
  `TradingPlatformRegistry` (`src/trading/index.ts`) registers
  etrade, alpaca, sandbox only. No `public_*` copilot tools exist.

### What Public's hosted MCP actually offers (verified against Public's published MCP docs)

Public's hosted MCP server exposes trading tools: `place_order`
(single-leg stocks/crypto/options, brackets via `order_class`),
`place_multileg_order`, spread helpers, `place_short_order`,
`cancel_order`, `cancel_and_replace_order`, `get_portfolio`,
`get_orders`, `get_order`, plus the data tools and preflight tools
(~40 tools, ~30 read-only, ~10 write). Advertised OAuth scopes:
`trading.read`, `trading.write`, `marketdata`, `openid`. **Not yet
verified live from this repo** — only the four data tools + token
handling are grounded in-repo; the trading adapter must probe
`tools/list` and fail loudly with a named error if a tool is absent,
and must be tested with fakes/mocks only.

### CRITICAL: Public has no paper trading mode

Public's own docs: placing a trade through any MCP client is a **real
order using real money**. Nothing defaults to a sandbox. Consequence
for the design (honest reading of the guardrail "mode default stays
paper (TEST); live remains an explicit act"):

- A Public tenant in TEST/paper mode gets **reads + preview only**;
  placement is refused by a **named outcome** (not a silent no-op).
- Live requires explicit PROD selection + the existing approval path.
- No live order is placed as part of this work; verification is
  through the preview/draft path and tests with fakes/mocks.

### What building the live-broker path needs

1. **Trading adapter** implementing `ITradingPlatform` (required:
   `getStatus`, `getQuote`, `getAccounts`, `getPositions`,
   `previewOrder`, `executeOrder`; optional: `screenMarkets`,
   `placeOrderRemote`, `cancelOrderRemote`, `getOptionChains`,
   `getOptionExpireDates`, `getOrderHistory`, `getAccountActivity`,
   `getWatchlists`, `getAlerts`) over the hosted MCP with a **separate
   trading allow-list** — the data client's allow-list must stay
   data-only; a second client (or a scoped extension) carries the
   write tools.
2. **OAuth scope `trading.write`** + re-consent path (or the
   personal-token path documented as the supported credential until
   the OAuth flow is verified working).
3. **`BROKER_CATALOG` entry** with a copilot capability block
   (`supported`, `autonomousCycle`, `bracketOrders`,
   `percentBrackets`, `barsProvider`, tool names). This
   auto-populates Settings — the broker list is catalog-derived
   (`src/client/brokerOptions.ts`, #3855), so **no settings-UI edit
   is needed** for the broker side.
4. **Registry registration** in `src/trading/index.ts` +
   `BROKER_IDS` in `src/services/tenantProviders.ts`.
5. **`brokerPresentation` entry** (label + icon).
6. **Copilot MCP tools** (`public_preview_order`,
   `public_execute_order`, `public_place_order` following the
   `AlpacaPlaceOrderCommand` / `EtradeExecuteOrderCommand` pattern
   in `src/mcps/openaimp/commands.ts`) + catalog copilot tools so
   `brokerCopilotCapability` / `isCopilotBroker` resolve Public;
   the Stock Copilot door must route stock orders, options orders
   and screening through the Public adapter when Public is the
   selected broker/data provider. **Acceptance (user, 2026-11-10):
   a user can place stock AND options orders and do screening on
   Public.com with Stock Copilot** — verified via preview/draft +
   tests, never a live order.
7. **Neutral routes + panel**: the neutral trading routes and the
   panel branch (`PortfolioPanel` renders `AccountPanels` only for
   etrade, else `AlpacaBrokerPanel` with the broker prop) must route
   Public through the one resolver; a Public-specific panel is built
   only if the generic broker panel cannot carry it.
8. **Draft ledger / order preview path** must accept `public` as a
   broker id (currently etrade/alpaca-bound in places — audit in
   implementation).
9. **Screening on Public**: the screener composes nasdaq + etrade +
   yahoo + alpaca adapters (`src/agents/screener-agent.ts:1164-1295`)
   — **no public adapter**. The public adapter must be added to the
   screener composition (or the gap-fill routing must cover it) for
   "screening on Public.com with Stock Copilot" to work; the screen's
   quote seam binds per-provider deps
   (`bindEtradeQuoteDeps` / `bindYahooScreenerDeps` /
   `bindLiveQuotesQuoteDeps` / `bindNasdaqUniverseDeps` in
   `src/trading/screenerPipeline.ts`), so a Public binding is the
   concrete piece.

## (c) Where the taxonomy is conflated

1. **`src/trading/dataProviders/contract.ts:73-79`** — `DATA_PROVIDER_IDS`
   is one five-way list mixing brokers (etrade, public, alpaca) with
   pure data providers (yahoo: delayed quotes/technicals/fundamentals/
   sentiment; nasdaq: symbols/listings). It is the vocabulary for the
   data-provider selection *and* for capability lookup.
2. **`src/data/commercialPorts.ts:168`** — default pair etrade data +
   alpaca broker, with the history in (a) above.
3. **`src/client/tenantProviders.ts:82-88`** — `DATA_PROVIDER_OPTIONS`
   is a **hardcoded** five-way client list. Asymmetric with the broker
   side, which is catalog-derived (#3855). The split: a data-source
   list derived from the adapter registry (with declared capabilities)
   and a broker list derived from the catalog — a broker MAY also be
   a data source, registered with its declared capabilities.
4. **`src/client/BrokerDynamicMenu.tsx`** — both selectors live here:
   broker at :741 (catalog-derived via `brokerOptions()`), data
   provider from the hardcoded `DATA_PROVIDER_OPTIONS`. Settings
   shows them side by side with no kind distinction.
5. **`src/services/tenantProviders.ts`** — `BROKER_IDS = ["etrade",
   "alpaca"]`; Public absent from the broker vocabulary entirely.
6. **`src/services/optionsProviderContext.ts`** — static
   `DATA_PROVIDER_CAPABILITIES` duplicates `adapters.ts` (stale, see
   (a)); the gate reads the copy, not the adapters.
7. **`src/trading/index.ts`** — `TradingPlatformRegistry` registers
   etrade, alpaca, sandbox only.
8. **`src/agents/screener-agent.ts:1164-1295`** — screener composes
   four adapters; no public.
9. **`src/agents/routes/dataProviders.ts:268-275`** — registers all
   five adapters (this site is complete; the gap is downstream
   composition, not registration).
10. **Stale comment** `src/agents/copilotTradingMode.ts:17` still says
    the shared store default is etrade (predates #3937; needs a fix).
11. **`src/agents/routes/optionsProviderGate.ts:54`** — the gate
    checks the tenant's data provider directly; no gap-fill
    substitution (correct; stays strict — see (a)).

## Implementation shape (for the record; code follows)

- Single source of truth for capabilities = the adapter declarations;
  the options-gate map becomes a derived projection (or is removed),
  with the stale Yahoo/news statements corrected.
- Taxonomy split: broker list (catalog) vs data-source list
  (adapter registry, capability-annotated); Settings lists brokers
  under Broker and data sources under Data provider.
- Defaults: data → alpaca (reason recorded on the default comment),
  broker stays alpaca; pair coherent and documented; options gate
  satisfied by the default's own declaration.
- Public: trading adapter + catalog + registry + presentation +
  copilot tools + neutral routes/panel + draft-ledger acceptance +
  screener composition; TEST mode = reads + preview only, placement
  refused by a named outcome; no live orders.
- Broker-neutrality audit of every page/capability that picks a
  broker or a feed, same survey discipline as #3937; the neutrality
  census baseline (`tests/neutrality_census_3525.test.ts`,
  SHRINK-ONLY) will need deliberate, reviewed baseline updates for
  the new Public broker files.
- One PR to main; rebase/verify/green/queue; §15 report + close #3990.
