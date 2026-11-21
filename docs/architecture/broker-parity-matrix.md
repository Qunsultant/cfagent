# Broker parity matrix

Issue #4038 / #4039. One row per capability, one column per broker. Every cell
is exactly one of:

- **parity** — the capability exists on the platform and has a conformance test;
- **impossible (reason)** — the broker cannot provide it; the reason is evidence
  (a missing tool, a documented absence, a mode the broker does not have);
- **live-only (reason)** — it exists but only in live mode;
- **—** — not a platform capability (data-plane rows served by data providers).

The pin `tests/broker_parity_matrix_4038.test.ts` reads this table and checks it
against the platform prototypes: a `parity` cell must be a real method, and an
`impossible` cell must be absent (a stub that returns empty data is a lie, not a
gap). Change the code, change this table in the same PR.

| Capability | E*TRADE | Alpaca | Public.com | Tastytrade |
|---|---|---|---|---|
| Quotes | parity | parity | parity | parity |
| Options chains + expiries | parity | parity | parity | impossible (Tastytrade Slice 1 has no option chain adapter wired yet) |
| Accounts | parity | parity | parity | parity |
| Positions | parity | parity | parity | parity |
| Position lots | parity | parity | parity (get_tax_lots_for_symbol; verified on the live surface, #4673) | impossible (Tastytrade Slice 1 exposes no lot-level position read) |
| Order preview | parity | parity | parity | parity |
| Order placement | parity | parity | live-only (Public has no paper mode; TEST refuses with FAILURE_PUBLIC_NO_PAPER_MODE) | parity |
| Order cancel | parity | parity | parity | parity |
| Order history / activity | parity | parity | parity | parity |
| Watchlists | parity | parity | impossible (no watchlist tools on the hosted MCP surface) | impossible (Tastytrade Slice 1 exposes no watchlists adapter) |
| Session orders (pre/post/EXTO) | impossible (no session terms on the wire) | parity | impossible (no session terms on the hosted MCP surface) | impossible (Tastytrade Slice 1 has no session-order terms wired) |
| Historical bars | — | — | — | — |
| Fundamentals | — | — | — | — |

## Data-plane rows

Historical bars and fundamentals are served by the registered data providers,
not by the broker platforms: etrade declares quotes + optionsChains, public
declares quotes + optionsChains + historicalBars (get_price_history, #4673),
yahoo declares quotes + historicalBars + fundamentals, nasdaq screenUniverse,
alpaca quotes + historicalBars + fundamentals. A tenant whose selected provider
cannot serve a capability is served by a capable provider with the substitution
recorded (`requestedDataProviderId`, #4014).

## Runtime-configurable Broker, Asset-Type & Account-Type Registry (#5094 / #5097)

Extending the `#3855` registry-driven broker list, `src/config/brokerRegistry.ts`
and `src/services/accountBindings.ts` expose a runtime-configurable registry
persisted in `SessionStore` (`account_bindings` namespace) holding per-broker
supported modes, asset types, account types per asset type, and capabilities.
Operators and tenants can add, enable, disable, or edit brokers, asset types,
and account types directly through `/api/broker/account-binding` (`registryPatch`),
the `broker_account_binding` MCP tool (`registry_get` / `registry_update`), and
the `AccountBindingSelector` UX without code changes or redeploys.

## Tuple Model, Validation Seam & Migration (#5094 F1 / #5098)

Tenant state and per-surface scopes (`tenant`, `autopilot`, `copilot`, `schedule`, `ux`, `audit`) carry the unambiguous 4-element binding tuple `{ broker, mode, accountType, accountId }` (`AccountBindingTuple` in `src/trading/accountBindings.ts`).

- **Validation Seam (`validateAccountAgainstBroker`)**:
  Validates candidate tuples against the broker's actual registered/connected accounts:
  - Unknown account -> coded error `FAILURE_ACCOUNT_UNKNOWN` (HTTP 404).
  - Unowned or closed account -> coded error `FAILURE_ACCOUNT_UNOWNED` (HTTP 403).
  - Wrong asset class or incompatible account type -> coded error `FAILURE_ACCOUNT_ASSET_TYPE_MISMATCH` (HTTP 400).
  - Cross-broker substitution attempt -> coded error `FAILURE_ACCOUNT_BROKER_MISMATCH` (HTTP 409).
  - Never silently falls back across brokers, modes, or accounts.

- **Migration Seam (`migrateLegacyBrokerSelectionToTuple` / `migrateTenantAccountBinding`)**:
  Migrates legacy broker/mode-only selections into full tuples:
  - If 0 accounts exist: fails loud with `FAILURE_ACCOUNT_UNKNOWN`.
  - If exactly 1 candidate account exists (or exactly 1 marked default): migrates cleanly to the tuple.
  - If multiple candidate accounts exist with no single default: fails loud with `FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS` (HTTP 409) returning `candidateAccountIds` so the tenant is asked instead of guessed.

