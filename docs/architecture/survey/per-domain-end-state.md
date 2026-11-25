# Per-domain end state — what changes in each domain, and the final types

Repo surveyed: `Qunsultant/cfagent` main at `3e516f1c` (2026-11-25).
Read-only synthesis. No code changed, no build run, no PR, no issue, no GitHub write.
Design decided by the owner (2026-11-25, not re-decided here): **JSON file as the context** —
`environment.config.json`, extended, IS the context carrier, resolved once per request into
one typed `UniversalEnvContext`. One resolver per question (#3786). Lossless/additive: every
capability keeps a named home. Consolidation domain by domain, reuse first, one issue at a
time, Config first.

Inputs: `context-survey-rca-plan.md` (209 contexts), `resolvers-and-issues-survey.md`
(587 resolvers), `target-state-counts.md` (target derivations), `domain-attribution.md`
(12 domains). Two worker syntheses reconciled here: per-domain table and final type lists
(scratch files in `/tmp`, verified by re-addition against the four input docs).

## 0. Counts up front

| | Today | After the program | Change |
|---|---|---|---|
| App-created context **types** | 209 | **4–7 (base case 4)** | 203–206 retire; 1 new (`UniversalEnvContext`) |
| Platform-provided context types (separate, cannot retire) | 3 types, 5 receipt sites | **3 types, 5 receipt sites** | 0 |
| Named resolver **definitions** | **587** (corrected — see §1) | **87–127 (central 106)** | ≈481 retire or fold |
| Distinct resolution **questions** (the lossless check) | ≈306 | **≈306 — all keep a named home** | 0 questions dropped |

The platform concept in the end state: **one** universal env context (`UniversalEnvContext`,
carrying platform / tenant / user (principal) / environment-mode / broker-provider /
request-operation / channels), composed with **one** validated execution context
(`ExecutionContext`, identity), resolved together at the boundaries (API #6172, MCP #6173,
DO route shell) via `resolvePlatformContext`, and answered by **one** universal resolver
(`resolveUniversalContext`, the extended `resolveEnvironmentConfig`). One cascade for all
config: run > session > user > runtime > env > file > built-in safe default.

## 1. Verification: resolvers today are 587, not 586 — central target 106 is unchanged

Both worker syntheses counted this independently from the docs and the clone, and agree:

- The resolver survey's headline says 586 = 557 standalone + **17** class methods + 9 Resolver
  types + 3 interface declarations — but its own §4 list contains **18 class-method rows**,
  all genuine (incl. `resolveRoute` at `src/trading/dataProviders/registry.ts:189`, confirmed
  in the clone). Corrected today total: 557 + 18 + 9 + 3 = **587**.
- The target doc's §2.5 already processes all 18 rows: **4 survivors covering 5 rows**
  (`resolveId` ×2 adapters = 1 question, `resolveUncached`, `resolveCalibratedPrompt`,
  `resolveRoute`) **plus 13 folded rows** = 18. So the +1 changes only the today total
  (586 → 587) and the retired count (**480 → 481**), not the central after-count of 106.
  The target doc's "17" / "586" labels are stale over row-level work that already covers 18.
- Arithmetic re-checked: central 1+0+6+8+4+11+4+2+0+4+61+4+1 = **106**; low
  1+0+5+6+3+9+3+2+0+3+51+3+1 = **87**; high 1+0+8+10+5+13+4+3+0+5+71+5+2 = **127**.

## 2. Per-domain end-state table

Mapping rule (stated so the table is re-derivable): **"today" counts are a partition of the
attribution doc's layer axis (§2c)**, each layer assigned wholly to exactly one domain, so the
domain "today" column (excluding D5) sums to 209 / 587 with no double-counting. **D5
Scheduling has no layer** — it is a workflow bucket whose items physically sit in the Config,
Services, Workflows, APIs and Agents layers already counted in D1/D6/D7/D8; its "today"
figure is shown in brackets, overlapping, NOT additive. **D12 is a composite** of 5 small
layers (MCP 2/14 + UI 8/8 + Chat/NLQ 0/6) plus workflow buckets with no layer of their own
(Market data, Social, Copilot parts), so its layer "today" (10/28) understates its workflow
scope — the reconciliation in §4 is the check that matters, not the within-domain
today→after comparison for D12. **"After" counts are a partition of the target doc's resolver
groups (§2.3/§2.4) and context bridge (§1.2)**, assigned by the surviving question's primary
home; where a group straddles two domains the split rule is stated in the row.

### D1 — Config — today 75 ctx / 74 res → after 2 ctx / 9 res (7–11) — BOTH change

- **Contexts 75 → 2.** REMAIN (named): raw `Env` (1 — shrinks as 52 text vars move to the
  file, stays 1 type) + `UniversalEnvContext` (1, NEW). RETIRE (76): `ResolvedEnvironment`,
  `EnvironmentETradeConfig`, `EnvironmentPaymentsConfig`, `EtapiConfig` + 16 sub-interfaces
  (become nested sections, not contexts), `OtelFileConfig`, `FeatureEvaluationContext`, the
  25 `*Modes` families' scope-carrier interfaces, misc `*Config` objects. Where they go:
  `UniversalEnvContext` sections; the 18 config JSON files remain as *data* (not counted);
  `FeatureFlagPort` / `OtelConfigPort` remain as seams (not counted).
- **Resolvers 74 → 9 (7–11).** REMAIN: the one universal resolver `resolveUniversalContext`
  (U, 1 — the extended `resolveEnvironmentConfig`) + 8 knob survivors from group C
  (tier-for-user 1, price 1, policy-by-port 3, job-catalogue parameters 2, provenance 1).
  RETIRE/fold: all 73 mode/switch resolvers (group A → 0 separate; ≈64 fields of the
  universal context, answered by the one internal generic switch) and ≈102 C knob fields
  (timeouts, thresholds, heartbeat, OTel settings, research-stage, feed cadence, … →
  universal fields). The broker-environment family folds in with the reads-vs-trades
  default asymmetry (#3382) preserved as *two fields*, not two resolvers.
- **WHAT CHANGES: BOTH contexts and resolvers — the biggest retirement on both axes
  (138 definitions retired) and the first domain.** Owner-decided carrier; unblocks the
  deploy Free cap (0 text vars + 40 secrets = 40 < 64).
- Open-decision sensitivity: tenant-override home — 0 effect on type counts (1–18 on
  files); 199 unread `Env` fields — 0 on types; file's unread `payments` section — 0.
  If the owner later rules each mode field is its own resolver, add up to +64 (A) / +102
  (C) — the JSON-as-context decision is what prevents this.

### D2 — Generic helpers / Shared — today 3 ctx / 38 res → after 0 ctx / 2 res (2–3) — RESOLVERS ONLY

- **Contexts 3 → 0.** The 3 shared/cross-layer contexts retire (their names are not
  itemized in the four input docs — flagged, not guessed). Capabilities go to explicit
  parameters / the composed pair, per the seam map.
- **Resolvers 38 → 2 (2–3).** REMAIN (named): `resolveCaller` (1 — runtime auth identity)
  + `resolvePorts` (1 — DI wiring). RETIRE/fold: the 34 kind-G duplicated helpers
  (`resolveBool` ×3, `resolvePositiveInt` ×3, `resolveMinutesKnob` ×6,
  `resolveSwitch` ×5, `resolveOne` ×5, `resolveDays` ×2, `resolveInt`,
  `resolveBoolean`, `resolveOperator` ×3) collapse to one copy each as *internal*
  parsing/switch primitives of the universal resolver (0 separate). Range +1 if
  `resolveOperator` is a distinct role-checked question from `resolveCaller`.
- **WHAT CHANGES: RESOLVERS ONLY** (the 3→0 context change is a deletion of bags, no
  context capability survives here). Home issue #3786 (census + standard + shrink-only
  pin, one resolver per question). **Gap:** the shared helpers have no shared home today
  — consolidation *creates* one by promoting an existing copy, it does not invent a new
  abstraction.

### D3 — Identity / Platform — today 21 ctx / 41 res → after 1–2 ctx / 13 res (10–15) — BOTH change

- **Contexts 21 → 1–2.** REMAIN (named): `ExecutionContext` (1 — the one validated
  execution context, #1078). RETIRE (20): all other security contexts — resolver I/O
  renamed to non-`Context` names (`ResolvePlatformContextInput` → plain input,
  `PlatformContextResult` → the composed pair itself, `ApiRequestContext*`,
  `McpToolContext*` I/O, `ExecutionContextAuthority` → renamed Deps,
  `ResolveLedgerWriteContext*` → narrowed `ExecutionContext` + explicit params,
  `ObligationEvaluationContext`, `TenantProviderContext` →
  `UniversalEnvContext.tenant.providers`, `PlatformIdentity` split across
  Execution/Universal/commercial). **Range +0–1:** legacy `ScreenerExecutionContext`
  retained pending the identity-unification owner decision (migrate its login store to
  `ExecutionContext.principalId` or record a sunset); the optional-`userLogin` inline
  shadows have no home until that decision. **Possible +1 OUTSIDE the base range:** a
  distinct audited ledger-write type if the owner/CISO requires separation of duties
  (headline would be 5–8, not 4–7).
- **Resolvers 41 → 13 (10–15).** REMAIN: group D, all 4 (execution-account binding 1,
  actor identity 1, DID document 1, user quota 1) + J secrets 2 (one generic
  secret-by-name resolver + token-set by family) + J identity/authz 7. RETIRE/fold:
  tenant copies (`resolveSubmissionTenant`/`resolveDeliveryTenant` near-identical pair,
  `resolveTickTenant`, `resolveEffectiveTenantId`/`resolveCurrentTenant`) → the one
  tenant question; `resolvePlatformContext` becomes the composer returning
  `{ execution, env }`.
- **WHAT CHANGES: BOTH contexts and resolvers.** Identity unification is a *separate*
  decision from config unification — the universal context ships first; the legacy login
  store retires only by ruling. No code converts `ScreenerExecutionContext` into
  `ExecutionContext` today; that mapping is the missing piece, not another context.
  (Note: the 5 `ScreenerExecutionContext` mirrors and the canonical definition are counted
  in D6's *today* by the layer partition, but their *after* fate is decided here.)

### D4 — Integration (broker / provider) — today 2 ctx / 108 res → after 0 ctx / 7 res (5–9) — RESOLVERS ONLY

- **Contexts 2 → 0.** The 2 integration-layer contexts retire into
  `UniversalEnvContext.tenant.providers` / `.broker` sections. (Their names are not
  itemized in the four input docs — flagged, not guessed. `TenantProviderContext` is a
  named candidate in the context survey §1.4, but it is listed there under Security, so
  it cannot be asserted to be one of the Integration layer's 2.)
- **Resolvers 108 → 7 (5–9).** REMAIN: group B, 6 (tenant credentials 1, tenant logins 1,
  provider binding 1, recipient binding 1, schedule channel state 1, publisher channel 1)
  + class-method `resolveRoute` (1 — capability assignment,
  `src/trading/dataProviders/registry.ts:189`; folds into F at the low end, hence the
  range). RETIRE/fold: the ~12 broker/provider selection resolvers
  (`resolveTenantBroker*`, `resolveTenantProviderContext`, `resolveChannelBroker`,
  `resolveBrokerSelection`, `resolveTradingPlatform`, …) and the ≥4 environment
  resolvers collapse to the universal context's broker/provider fields; the per-run
  `resolveRunBrokerContext` *is* the per-run universal context. Range 5–8 on B:
  `resolvePromptBrokerTools` may survive as a 7th; channel-state vs publish-channel may
  split (+1).
- **WHAT CHANGES: RESOLVERS ONLY in substance** (contexts 2 → 0 is a fold into Universal
  sections). One home: `resolveRunBrokerContext` fed by the `tenantProviders.ts` family;
  program home #3216 (slice #3460). Open decision: if tenant/broker selection is ruled a
  separate persisted-selection resolver rather than universal fields, +2–3.

### D5 — Scheduling — today [23 ctx / 84 res] workflow-axis, OVERLAPPING, not additive → after 0 ctx / 3 res (2–4) — BOTH change (workflow view)

- **Contexts [23] → 0.** Workflow-axis today (attribution §2a): schedule CRUD/list/row/
  source modes, cron entries, watchdog + heartbeat + retention, async-job plumbing,
  callbacks and approvals. All retire as types; capabilities go to Universal sections
  (schedule-surface modes), explicit scheduler/job seams, and the one scheduler (#3121).
  **These 23 are already inside D1/D6/D7/D8's today counts** — do NOT add them again.
- **Resolvers [84] → 3 (2–4).** REMAIN: the schedule questions inside group E —
  schedule source (1), schedule run trigger/id (1), pending approval / flags caller /
  firer dispatch (1 question-group, range 2–4). RETIRE/fold: schedule
  list/status/row/section/source-mode resolvers → Universal fields / catalogue; the
  deprecated `resolveScheduleUpdate` folds into the unified one; `resolveSchedule` (raw →
  config) is internal to the catalogue/universal.
- **WHAT CHANGES: BOTH contexts and resolvers (on the workflow view).** Consolidation
  already in flight — the one-schedule program (10 of 19 landed); ride it, do not start a
  parallel program. The E-group split (3 schedule vs 8 rest in D8) follows target §2.4's
  own numbering of E survivors.

### D6 — APIs / route bags — today 90 ctx / 45 res → after 0 ctx / 4 res (3–4) — CONTEXTS ONLY in substance

- **Contexts 90 → 0.** RETIRE (all): the 56 route shapes (+1 alias
  `BrokerOrderRouteContext = EtradeBrokerRouteContext`, which dies with its target) and
  the 26 orchestrator DI ports, plus the 5 `ScreenerExecutionContext` mirrors and other
  Tier A shapes physically in these layers (their *after* fate is decided in D3). Where
  they go: the composed pair (`ExecutionContext` + `UniversalEnvContext`) as the one
  handler shape, plus narrow explicit seams per the target §1.3 seam map (`env` →
  Universal; `agentCtx` → platform `AgentContext`, passed separately; `audit` → explicit
  param; `getOrm`/`sql`/`storage` → explicit data seam; `readSettingRaw` → gone as a live
  lookup, handlers read Universal fields; `getScreenerExecutionContext` →
  `ExecutionContext` itself; scoped modes → Universal sections; scheduler/job/commercial
  seams → explicit seam params; Deps objects are not contexts). No new context type is
  created here.
- **Resolvers 45 → 4 (3–4).** REMAIN: group F, all 4 (`resolveAgentCapabilityManifest`,
  `resolveUnitDriver`, `resolveRouteId`, `resolveChallengerOutcome` — four distinct
  questions). Low end 3 if `resolveRouteId` folds into a generic enum-validation helper.
- **WHAT CHANGES: CONTEXTS ONLY in substance** (resolvers 45 → 4 is the F-group residue;
  the domain's work is deleting 83 DI bags, one slice at a time, each slice deleting the
  bag it replaces). This is the largest context retirement by count (90), second-largest
  combined retirement (131 definitions).

### D7 — Services — today 4 ctx / 93 res → after 0 ctx / 16 res (14–18) — RESOLVERS ONLY

- **Contexts 4 → 0.** The 4 services-layer contexts retire (names not itemized in the
  four input docs — flagged, not guessed; the context survey's "Services inputs/results
  2" — `ResolveRunBrokerContextInput`, `ValidatedExecutionAccountContext` — are two
  candidates, the layer's other 2 are unnamed in the inputs). Capabilities go to
  `UniversalEnvContext.broker` + explicit resolver params.
- **Resolvers 93 → 16 (14–18).** REMAIN: the J copilot/strategy/trading-derivations
  bucket, 16 (strategy profile, thesis, risk profile, copilot trading selection/
  strategies/sessions/filer/activation, order type/TIF, ladder deltas, SPY-put contract,
  cancel targets, scan target/clock, allowed ids, panel bands, score weights ×2, side,
  enrichment selection/timeframe, market-data quotes, positions snapshot, preset filter).
  Verified anchor: `resolveScoreWeights` reads `SCORE_WEIGHTS` from the etapi config +
  a runtime `bias` input, so base weights are Universal fields and the bias-adjusted
  derivation survives as **1**; `resolveNoViewScoreWeights` calls it, 0 extra. RETIRE/
  fold: tenant copies → D3's one tenant question; per-service knob duplicates →
  Universal fields (D1); account-binding resolvers → D3's group D.
- **WHAT CHANGES: RESOLVERS ONLY** (contexts 4 → 0 is a fold). Judgment call: this bucket
  is the least body-read part of J — whether thesis/risk-profile/strategy-profile are
  three questions or one strategy-resolution question with three outputs moves this domain
  by ±2 and is the main reason for the 14–18 range.

### D8 — Workflows engine — today 2 ctx / 63 res → after 0 ctx / 18 res (15–22) — RESOLVERS ONLY

- **Contexts 2 → 0.** `JobStepContext` and `RunContext` retire *as `*Context` types*;
  their capabilities persist as engine-internal state under non-`Context` names
  (identity → Execution, config → Universal, `jobId`/`runId`/`stepIndex`/`item`/`params`
  → explicit step-handler params; `PipelineStageContext`'s mutable `brief` stays an
  explicit stage-state/`PipelineRunRecord` field). No capability is deleted, only renamed
  out of the `*Context` namespace.
- **Resolvers 63 → 18 (15–22).** REMAIN: group E non-schedule 8 (job-by-id catalogue 1 —
  the one externalized job catalogue, #5880, `kind` parameter; stage-by-path 1; chain
  source 1; dispatch/run id 2; provenance + failure code 2; observers 1) + J
  job/stage/research bucket 8 (ports/stores fold into D2's ports; catalogue spec folds
  into E; schedule timing folds into D5) + J host dispatch 2 (one generic host-dispatch
  question, range 1–3; +2 if per-work-type inputs differ). RETIRE/fold: the 6 `*OrThrow`
  wrappers (group H → 0; throwing is a call-site option on the 6 underlying E
  resolvers); `resolveFeedDispatchJobId` (re-resolves the same id/alias mapping — folds
  into the catalogue); `resolveStrategyProfile` defined twice (fold to one, counted in
  D7's bucket).
- **WHAT CHANGES: RESOLVERS ONLY** (contexts 2 → 0 is a rename, not a deletion). One
  resolver per job question; stage state lives in `JobStepContext`/`RunContext`
  successors under non-Context names. Range note: E granularity — one job-by-id resolver
  (counted) vs one per kind is +5; host-dispatch granularity is +4 at the extreme.

### D9 — Commercial / monetization — today 2 ctx / 44 res → after 0 ctx / 1 res (1–2) — RESOLVERS ONLY

- **Contexts 2 → 0 (as counted types).** The 2 commercial-layer contexts retire as
  `*Context`-named types; the `PriceCatalogue`/`PriceEntry` port **remains as a seam**
  (D1-backed price port, not counted as a context), because prices are per-tenant
  operator data, not environment config, and do not belong in `UniversalEnvContext`.
  (The layer's 2 contexts being `PriceCatalogue`/`PriceEntry` is consistent with — but
  not proven by — the inputs; flagged as inference, not verified.)
- **Resolvers 44 → 1 (1–2).** REMAIN: the `RefundPaymentSourceResolver` interface (1
  question — refund source; its 3 factories `createPayPerRun/Bundle/SubscriptionPaymentResolver`
  are adapter implementations, 0 extra). RETIRE/fold: per-route payment mode resolvers
  → Universal fields (D1, group A); tier-for-user and price questions → counted in
  D1's C survivors (see seam note below); refund provenance → D1's C provenance question;
  the 3 refund factories fold into the 1 interface.
- **WHAT CHANGES: RESOLVERS ONLY** (contexts 2 → 0 is a reclassification to uncounted
  seams, not a deletion). Seam note: the C-group tier (1) and price (1) survivors are
  counted in **D1**, not D9, because the target doc groups them under C
  (config/env/policy/payment knob). If the owner counts them in D9 instead, D1 becomes
  7 (5–9) and D9 becomes 3 (3–4); the program total is unchanged.

### D10 — Observability — today 0 ctx / 27 res → after 0 ctx / 2 res (2–3) — RESOLVERS ONLY

- **Contexts 0 → 0.** Nothing to retire (verified absence: OTEL's objects live in
  `src/config/otelModes.ts` and count under Config/D1 by file location).
- **Resolvers 27 → 2 (2–3).** REMAIN: J misc OTel catalog 1–2 (one generic catalog
  resolver for message/severity/alert-rule/record-kind, vs per-type at the high end) +
  class-method `resolveCalibratedPrompt` 1 (calibrated prompt for tenant/actor/key,
  `telemetryPorts.ts:553`). RETIRE/fold: the ~20 `OTEL_*` env vars and D1 overrides, the
  OTel settings resolvers, SLO thresholds, alerting and DLQ knobs →
  `UniversalEnvContext.otel` fields under the one 7-level cascade; the OTEL config port
  remains as the `runtime`-level override *seam* (not counted).
- **WHAT CHANGES: RESOLVERS ONLY — the smallest change of any domain** (25 definitions
  retired, zero context work at all).

### D11 — Data foundation — today 0 ctx / 26 res → after 0 ctx / 16 res (15–18) — RESOLVERS ONLY

- **Contexts 0 → 0.** Nothing to retire (verified absence: data access is via
  ports/adapters, not contexts).
- **Resolvers 26 → 16 (15–18).** REMAIN: J reports/ledger/run-detail bucket 15
  (stored report, serve leg, audit/error/outcome aspects, provenance, report link/
  canonical/format, scan linkage, feed quotes from artifact, run detail, ledger-write
  context, attribution, social rewards ×3, product access ×2, effective version, run
  context) + class-method `resolveId` 1 (run-id resolution; 2 adapter implementations
  of one interface, `runRegistryPorts.ts:139`). RETIRE/fold: the 6 `resolveId`/
  `resolveSymbols` adapter implementations stay as the two implementations of one
  interface each (counted once per question, in D11 for `resolveId`, in D12 for symbols
  via group I); D1/ORM/run-registry/storage policy resolvers → Universal fields or the
  surviving questions.
- **WHAT CHANGES: RESOLVERS ONLY.** Judgment call (flagged): the J reports/ledger bucket
  is assigned here because its core is the run ledger, stored reports and provenance —
  the data-foundation plane. It could equally be argued to belong to D7 (services) or
  to a reports domain; moving it would move 15 resolvers between domains, not change the
  program total. The bucket's range (14–17) reflects whether provenance is one generic
  question or per-row-type.

### D12 — MCP / UI / Chat-NLQ / Market data / Social — today 10 ctx / 28 res (layers) → after 1–3 ctx / 15 res (11–17) — BOTH change

- **Contexts 10 → 1–3.** REMAIN (named): `ToastContext` (1 — retained with reason:
  client UI feedback state shared across 11 component files; no home in
  Universal/Execution; out of scope of the platform program). RETIRE: `McpToolContext`
  and `OpenaimpMcpHandlerContext` (2 → composed pair + explicit seams; the latter is a
  near-subset of the former) and the 5 client data shapes (`ScanRunContext`,
  `OfferContext`, `PlatformContext` store, `ScheduleRowContext`, `TradeOrderContext` →
  renamed plain prop/state types; the client `PlatformContext` store becomes a
  client-side projection of the composed pair). **Range +0–2:** `ChainContext` and
  `PageChromeContext` (retain +1 each if the owner keeps them as local UI state;
  base case retires both to props — `PageChromeContext` is a single literal only
  `PageShell` reads; `ChainContext`'s provider and sole consumer are in the same file).
  Base case: 1 context (`ToastContext`); range 1–3.
- **Resolvers 28 → 15 (11–17).** REMAIN: group I, all 4 (universe-to-symbols 1, scope 1,
  leg/flow symbols 1, per-symbol derivation 1) + J delivery/recipient 5 + J A2A 2
  (`resolveA2AAgent`, `resolveA2AInstanceName` — 1–2) + J misc 3 (selected run 1,
  research venue 1 — `#6178` already landed the one venue resolver — offer 1) +
  class-method `resolveUncached` 1 (beta-for-symbol). RETIRE/fold: the 6 Chat/NLQ mode
  switches → Config cascade (D1); MCP tool-command mode/scope/principal resolution →
  composed pair + explicit seams; market-data/social provider selection → D4's one
  provider home; `resolveSymbols` ×2 adapters + interface → group I symbols (counted
  in the 4 above).
- **WHAT CHANGES: BOTH contexts and resolvers.** Mostly folding into D1, D2 and D4
  rather than its own program; small and last. Judgment call: D12's *today* layer
  counts (10/28) exclude the Market-data (5/26) and Social (2/25) workflow buckets and
  the Copilot workflow bucket (12/36), whose resolvers live in the Integration/Services
  layers in the today column (D4/D7) but whose surviving questions are counted here
  (group I, J delivery, A2A) or in D7 (copilot/strategy/trading bucket). The after
  column is therefore not comparable to the today column within this domain alone — the
  reconciliation in §4 is the check that matters.

## 3. Summary table — what changes per domain

| Domain | Contexts today → after | Resolvers today → after | What changes |
|---|---:|---:|---|
| D1 Config | 75 → **2** | 74 → **9** (7–11) | BOTH — biggest retirement (138) |
| D2 Generic helpers / Shared | 3 → **0** | 38 → **2** (2–3) | Resolvers only |
| D3 Identity / Platform | 21 → **1–2** | 41 → **13** (10–15) | BOTH |
| D4 Integration | 2 → **0** | 108 → **7** (5–9) | Resolvers only |
| D5 Scheduling | [23] → **0** (overlapping) | [84] → **3** (2–4) | BOTH (workflow view) |
| D6 APIs / route bags | 90 → **0** | 45 → **4** (3–4) | Contexts only in substance (90 retire) |
| D7 Services | 4 → **0** | 93 → **16** (14–18) | Resolvers only |
| D8 Workflows engine | 2 → **0** | 63 → **18** (15–22) | Resolvers only |
| D9 Commercial | 2 → **0** | 44 → **1** (1–2) | Resolvers only |
| D10 Observability | 0 → **0** | 27 → **2** (2–3) | Resolvers only — smallest change |
| D11 Data foundation | 0 → **0** | 26 → **16** (15–18) | Resolvers only |
| D12 MCP / UI / Chat-NLQ / Market / Social | 10 → **1–3** | 28 → **15** (11–17) | BOTH |

Reading it: only **4 of the 12 domains change contexts at all** (D1, D3, D5, D6, D12 —
five, counting D5's workflow view; D6 is the context story). The other 7 domains are
**resolvers-only** work, and two of them (D10, D11) have **zero contexts today and zero
after** — their entire change is resolvers folding into Universal fields or surviving
questions. The context program is really a 4-domain program (Config, Identity, APIs,
MCP/UI); the resolver program is a 12-domain program.

## 4. Final types, enumerated

### 4a. Final context types — base case 4, range 4–7

| # | Type | What it carries | Decision that keeps / removes it |
|---|---|---|---|
| 1 | `UniversalEnvContext` — **NEW** | The one universal env context, resolved once per request from the extended `environment.config.json` (+ request overrides: tenant, user, `overrideEnv`), carrying **platform / tenant / user (principal) / environment-mode / broker-provider / request-operation / channels**. Sections: core `environment` / `etrade` / `payments`, `etapi`, `otel`, `flags`, per-domain mode sections (`screener`, `nlq`, `marketData`, …), plus `sessionStore`, `platformContext.cache`, `commercial`, `jobs`, `trading`, `research`, `brokers`, `heartbeat`, `lifecycle`, `profileLimits`, `sessionLimits`, `vocabulary`, `channelBrokers`, `idpProfile`, `orderCapabilities`, `shardPacing`, `sloThresholds`, `analyticsLake`, `opportunityHunt`, `researchRules`. One cascade: run > session > user > runtime > env > file > builtin. | None — owner-decided (JSON file as the context, 2026-11-25). The program's new type. |
| 2 | `ExecutionContext` (app, `src/security/executionContext.ts:106`) | The one validated identity context: `tenantId`, `workspaceId?`, `principalId` (internal user id, never a login/email), `principalType`, `initiatingPrincipalId`, `taskId`, `agentRunId?`, `delegationId?`, `serviceId`, `connectionId?`, `externalAccountId?`, `environment: "sandbox"\|"live"`, `policyVersion`, `entitlementReference?`, `approvalReference?`, `correlationId`, `sessionId?`, `runId?`, `platformId?`, `traceId?`, `dispatchMode?`, `execMode?: "sync"\|"async"`. Resolved fresh per request/operation, never stored as identity; frozen; revalidated across boundaries. | None — retained as-is (#1078). Distinct from the Workers `ExecutionContext` of the same name (§4b). |
| 3 | Raw `Env` (`src/types.ts:3`, 335 fields) | The raw Worker binding shape the runtime hands the Worker: bindings (DO namespaces, queues, workflows, R2, D1, AI, Vectorize, KV, `FLAGS`, …), secrets, vars. Passed at the Worker/DO boundary only, never threaded through handlers. It shrinks (52 text vars move to the file; 199 unread fields per an open owner decision) but stays 1 type. | None — retained; the runtime shape cannot be replaced by the resolved context. Field-count changes have **0 effect on the type count**. |
| 4 | `ToastContext` (`Toast.tsx:59`) | Client React UI feedback state, shared across 11 component files. No home in Universal/Execution; forcing it there would be wrong. | None — retained with reason; out of scope of the platform program. |
| 5 | `ScreenerExecutionContext` (canonical) — **conditional, +1** | Legacy per-DO-instance identity: `userLogin: string; environment?: "TEST"\|"PROD"`, persisted in DO storage under `screener:execution-context`. The 5 mirrors + inline shadows retire regardless; only the canonical legacy login store is in question. | **OPEN — identity unification.** Base case retires it (login → `ExecutionContext.principalId`; TEST/PROD → one mode vocabulary). Retained (+1, total 5) only if the owner keeps the legacy login store with a recorded sunset. Also settles the optional-`userLogin` shadows. |
| 6 | `ChainContext` — **conditional, +1** | Client React context; provider and sole consumer in the same file; contracts/refresh/target are local UI state. | **OPEN — client retention.** Base case retires it to props (+0). |
| 7 | `PageChromeContext` — **conditional, +1** | Client React context carrying a single literal (`"page"\|"tab"\|"nested"`); only `PageShell` reads it; all providers pass `"tab"`. | **OPEN — client retention.** Base case retires it to an explicit prop (+0). |

**Context-type count (app-created): base case 4, range 4–7.** Bridge check: 209 − 206 + 1 new = 4;
209 − 203 + 1 new = 7. Outside the base range (flagged, not in 4–7): **ledger-write
separation +0–1** (distinct audited type if owner/CISO requires it → headline 5–8);
**2 unitemized Tier A companion shapes ±0–2** (survey gap — the context survey reports 17 Tier A
definitions but itemizes 15 by name; if either is a distinct retained identity type, add +1
each).

### 4b. Platform-provided context types — SEPARATE, 3 types, 5 receipt sites (cannot retire)

| # | Type | Where received |
|---|---|---|
| P1 | Workers `ExecutionContext` | 3 sites: `scheduled`, `queue`, `email` (the `email()` site is a dead pass-through — the site could be dropped, type-count effect 0) |
| P2 | `DurableObjectState` | 3 constructors |
| P3 | Agents-SDK `AgentContext` | `this.ctx` |

Not app-created, cannot retire, counted separately from the 4–7 above. Note the name
collision: the app's validated `ExecutionContext` (§4a #2) and the Workers `ExecutionContext`
(P1) are distinct types that both remain.

### 4c. Final resolver types — central 106, range 87–127

Counting rule (target §2.1): a resolver = a named, cross-module function/type answering one
question for callers outside the universal-resolution module; internal helpers inside that
module, `*OrThrow` wrappers, aliases, and per-file copies = 0. A resolver listed with a
`resolve*` / `create*` name is **function-named** (the docs name that function). A resolver
listed as a quoted question with no function name is **question-named — name to be decided
at build time; this is the question, not yet a function name**. Nothing below invents a
function name.

**U — universal (1).** `resolveUniversalContext` — function-named (the extended
`resolveEnvironmentConfig`, `src/config/environment.ts:102`), resolved once per request.
Absorbs as fields/mechanism: `resolveEnvironmentConfig` itself; `resolveETradeBaseUrl`
(internal validation helper); the broker-environment family (reads-vs-trades default
asymmetry #3382 preserved as *two fields*, not two resolvers); `getEtapiConfig` (etapi
slice); all OTel resolvers (OTel fields); the flag adapters stay as 2 implementations of
the one `FeatureFlagPort` (0 resolvers). Secrets are NOT absorbed (values come via the one
generic secret resolver in J).

**A — mode/switch (0 separate).** All 73 collapse into ≈64 fields of `UniversalEnvContext`,
answered by the one internal generic switch (`resolveSwitch<T>`). No A question is dropped;
no A resolver survives separately. **Flag:** if the owner later decides each mode field is
its own resolver, add ≈64 — the JSON-as-context design is what rules this out.

**B — tenant/broker/provider/platform (6; range 5–8).** Surviving questions are store/state
lookups the JSON file cannot answer: (B1) "Tenant credentials for this tenant" —
`resolveTenantCredentials`; (B2) "Logins belonging to this tenant" —
`resolveTenantLogins` / `resolveLoginsForTenant` (same question); (B3) "Provider binding for
this login/tenant" — `resolveProviderBinding`; (B4) "Recipient binding for this channel" —
`resolveEnvChannelRecipientBinding` / `resolveTenantOwnerEmailBinding` (one question, env vs
tenant source); (B5) "Schedule channel state / flags view" — `resolveScheduleChannelState` /
`resolveScheduleChannelFlagsView`; (B6) "Publisher channel for this delivery" —
`resolveAndVerifyPublisherSlackChannel` / `resolveSocialSlackChannel` /
`resolveChannelDisposition` (one channel-routing question). Range: `resolvePromptBrokerTools`
may survive as a 7th; channel-state vs publish-channel may split (+1). **Flag — tenant-override
home:** if tenant/broker selection is kept as a separate persisted-selection resolver rather
than Universal fields: **+2–3**.

**C — config/env/policy/payment knob (8; range 6–10).** ≈102 knob fields become Universal
fields. Survivors: (C1) "Tier for this user (stored tier + transition)" —
`resolvePremiumTier` / `resolveEmailTier` / `resolveMeteredTier` / `resolveEffectiveTier` /
`resolveTier` / `resolveAdsTier` / `resolveTierTransition` (+ `createMeterTierResolver`);
(C2) "Price for this product/family" — `resolveProductPrice` / `resolvePrice` (+ class
`resolveChargePricing`); (C3–C5) "Policy by port" — audit, pipeline, retry/breaker policy
(`resolveAuditPolicy`, `resolvePipelinePolicy`, `resolveD1RetryPolicy`,
`resolveBreakerPolicyFor`, `resolvePdpPolicySource` — 3 questions, range 2–4); (C6–C7)
"Job-catalogue parameter questions" — `resolveParameter`, `resolveEnumSource`,
`resolveParamDerivation` (2, range 1–3; fold into E's catalogue resolver at the low end);
(C8) "Provenance from a row" — `resolveMeterProvenance`, `resolveGatewayProvenance`,
`resolveRefundProvenance` (one generic question, range 0–2). The 3 refund factories are
implementations of the one `RefundPaymentSourceResolver` interface — counted under §4 types,
not here.

**D — user/account/identity/binding (4; range 3–5).** (D1) "Execution-account binding for
this request/schedule/label/manual call" — `resolveUserAccountBinding`,
`resolveExecutionAccountTuple`, `resolveExecutionAccountContext`,
`resolveValidatedExecutionAccountContext`, `resolveScheduleBindingDefaults`,
`resolveEffectiveAccountBinding`, `resolveAccountByLabel`, `resolveAccountId`,
`resolvePaidScreenAccount`, `resolveStockCopilotActiveBinding` (one question, parameterized
by schedule/label/manual); (D2) "Actor identity / login for this request/job" —
`resolveIdentityFacts`, `resolveEntryUserId`, `resolveDoNameForUser`, `resolveAliasLogin`,
`resolveCaptureUserLogin`, `resolveLogins`, `resolveDispatchCandidate`,
`resolveAsyncJobIdentity`, `resolveScheduledLogin`, `resolveTrustedScheduleIdentity`,
`resolveTokenServiceLogin`, `resolveServiceLoginForEtrade` (one question); (D3) "DID document
for this DID" — `resolveAgentDidDocument`, `resolveEtradeAuthorizerDid`,
`resolveSnapIdentity` (folds into D2 at the low end); (D4) "User request quota (runtime
counter)" — `resolveUserRequestQuota`. **Flag — identity unification:** D1/D2 are the
questions whose home depends on the legacy-store decision; the questions are answered once
either way in the central count.

**E — job/pipeline/chain/stage/schedule (11; range 9–13).** (E1) "Job definition by id/kind"
— `resolveFeedJob`, `resolveEnrichJob`, `resolveAnalyzeJob`, `resolveGenerateJob`,
`resolveDeliverJob`, `resolvePipelineChain`, `resolveAnalyzeStepJob`, `resolveSubJob` (one
question with a `kind` parameter — the one externalized job catalogue, #5880); (E2)
"Schedule source" — `resolveScheduleSource`; (E3) "Schedule run trigger / job id" —
`resolveScheduleRunJobId`, `resolveScheduleRunTrigger`; (E4) "Pending schedule approval /
flags caller / firer dispatch" — `resolvePendingScheduleApproval`,
`resolveScheduleFlagsCaller`, `resolveScheduledFirerHostDispatch` (3 questions, range 2–4);
(E5) "Stage by path" — `resolveStage`, `resolveStageNode`, `resolveWorkflowStage`,
`resolveOptionsStageId`; (E6) "Chain source" — `resolveChainSourceForRequest`,
`resolveShardChainSource`, `resolveChainAuthority`; (E7) "Dispatch job id" —
`resolveFeedDispatchJobId`, `resolveFeedDispatchPipelineRunId`; (E8) "Run id for this
job/workflow" — `resolveScreenJobId`, `resolveWorkflowRunId`, `resolveLinkedJobRunId`;
(E9) "Job provenance" — `resolveJobProvenance`; (E10) "Job failure code" —
`resolveJobFailureCode`; (E11) "Job-pipeline control observers" —
`resolveJobPipelineControlObservers`. **Flag — catalogue granularity:** one job-by-id
resolver (counted) vs one per kind: **+5**.

**F — routing/DI/registry/manifest (4; range 3–4).** All function-named, each a distinct
question that survives: `resolveAgentCapabilityManifest`, `resolveUnitDriver`,
`resolveRouteId`, `resolveChallengerOutcome`. Low end 3 if `resolveRouteId` folds into a
generic enum-validation helper.

**G — generic duplicated helper (2; range 2–3).** (G1) "Caller (runtime auth identity)" —
`resolveCaller`; (G2) "Ports (DI wiring)" — `resolvePorts`. Range 2–3 if `resolveOperator`
is a distinct role-checked question. Bool/int/switch are internal to the universal resolver,
0. **Flag:** if caller/ports become context fields rather than surviving resolvers: **−2**.

**H — pipeline `*OrThrow` (0).** The 6 wrappers are a call-site throwing option on the 6
underlying E resolvers, not separate questions. **Flag:** reversing that rule adds +6.

**I — symbols/universe/scope (4; range 3–5).** (I1) "Universe → symbols" —
`resolveUniverse`, `resolveRunUniverse`, `resolveUniverseSymbols`, `resolveUniverseListings`,
`resolveAllListings`, `resolveUniverseListWithHydration`, `resolveUniverseIndex`,
`resolveCopilotUniverse`, `resolveCopilotUniverseFull`, `resolveCopilotUniversePreset` (one
question; sync parse vs stored-index read are two sources, same question); (I2) "Scope for
this tool/report" — `resolveToolScope`, `resolveScopesWithRoleAdapter`,
`resolveOptionsReportScope`, `resolveScopeSymbols`; (I3) "Leg/flow symbols" —
`resolveGoalStockLegSymbols`, `resolveGoalOptionsLegSymbols`, `resolveDynamicFlowSymbols`,
`resolveTrackedSymbols`, `resolveTapeSymbols`; (I4) "Per-symbol derivation" —
`resolveFeedSnapshotForSymbol`, `resolveSymbol`, `resolveStockSector` (folds into I3 at the
low end).

**J — other domain-specific (61; range 51–71) — the bounded group.** Every one of the 176 J
entries is assigned to a bucket below. Per-bucket point numbers are **allocated to reconcile
to the doc's point 61** (the target doc gives only ranges per bucket, not per-bucket points);
treat per-bucket points as the reconciling allocation, not doc-stated points. Bucket ranges
are doc-stated.

| J bucket | Entries | Survivors (range) | Point | Surviving questions |
|---|---|---:|---:|---|
| Config-absorbed | 27 | 0 | 0 | None — Universal fields. |
| Secrets/credentials | 8 | 1–2 | 2 | "Secret value by name" (question-named, one generic resolver); "+ token-set by family" (question-named). **Flag:** one per secret instead of one generic: **+6**. |
| Host dispatch | 6 | 1–3 | 2 | "Host dispatch for this work item" (question-named, one generic question). **Flag:** one per work-type: **+4**. |
| Delivery/recipient/verify + email | 14 | 4–6 | 5 | "Publish target / submission endpoint / post URL"; "Publisher webhook/email verification"; "Slack/webhook recipient verification at delivery"; "Email destination / options-run email recipient"; "Agent email namespace" (incl. `createPortThinkEmailResolver` as the factory) — all question-named. |
| Copilot/strategy/trading derivations | 27 | 14–18 | 16 | 1 function-named: "bias-adjusted score weights" — `resolveScoreWeights` (base weights are Universal fields; `resolveNoViewScoreWeights` calls it, 0 extra). Rest question-named: "strategy profile", "thesis", "risk profile" (flag: 3 questions or 1 strategy-resolution question with 3 outputs? ±2), "copilot trading selection", "copilot strategies", "copilot sessions", "copilot filer", "copilot activation", "order type / TIF", "ladder deltas", "SPY-put contract", "cancel targets", "scan target / clock", "allowed ids", "panel bands", "side", "enrichment selection / timeframe", "market-data quotes", "positions snapshot", "preset filter". |
| Reports/ledger/run-detail/provenance/rewards/product | 25 | 14–17 | 15 | Question-named: "stored report", "serve leg", "audit aspect", "error aspect", "outcome aspect", "provenance" (flag: one generic or per-row-type?), "report link", "canonical report", "report format", "scan linkage", "feed quotes from artifact", "run detail", "ledger-write context", "attribution", "social rewards" (×3, one question family), "product access" (×2), "effective version", "run context". |
| Identity/authz/session, J-side | 21 | 6–8 | 7 | Question-named: "viewer", "acting session", "MCP principal", "draft owner", "execution context" (`resolveExecutionContext` is the per-run universal context itself, 0 extra), "grant proposal", "bootstrap", "offboard", "DO-name input", "store-operator access", "current list", "principal", "screen execution context", "paid-screen action", "brief date" (pure date formatter — drops as a classification correction). Caller variants fold into G's caller. |
| Job/stage/research/DI/ports/catalogue/generic | 33 | 7–10 | 9 | Question-named: "stub lookup" (but see no-home `resolveStub` below), "stores", "checkout/token/research stores", "spec axes / number / param", "sections helpers", "statement / recreate plan", "handoffs" (×2), "schedule timing / lifecycle", "node", "observers", "run-now trigger", "Yahoo deps", "research datasets / adapters", "knowledge / memory-read", "public bars", "bulk-move population", "x402 network", "voice backends" (×2). Ports/stores fold into G's ports; catalogue spec folds into E; schedule timing folds into E. |
| A2A | 2 | 1–2 | 1 | "A2A agent / instance name" — `resolveA2AAgent` / `resolveA2AInstanceName` (function-named; 1–2 depending on whether agent and instance-name are one question). |
| Misc stragglers | 13 | 3–5 | 4 | "Selected run" — `resolveSelectedRun` (function-named, 1); "OTel catalog" (question-named, 1–2); "Research venue" — `resolveResearchVenue` (function-named, 1; already landed, #6178); "Offer" (question-named, 1). Stored index → I; prefixes → G; screen selection → B. |
| **J total** | **176** | **51–71** | **61** | Point column sums to 61 by construction (0+2+2+5+16+15+7+9+1+4 = 61). |

**§4 class methods (+4; range 3–5).** (CM1) "Run id" — `resolveId` (2 adapter
implementations; interface `runRegistryPorts.ts:139` is the contract); (CM2) "Beta for a
symbol (uncached)" — `resolveUncached` (`betaService.ts:140`, with `BetaResolver` type);
(CM3) "Calibrated prompt for tenant/actor/key" — `resolveCalibratedPrompt`
(`telemetryPorts.ts:553`); (CM4) "Capability assignment" — `resolveRoute`
(`dataProviders/registry.ts:189`; folds into F at the low end, hence range 3–5). Folded
(0 extra, 13 rows): `resolveDeliveryTenant` → B tenant; `resolveWatchlistSymbols` → I
universe; `resolveTokenIdentity` → D actor identity; `resolveMany` → J allowed-strategy-ids;
`resolveEngineClient` → G ports; `resolveStrategyProfile` (class) → J strategy profile
(duplicate of the standalone); `resolveUnderlyings` → I symbols; `resolveAccount` → D
account binding; `resolveDefaultAccountNumber` → D account binding; `resolveSymbols` ×2
adapters + interface → I symbols; `resolveChargePricing` → C price; `resolveApiKey` → J
generic secret.

**§4 types/interfaces (+1; range 1–2).** (T1) "Refund source" — `RefundPaymentSourceResolver`
(interface, `src/data/refundPorts.ts:542`); its 3 factories
(`createPayPerRun/Bundle/SubscriptionPaymentResolver`) are adapter implementations, 0 extra.
Folded (0 extra): `McpRoleResolver` → I scope; `ProviderResolver` /
`ProviderIssuerResolver` → B provider; `WalletLoginResolver` → D identity;
`SettingResolver` → internal to universal; `JobPipelineControlOtelResolver` → E
observers/OTel; `BetaResolver` → CM2 (already counted); `BrokerChainSourceResolver` → E
chain source; interface `resolveStage` → E stage.

### 4d. Resolver-count check

Central: U 1 + A 0 + B 6 + C 8 + D 4 + E 11 + F 4 + G 2 + H 0 + I 4 + J 61 + CM 4 + T 1
= **106**. Low: 1+0+5+6+3+9+3+2+0+3+51+3+1 = **87**. High:
1+0+8+10+5+13+4+3+0+5+71+5+2 = **127**.

## 5. Reconciliation

### Contexts — after (base case 4, range 4–7)

| Domain | After (ctx) |
|---|---:|
| D1 Config | 2 (`Env` + `UniversalEnvContext`) |
| D2 Generic helpers / Shared | 0 |
| D3 Identity / Platform | 1–2 (`ExecutionContext` + legacy `ScreenerExecutionContext` 0–1) |
| D4 Integration | 0 |
| D5 Scheduling | 0 |
| D6 APIs / route bags | 0 |
| D7 Services | 0 |
| D8 Workflows engine | 0 |
| D9 Commercial | 0 (`PriceCatalogue`/`PriceEntry` persist as uncounted seams) |
| D10 Observability | 0 |
| D11 Data foundation | 0 |
| D12 MCP / UI / Chat-NLQ / Market / Social | 1–3 (`ToastContext` + `ChainContext` 0–1 + `PageChromeContext` 0–1) |
| **Total** | **4–7 (base case 4)** |

Check: 2 + 1 + 1 = 4 base; +1 (D3) +2 (D12) = 7 max. **RECONCILES** with target §0/§1.2.
Platform-provided contexts (3 types, 5 receipt sites) remain separately and are not in this
sum. Outside the base range: +1 possible audited ledger-write type (D3/D9 seam, owner/CISO
→ headline 5–8); ±0–2 for the 2 unitemized Tier A companion shapes.

### Resolvers — after (central 106, range 87–127)

| Domain | After central (range) | Composition (target groups) |
|---|---:|---|
| D1 Config | 9 (7–11) | U 1 + C 8 (6–10) |
| D2 Generic helpers / Shared | 2 (2–3) | G 2 (2–3) |
| D3 Identity / Platform | 13 (10–15) | D 4 (3–5) + J secrets 2 (1–2) + J identity 7 (6–8) |
| D4 Integration | 7 (5–9) | B 6 (5–8) + class `resolveRoute` 1 (0–1) |
| D5 Scheduling | 3 (2–4) | E schedule 3 (2–4) |
| D6 APIs / route bags | 4 (3–4) | F 4 (3–4) |
| D7 Services | 16 (14–18) | J copilot/strategy/trading 16 (14–18) |
| D8 Workflows engine | 18 (15–22) | E rest 8 (7–9) + J job/stage 8 (7–10) + J host dispatch 2 (1–3) |
| D9 Commercial | 1 (1–2) | §4 type refund-source 1 (1–2) |
| D10 Observability | 2 (2–3) | J misc OTel catalog 1 (1–2) + class `resolveCalibratedPrompt` 1 |
| D11 Data foundation | 16 (15–18) | J reports/ledger 15 (14–17) + class `resolveId` 1 |
| D12 MCP / UI / Chat-NLQ / Market / Social | 15 (11–17) | I 4 (3–5) + J delivery 5 (4–6) + J A2A 2 (1–2) + J misc 3 (2–3) + class `resolveUncached` 1 |
| **Total** | **106 (87–127 claimed)** | |

Sum check — central: 9+2+13+7+3+4+16+18+1+2+16+15 = **106 ✓**.
Sum check — low: 7+2+10+5+2+3+14+15+1+2+15+11 = **87 ✓**.
Sum check — high: 11+3+15+9+4+4+18+22+2+3+18+17 = **126, not 127 — GAP OF 1**.
The gap is inherited from the target doc itself, not from this split: target §2.3 gives the
class-method group a range of 3–5, but target §2.5 names exactly **4** survivors
(`resolveId`, `resolveUncached`, `resolveCalibratedPrompt`, `resolveRoute`) — the 5th
high-end survivor has no named row. This split allocates the 4 named survivors
(`resolveRoute` → D4, `resolveCalibratedPrompt` → D10, `resolveId` → D11,
`resolveUncached` → D12) and carries no unnamed +1. If the target doc's high end is taken
at face value, the missing +1 belongs to whichever domain holds that unnamed 5th
class-method survivor; until it is named, the honest high total for this split is 126.
Central (106) and low (87) reconcile exactly.

### Today — cross-check (layer partition, D5 overlapping)

Excluding D5: contexts 75+3+21+2+90+4+2+2+0+0+10 = **209 ✓**; resolvers
74+38+41+108+45+93+63+44+27+26+28 = **587 ✓**. D5's workflow-axis [23/84] sits inside
those numbers (its items live in D1/D6/D7/D8 layers) and must not be added again.

## 6. Open decisions that move the totals most

| Decision | Effect | Status |
|---|---|---|
| Per-field vs universal mode/config resolvers | **+64 (A fields) / +102 (C knobs)** if each field keeps its own resolver — the single largest swing | **Decided** — the JSON-as-context design rules it out |
| Dead-code analysis (134 file-local resolvers unexamined) | **−13–27** (10–20% dead → central ~79–93) — sensitivity only, nothing subtracted until proven | Open — needs a dead-code pass |
| J body reads (~40 ambiguous entries) | **±10** on the central (thesis/risk-profile/strategy-profile ±2, provenance ±1–2, host dispatch ±2, OTel catalog ±1) | Open — needs body reads |
| Job catalogue granularity (one by-id vs one per kind) | +5 | Open |
| Host dispatch granularity (one generic vs one per work-type) | +4 | Open |
| Secrets (one generic by-name vs one per secret) | +6 | Open |
| `*OrThrow` variants kept as exports | +6 | Open (rule: throwing is a call-site option) |
| Broker/tenant selection placement (Universal fields vs separate persisted-selection resolver) | +2–3 | Open |
| Caller/ports as context fields vs surviving resolvers | −2 | Open |
| Identity unification (legacy `ScreenerExecutionContext`) | **±1 context** (D3) | Open — owner decision |
| Client React retention (`ChainContext`, `PageChromeContext`) | **+0–2 contexts** (D12) | Open — owner decision |
| Ledger-write separation | **+0–1 context** outside the base range (headline 5–8) | Open — owner/CISO decision |
| Tenant-override home | 0 on types, 1–18 on files (D1) | Open — owner decision |
| 3 no-home resolver candidates (`resolveStub`, `resolveReaderHalt`, `resolveCurrentList`) | Each +1, folds into an existing question, or outside the count — body read decides; unallocated to any domain above | Open — needs body reads |

**The one open decision that moves the totals most:** among *undecided* decisions, the
dead-code analysis (−13–27) is the largest resolver swing and identity unification (±1) the
largest context swing. The largest swing of all — per-field vs universal resolvers
(+64/+102) — is already decided by the owner's JSON-file-as-context ruling.

## 7. Caveats — what could not be verified

- **High-end gap of 1** (§5): the domain highs sum to 126, not the target doc's 127, because
  the target doc's class-method range (3–5) names only 4 survivors. Central 106 and low 87
  reconcile exactly; the gap is a naming gap in the target doc, not a missing definition.
- **J per-bucket points are a reconciling allocation** (§4c): the target doc gives only bucket
  ranges (51–71); the point column sums to 61 by construction. Per-bucket points are ±1–2
  pending body reads of the ~40 ambiguous entries.
- **A2A / job-stage ±1 allocation difference between the two worker syntheses:** one worker
  allocates A2A 1 / job-stage 9, the other A2A 2 / job-stage 8. Both are inside the
  doc-stated ranges (A2A 1–2, job/stage 7–10) and both sum to the same 61 J total and the
  same 106 central. The domain table in §2 uses the A2A 2 / job-stage 8 allocation; the
  alternative moves 1 resolver between D8 and D12 and changes no total.
- **Unverifiable names from the four input docs** (stated, not asserted): the names of the
  3 Shared-layer contexts (D2), the 2 Integration-layer contexts (D4), the 4
  Services-layer contexts (D7), and whether the Commercial layer's 2 contexts are
  `PriceCatalogue`/`PriceEntry` (D9 — consistent with, but not proven by, the inputs).
  The `/tmp` layer/workflow attribution files cited in the attribution doc were absent in
  this session. The D8 layer's 2 contexts are inferred as `JobStepContext`/`RunContext`
  from the target doc's mapping, but the layer's own itemization was not available.
- **3 no-home resolver candidates unallocated:** `resolveStub` (`meshDoors.ts:413`),
  `resolveReaderHalt` (`scheduled-agent.ts:301`), `resolveCurrentList`
  (`server/routes/auth.ts:2999`) — if any survives a body read it would push the central
  total above 106 (landing in D8 or D12 by subject). `resolveBriefDate` drops as a
  classification correction (pure date formatter). The deprecated `resolveScheduleUpdate`
  folds into the unified one.
- **2 unitemized Tier A companion shapes:** the context survey reports 17 Tier A
  definitions but itemizes 15 by name; no home can be assigned until they are itemized.
- **A failed tool call inside one worker** (one `exec` returned exit 1; details not
  surfaced in its report): the worker still completed, and every number in this document
  was re-checked by addition against the four input docs by the coordinator — the failure
  did not block the deliverable, but the failed call itself was not identified.

## 8. Sources traced

- `~/workspace/your_files/context-survey-rca-plan.md` — 209 contexts, RCA, fix plan.
- `~/workspace/your_files/resolvers-and-issues-survey.md` — 587 resolvers (corrected from
  586; §4 lists 18 class-method rows).
- `~/workspace/your_files/target-state-counts.md` — target derivations (contexts 209 → 4–7;
  resolvers 586-base → 87–127, central 106; the 587 correction leaves 106 unchanged — §1).
- `~/workspace/your_files/domain-attribution.md` — 12 domains, per-layer/per-workflow counts,
  consolidation order, 4 gaps with no reusable home.
- `~/workspace/scratch-cfagent-main` — Qunsultant/cfagent main `3e516f1c` (verification only).
