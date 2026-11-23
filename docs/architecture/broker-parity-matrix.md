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

## Execution Enforcement (F3 / #5100)

F1 made the tuple unambiguous; F3 makes it enforced. Every schedule, autopilot run, and copilot run resolves, stores, and honors the full tuple; execution against any other account is refused, and run records carry the tuple as provenance.

- **Validated resolution (`resolveValidatedExecutionAccountContext`, `src/services/accountBindings.ts`)**: one wrapper over F1's `resolveExecutionAccountContext`. A body-supplied `accountId` is an untrusted hint validated against the broker's enumerated accounts (via `validateAccountAgainstBroker`), never accepted verbatim; an explicit hint with no enumeration available fails closed. An unbound tenant resolves to `FAILURE_ACCOUNT_BINDING_MISSING` — never to an "unset" context, and no caller is left to refuse on its own. Failure codes map through the outcome catalog (unknown 404 / unowned 403 / asset-type mismatch 400 / cross-broker 409 / missing 404).
- **Order preview / execute (`src/agents/routes/brokerOrders.ts`)**: preview validates an explicit account id against the platform's enumerated accounts and stamps the resolved tuple (`accountId` / `accountType` / `bindingScope` / `bindingSource`) on the draft (`mas_trades`). Execute re-resolves and compares against the draft; a mismatch refuses 409, a legacy draft with no stamp is refused with "re-preview required" (it no longer silently defaults to the legacy broker).
- **Schedules (`src/agents/routes/schedules.ts`, NLQ arm, baseline arm)**: creation resolves the tuple (asset class defaults to the callback's class — options analysis resolves the options account) and stamps it on the payload identity; a caller-supplied `accountId`/`accountType` is stripped before the payload is built, and an update re-stamps the existing tuple rather than re-targeting the account. Fire time re-validates the stamped tuple against the broker's current accounts (`enforceScheduleBinding` in `src/agents/orchestrator.ts`); a stamped account that no longer resolves, or a pre-F3 unstamped payload, is refused before the service call. A broker enumeration failure at fire time throws (the run records a failure and the SDK retry applies) — an unverifiable run is never recorded as a refusal. Pipeline-job schedules (`runPipelineJobSchedule`) are broker-free and carry no stamp.
- **Autopilot (`src/agents/routes/autopilot.ts`)**: evaluate resolves the tuple first and records it on the verdict (`broker` / `accountType` / `accountId` / `bindingScope` / `bindingSource` in `mas_policy_verdicts`); the monthly evaluation records a refused evaluation as skipped, not failed. The balance snapshot stays single-broker (#4571 owns any routing change); the tuple is threaded to its call site and recorded on the verdict only.
- **Copilots**: order tools refuse via the broker-orders guards; a turn still answers read-only questions but names "No account bound" and never issues an order tool call. The stock copilot prompt carries the bound account masked (or "No account bound" when unbound); the door + route status payloads carry the masked active binding.
- **Refusal semantics**: refusals are loud, coded, and recorded — skipped runs with the failure code as the detail reason, never failed runs, never silent. Run records (`JobRunRecord`, cron dispatch records, callback ledger rows) carry the tuple fields when present and omit them when absent; legacy rows read without fields, no backfill. Store full, display masked.

## Active-Binding Display & Validated Switching (#5094 F2 / #5099)

Every surface that carries a binding shows it, from one shared client
store (`src/client/accountBindingStore.ts` + `ActiveBindingBadge`):

- **Store**: one in-memory cache of GET `/api/broker/account-binding`,
  resolved per surface through the F1 `resolveEffectiveAccountBinding`
  (exact scope, else the tenant default). A save or switch anywhere
  re-renders every open surface — no surface keeps a stale binding.
- **Badge** (`ActiveBindingBadge`, beside the existing broker/mode badges):
  `<account-type label> ••••<last 4>` (masked), "No account bound" when
  unbound (never a silent default), Change reuses the existing
  `open-settings-menu` event. Mounted on the BrokerDynamicMenu header
  (tenant/stock), the order ticket (tenant, stock or options by ticket),
  the schedule dialog (schedule scope; a per-schedule account override
  replaces the stored binding in the display), and the portfolio /
  account views (tenant/stock).
- **Validated saves**: the AccountBindingSelector includes the selected
  broker's accounts as `availableAccounts` on its PUT when the accounts
  read serves the broker being saved, so the server validates the tuple
  (`validateAccountAgainstBroker`); on a broker mismatch, a failed read,
  or a gated-off accounts route it falls back to the plain upsert.
  `switchAccountBinding` adopts optimistically and reverts on a server
  refusal, so no surface keeps a binding the server refused.
- **Schedule payload**: an options schedule with a chosen account carries
  `{accountType: "options", accountId}` in its payload (accepted by the
  options criteria schema), so the display and the payload agree; the
  server resolves the run target from `{accountType, accountId}` at
  creation. The tenant default itself is never pinned into the payload.

