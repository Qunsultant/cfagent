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
- **Schedules (`src/agents/routes/schedules.ts`, NLQ arm, baseline arm)**: creation resolves the tuple (asset class defaults to the callback's class — options analysis resolves the options account) and stamps it on the payload identity; a caller-supplied `accountId`/`accountType` is stripped before the payload is built, and an update re-stamps the existing tuple rather than re-targeting the account. Fire time re-validates the tuple against the broker's current accounts (`enforceScheduleBinding` in `src/agents/orchestrator.ts`); a stamped account that no longer resolves is refused before the service call, and a pre-F3 unstamped payload resolves from the one defaults home (issue #6301: stored selection → vocabulary default, account via the validated-account resolution) instead of being refused — a named refusal happens only when the resolution itself fails. The blank-broker repair sweep re-stamps the system-owned baseline on the maintenance path (issue #6301). A broker enumeration failure at fire time throws (the run records a failure and the SDK retry applies) — an unverifiable run is never recorded as a refusal. Pipeline-job schedules (`runPipelineJobSchedule`) are broker-free and carry no stamp.
- **Autopilot (`src/agents/routes/autopilot.ts`)**: evaluate resolves the tuple first and records it on the verdict (`broker` / `accountType` / `accountId` / `bindingScope` / `bindingSource` in `mas_policy_verdicts`); the monthly evaluation records a refused evaluation as skipped, not failed. The balance snapshot stays single-broker (#4571 owns any routing change); the tuple is threaded to its call site and recorded on the verdict only.
- **Copilots**: order tools refuse via the broker-orders guards; a turn still answers read-only questions but names "No account bound" and never issues an order tool call. The stock copilot prompt carries the bound account masked (or "No account bound" when unbound); the door + route status payloads carry the masked active binding.
- **Refusal semantics**: refusals are loud, coded, and recorded — skipped runs with the failure code as the detail reason, never failed runs, never silent. Run records (`JobRunRecord`, cron dispatch records, callback ledger rows) carry the tuple fields when present and omit them when absent; legacy rows read without fields, no backfill. Callback ledger rows carry the guard's resolved binding from the outcome (issue #6301), so a blank-payload run records the broker it actually resolved to. Store full, display masked.

## Chat-Side Binding (F4 / #5101)

F3 made the tuple enforced; F4 makes it inspectable, switchable, and named in chat. The model never holds a full account id.

- **Masked tool (`broker_account_binding`, `src/mcps/openaimp/accountBindingCommands.ts`)**: every return is masked (`maskAccountBinding` / `maskBrokerAccount` in `src/trading/accountBindings.ts`) — bindings, tuples, enumerated accounts, candidate ids, and the ids quoted back in validation errors. The model-visible schema now lists all eight actions (`list` / `get` / `set` / `clear` / `validate` / `migrate` / `registry_get` / `registry_update`).
- **Validated `set` (`listBrokerAccountsForMode`, `src/services/accountBindings.ts`)**: `set` enumerates the broker's accounts server-side for the target mode (paper → TEST, live → PROD) through the broker's own platform and validates through `validateAndUpsertAccountBinding` — an unknown id, an unowned account, or an unavailable enumeration fails closed with the F1/F3 coded error, never an unvalidated upsert. Shared with B1 — one enumeration helper, no duplicate. A broker without the `accounts` capability refuses by name.
- **Switch-by-label (`resolveAccountByLabel`, `src/trading/accountBindings.ts`)**: `set` accepts `accountName` alone and resolves it server-side against the enumerated accounts (exact match, else a single substring match). Zero matches fail with `FAILURE_ACCOUNT_UNKNOWN`; several fail with `FAILURE_ACCOUNT_MIGRATION_AMBIGUOUS` listing candidate names — ask, never guess. The stored name is the enumerated account's own name, never a model-supplied string.
- **Prompt (`bindingPromptLine`, `src/agents/chatPrompt.ts`)**: the copilot prompt names the bound account (accountType + masked id + accountName when present) and steers the model at `broker_account_binding` for show/list/switch, by label, never by full id. Unbound turns steer at the tool to bind one.
- **NLQ intents (`binding_show` / `binding_list` / `binding_switch`, `src/agents/nlq/`)**: the rule planner and the LLM planner both map binding questions; the async executor serves them (show resolves the chat's own broker/mode selection when none is named; switch binds the copilot scope, by label or by the F1 single-candidate rule) and returns masked ids only. The sync executor refuses them explicitly (#923 pattern — enumeration and writes are async-only).
- **Client bridge (`src/client/chat/AgentChatTabContent.tsx` + `bindingBridge.ts`)**: a `broker_account_binding` set-success in a chat turn reloads the F2 store from the server (`fetchAccountBindings(true)`); the masked result is never adopted into the cache. `ToolResultView` renders the binding card from the masked id / account name / code / error only.

## Audit-Record Provenance (F5 / #5102)

Every record carries the binding tuple it executed against
(`accountType` / `accountId` / `bindingScope` / `bindingSource`),
stored full and displayed masked. New rows are stamped; legacy
rows read as explicit nulls (unbound) — no backfill, ever. "No
record without a binding" applies only to brokered executions;
non-broker runs record with explicit nulls.

- **Run records (`JobRunRecord`, migration 0084)**: the D1 table
  gains the four columns + `job_run_records_binding_idx`; the
  DO-SQLite and in-memory adapters round-trip the tuple (F3 had
  already stamped the DO half). The builder validates the four
  fields like the linkage ids (string-or-null, non-empty, never a
  poisoned `"undefined"`/`"null"` literal, #3650); the normalizer
  fills explicit nulls on legacy rows. The scheduled agent's
  shared funnel stamps explicit nulls — the tick loop carries no
  firing binding and F3's rule forbids a fresh ambient read at
  fire time. The engine's own terminal records (`job-pipeline`)
  stay unbound: threading the dispatch binding through the
  instance schema is a follow-on (see below); the schedule
  callback's twin of a bound pipeline run does carry the tuple,
  so the binding is provable for the firing.
- **Trades (`mas_trades`)**: F3 stamped the tuple at preview and
  proves it at execute; F5 verified the NLQ arm writes no trade
  rows (its only `mas_trades` write is the `cancel_order` status
  update on an existing draft). The trade ledger renders a masked
  Account column per row (`LedgerPanel`).
- **Reports ride the run row**: `RunSummary` carries the tuple
  (from the run record, or from the report body's provenance);
  the merge hands a canonical report row its D1 ledger twin's
  tuple when its own body carries none. The screener CSV bytes
  are unchanged by design — its columns mirror the XLSX tab
  column-for-column and the module forbids comment lines
  ("Provenance rides in report metadata, never in the CSV
  bytes"); the binding rides the run row the CSV hangs from.
  `GET /api/runs` and `GET /api/workflow-runs` take a binding
  filter (`broker` / `mode` / `accountType` / `accountId` /
  `bindingScope`, `src/services/bindingFilter.ts`); an invalid
  value is a 400, never a silent empty page, and an unbound row
  never matches a present field.
- **Deliveries**: a delivery run carries its generating run's
  tuple from its options (stamped in `finish()`); the
  pipeline-step caller passes none, so pipeline-dispatched
  delivery runs stamp explicit nulls until the engine follow-on
  lands. Channel records do not duplicate the tuple — they
  inherit it for display from their parent run. No table
  migration: the adapters round-trip the artifact as
  `artifactJson`.
- **Audit events**: every brokered-execution audit event carries
  the binding fields (`broker.account_binding_resolved` at
  preview, `autopilot.policy_check_failed` at execute, the
  copilot turn binding, `schedule.account_binding_resolved` at
  creation). The vault card shows a compact masked binding cell
  per brokered event; the raw-payload detail view is unchanged
  (the one pre-existing explicit full-payload surface).
- **Surfaces**: a masked Account column per row on the run
  ledger, Docs & Reports (sortable), and the trade ledger; the
  run-details modal masks the provenance `accountId` entry.
  History rows render the RECORDED tuple via
  `formatRecordBindingLabel` — not the F2 badge, which is
  store-driven for the live binding and carries a Change
  affordance that would be wrong on a historical row.
- **Follow-on (not built here)**: thread the dispatch binding
  through the pipeline engine instance (`JobInstanceRecord` +
  `job_pipeline_instances` migration) so the engine's own
  `job-pipeline` terminal records carry the tuple instead of
  reading unbound.

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
- **Inline selector (#6153)**: the order ticket also carries the selector
  inline, under the header (same slot as the badge): a compact `Select`
  of the broker's enumerated accounts, switching through
  `switchAccountBinding` — the same store and validation as the menu
  selector's save. It renders only when the accounts read serves the
  ticket's broker; otherwise the badge + Change remain the only path.
  The badge stays the display and Change stays the shortcut to the full
  selector (registry, free-text account ID, other brokers/scopes).
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

