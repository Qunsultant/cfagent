# 0028. Data-provider/broker taxonomy split, alpaca/alpaca defaults, Public.com as a live broker

- Status: Accepted
- Date: 2026-11-10
- Deciders: owner (user decision 2026-11-10, #3990 comment 6768969850), #clo-arsi
- Issue: #3990 (sub-issue of #2764)
- Implementing PR: this PR (main commit recorded on merge)

## Context

`DATA_PROVIDER_IDS` (etrade, public, yahoo, nasdaq, alpaca) mixes brokers
with pure data providers in one five-way list, and the stored default pair
was etrade data + alpaca broker — two firms' data and money paths for a
default tenant. Three facts forced the split:

- The options gate checks the tenant's *data* provider for
  `optionsChains`. E*TRADE and Public declared it; Alpaca's data adapter
  did not, although the repo already implemented Alpaca options reads
  (`src/trading/alpaca/optionsData.ts`, used by the Alpaca trading
  platform) — the gap was only the adapter registration. A default tenant
  on etrade data worked; a default tenant on alpaca data would have been
  refused chains.
- The user corrected the taxonomy: etrade, public and alpaca are brokers
  (quote data + trading); yahoo and nasdaq are pure data providers
  (Yahoo: delayed quotes, technicals, fundamentals, sentiment; Nasdaq:
  symbols/listings). And asserted — verified against Alpaca's real API —
  that Alpaca provides what E*TRADE and Public provide, so Alpaca/Yahoo
  can be used for enrichment in addition to trading.
- Public.com had a data adapter (hosted MCP) but no broker (trading)
  adapter, no catalog entry, and no copilot tools. Its OAuth scopes
  lacked `trading.write`, and no route stored a Public token through the
  app. Public.com has **no paper trading mode** (verified twice in the
  official docs: placing a trade through any MCP client is a real order
  using real money).

Constraints carried into the decision:

- ADR 0019 (enrichment Yahoo/Alpaca, 2026-10-27): "Alpaca fundamentals
  are Yahoo-covered, never faked. Alpaca exposes no live fundamentals."
  Followed, not re-decided — the Alpaca adapter's `fundamentals`
  declaration was the false one (its `getFundamentals` throws), and is
  dropped.
- #2144 owner ruling: quotes never gap-fill. The registry's routing
  rules (routed primary unservable fails explicit; gap-fill never
  silently promoted) are unchanged.
- #3937: broker neutrality is global. This slice extends it to the
  data-provider axis and to Public.com; it does not re-open #3937.
- The mode default stays paper (TEST); live is an explicit act, and no
  live orders are placed as part of this work.

## Decision

1. **Declared == servable.** A provider's declared capabilities are
   exactly what it serves. The conformance kit's rule is the law: a
   provider that declares a capability it does not implement fails that
   capability's check. The Alpaca adapter drops `fundamentals` and gains
   `optionsChains`.
2. **Options/fundamentals sources mirror the `news` injection pattern.**
   Capabilities are computed from injected sources; methods exist exactly
   when declared. The Alpaca chain assembly is shared, not duplicated:
   the contracts+snapshots → `BrokerOptionChain` assembly was extracted
   from `AlpacaTradingPlatform.getOptionChains` into `optionsData.ts`;
   the platform delegates (behavior-preserving) and the data adapter
   reuses it.
3. **The gate map stays a pure function but is pinned.** A test
   constructs all five adapters with defaults and asserts the map equals
   the adapters' declared capabilities, so the map cannot go stale again.
4. **Defaults: alpaca/alpaca.** The Alpaca data adapter now declares and
   serves `optionsChains` via the repo's own Alpaca options read path,
   which is what the options gate requires; no tenant silently mixes two
   firms' data and money paths; fundamentals for an Alpaca-default tenant
   come from Yahoo by design (ADR 0019); paper is the mode default
   (TEST), not stored here. The capability routes are unchanged — the
   optionsChains route primary stays etrade, because the unified options
   service registers only the E*TRADE adapter in its local registry, so
   moving the primary to alpaca would make it fail explicitly.
5. **Taxonomy split.** `DATA_PROVIDER_KINDS` in `contract.ts` (etrade /
   public / alpaca "broker"; yahoo / nasdaq "pure") + derived lists;
   `DATA_PROVIDER_IDS` unchanged; the client options are derived with
   kind annotations. A broker MAY also be a data source, registered with
   its declared capabilities — the split is a kind annotation, not a
   second registry. Settings lists brokers under Broker and data sources
   under Data provider.
6. **Public trading client is a second allow-list over the same MCP
   transport.** The data client's read-only guarantee is intact. The
   trading client probes `tools/list` at first use and fails loudly on
   an absent tool. `place_*` calls are never retried after a transport
   failure (the MCP surface exposes no idempotency key — a retry could
   double a real order); placement is verified via `get_order` /
   `search_orders` before any retry.
7. **Public TEST maps to the paper bucket; placement in TEST is refused
   by a named outcome.** `tradingTypeForEnvironment: { TEST: "paper",
   PROD: "live" }` keeps the `TradingType` total (widening it would
   touch six mode call sites). TEST → paper is the platform mode bucket
   only; placement in TEST is refused with the new outcome
   `FAILURE_PUBLIC_NO_PAPER_MODE` at the platform seam, before any MCP
   call, and the draft stays previewed. No existing outcome code fit
   (the broker IS available; placement is refused by mode).
8. **Public credential kind: `personal_token`.** A single pasted secret;
   the OAuth metadata-document flow is refused by Public's authorization
   server in practice, and the verified working path is a pasted personal
   access token. NOT a reuse of `api_key_pair` (that would mislabel it).
   The token-store route (`POST /api/public/connect`, verifying via
   `tools/list` before storing) already existed; Slice C added only the
   neutral connect read + Settings surface.
9. **Public copilot tools** (`public_get_quote`, `public_preview_order`,
   `public_place_order`, `public_orders`, `public_cancel_order`) route
   through the neutral platform with the tenant's stored broker
   environment (resolved exactly like the neutral routes; unset →
   TEST). Placement is preview-first: `public_place_order` settles a
   stored draft by orderId; a call without one is refused and names
   `public_preview_order`. There is no cancel-all on Public (one
   `cancel_order` per order), so the panel's cancel-all control stays
   Alpaca-gated.
10. **Neutral routes are already generic.** `resolveTenantBroker` +
    `TradingPlatformRegistry.getPlatform` serve Public with no new route
    shape; draft binding (broker from the stored draft, 409 on
    disagreement) applies unchanged.
11. **Screening on Public.** The screener gains a `public` mode
    (`UniverseMode` / `StockScreenProvider`): a Public block mirroring
    the Alpaca block (bootstrap, verify → enable, construct, resolve,
    bind), the live-quotes branch generalized over the bound quoteDeps
    with Public.com provenance, and `screenMarkets` on the platform
    (`NeutralMarketScreener` over its own quotes). The goal-screen path
    stays Yahoo-only (it has no Alpaca branch either) — a known gap, not
    built here.
12. **Yahoo options are NOT wired.** Yahoo's unofficial
    `query2.finance.yahoo.com/v7/finance/options/{symbol}` endpoint
    returns full chains, but it needs a cookie+crumb handshake and is an
    unofficial endpoint with ToS/compliance risk for commercial use. Not
    wired unless explicitly decided later.
13. **No ADR re-decides the #2594/#3812 default pair history.** This ADR
    records the #3990 change and its reason; the earlier defaults were
    never recorded in an ADR (grep found none).

## Consequences

- Default tenants get Alpaca data + Alpaca broker; the options gate
  passes for them. Tenants that stored etrade data keep it (the change
  is to the default, not to stored selections).
- The MCP server grows 118 → 132 tools (the five Public tools, plus
  nine tools that landed on main since the inventory was written:
  `alpaca_get_quote`, `alpaca_preview_order`, `alpaca_execute_order`,
  `alpaca_cancel_order`, `alpaca_cancel_ticker`, `alpaca_cancel_all`,
  `trading_limits`, `get_payment_budget`,
  `stock_copilot_remediate_gaps`). The inventory doc is reconciled to
  132 in this PR.
- Public tenants in TEST can quote, preview, and screen, but cannot
  place — the refusal names the code, not a vague unavailability. PROD
  placement is a real order with real money; the platform reports an
  acceptance receipt, never a fill.
- The neutrality census baseline grows by 17 rows / 133 lines (16 code
  rows + the inventory doc's first `public.com` row + the scope-table
  raise), all dispositioned INTEGRATION. The PLATFORM slice is
  untouched.
- The acceptance for #3990 — a user can place stock AND options orders
  and do screening on Public.com with Stock Copilot — is verified
  through the preview/draft path and tests with fakes/mocks, never a
  live order.
