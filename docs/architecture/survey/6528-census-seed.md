# #6528 Phase 1 (Config: census + pins) — census seed

Seed base: main `e5541ff` (2026-11-25). The machine-readable census is the
three pin tests (`tests/worker_var_count_6528.test.ts`,
`tests/universal_context_census_6528.test.ts`,
`tests/universal_resolver_census_6528.test.ts` — each file's inline
`BASELINE` array + header comment, the repo's established census-pin
convention per #3525/#6151). This file is the human-readable seed record:
the numbers, the decisions, and the reconciliations that do not fit in a
test header. Sources: the six survey docs in this directory (written
against main `3e516f1c`) and the recount on `e5541ff`
(`~/workspace/6528-recount.md`) plus the pin design
(`~/workspace/6528-pin-design.md`).

## 0. Seed numbers

| Census | Seeded total | Composition |
|---|---:|---|
| Contexts, app-created | **209** | 129 itemized `*Context` rows − 1 alias + 1 `PlatformIdentity` + 77 config + 3 React + 2 unitemized Tier A (allowance) |
| Contexts, platform-provided | **3 types** | Workers `ExecutionContext`, `DurableObjectState`, Agents-SDK `AgentContext` |
| Contexts, test-only | **0** | No `*Context` definition under `tests/` |
| Resolvers | **595** | 564 standalone + 18 class methods + 9 Resolver types + 4 interface declarations |
| Distinct resolver questions | **≈306** | Range 285–320, central estimate — NEVER asserted exact |
| Worker text vars (live) | **51** | 53 `vars` keys − 2 `_comment_*` |
| Worker secrets (recorded) | **40** | Deployed count per error 10055 — data with provenance, not derivable from the repo |
| Deployed total (pin) | **91** | 51 live + 40 recorded (as Cloudflare counts it: 53 keys + 40 = 93) |
| Free-plan cap (target) | **64** | Hard `≤ 64` assertion lands with Phase 3, not here |

## 1. Recount deltas (survey `3e516f1c` → seed `e5541ff`)

| # | Recount | Survey | Delta |
|---|---:|---:|---|
| Contexts | 209 / 3 / 0 | 209 / 3 / 0 | **0 / 0 / 0** |
| Resolvers | 594 per recount; **595 seeded** (see §4) | 587 (copies-and-overlaps §0) / 586 (resolver survey §1) | **+7 standalone** (all #6482, genuine) **+1 interface declaration** (see §4) |
| Text vars | 51 live | 52 | **−1** — the survey's own §1.5 inventory sums to 51; the "52" most likely counts the commented-out `STOCK_COPILOT_CADENCE` line |
| Read sites (baseline method) | 32 direct `env.<VAR>` in 16 files + 0 literal string-keyed | 32 direct | **0** |

The resolver survey's "586" is itself stale: its own §4 lists 18
class-method rows (the 18th being `resolveRoute`,
`src/trading/dataProviders/registry.ts:189`), so its arithmetic should
have read 557 + 18 + 9 + 3 = 587, which is what copies-and-overlaps §0
says ("587 — confirmed").

## 2. Context decisions

### 2.1 Server `OfferContext` — EXCLUDED, total stays 209 (judgment call)

A second, distinct `OfferContext` definition exists at
`src/services/upgradeOffers.ts:758` (`{ trigger, shownAtMs? }`, the
audit-only payload the client passes to the mint routes; the counted
client one is `src/client/commercialApi.ts:572`). It predates the
baseline — the survey missed it, it is not new. **Decision: exclude it.**
Reason: survey §0 as written counts inputs only where listed in the
services/security rows, and this input is not listed there. The survey's
applied practice (recount §1.3) excludes it, so the total stays 209.
Counting it would make the total 210. The row is in the pin's EXCLUDED
list with this reason, so the decision is visible in the pin.

### 2.2 Config-77 decomposition — recorded, not recomputed

The survey's own arithmetic does not pin down which misc objects are
inside the 77. §0 enumerates 70 before misc (1 Env + 1
ResolvedEnvironment + 17 Etapi + 2 OTEL + 2 flags + 2 price + 25 Modes +
18 JSON + 2 file/wrangler), implying **7** misc — but §1.5 says the 2
reader-less JSON files (`auto-merge.json`, `options-reports.json`) are
excluded, which would make it 68 + **9** misc. The total is 77 either
way and nothing in it changed. **Decision: the pin records 77 as census
data (stating the §0 reading, 70 + 7, and the §1.5 reading, 68 + 9,
alongside each other) and asserts the 70 enumerated components exist
plus all 24 misc objects named in §1.5 exist (a superset check).** It
does not recompute the 77 from parts, because no recomputation is
determined by the survey.

### 2.3 The 209 reconciliation (measured, not asserted)

The anchored regex finds **174** `*Context` definitions in `src/`
(comment-stripped, statement-position, import continuations excluded).
Of those, **45 are EXCLUDED** boundary rows (each with a reason in the
pin): §0 inputs/results/deny-codes not listed in the services/security
rows, domain-internal parameter objects, shapes of counted items, UI
prop types, and the server `OfferContext` (§2.1). That leaves **129
counted `*Context` rows** (execution-identity 15, DI ports 26, routes 57
names, security 20, MCP 2, services inputs/results 2, client data
shapes 5, config-named 2). The 209 is then:

129 counted rows − 1 alias (`BrokerOrderRouteContext`,
`brokerOrders.ts:91`, a type alias `= EtradeBrokerRouteContext`, not a
shape) − 2 config-named rows (`FeatureEvaluationContext`,
`PlatformContextCacheLimits`, counted inside the 77 instead) + 1
`PlatformIdentity` (a counted non-`*Context*` name,
`src/services/platformIdentity.ts:194`) + 77 config + 3 client React
contexts (`PageChromeContext`, `ToastContext`, `ChainContext` — `const`
declarations, not types) + 2 unitemized Tier A companion shapes
(§2.4) = **209**.

Note the survey's own kind table double-counts the 2 MCP rows inside
its security 21 (the §1.4 table lists 21 rows including `McpToolContext`
and `OpenaimpMcpHandlerContext`, and §0 then adds "MCP 2" separately);
the reconciliation above counts each row once: security 20 = 19 table
rows + `PlatformContextFacts` (the unitemized 21st, see §2.5), MCP 2
separate.

### 2.4 Unitemized Tier A allowance — seed gap, flagged not hidden

The survey reports 17 Tier A definitions but itemizes 15 by name; the 2
companion shapes were never named. No candidate rows exist in the
measured set that are Tier-A execution shapes outside the 15 named —
every measured `*Context` row is accounted for in the pin's baseline or
in EXCLUDED with a reason — so the pin carries them as a **recorded
allowance of 2**, not as rows. The pin design's "itemize all 209 at seed
time" could not be satisfied from the survey as written. Itemizing the 2
companions is follow-up census work.

### 2.5 The security 21st member — `PlatformContextFacts`

The survey's security count is 21 with 1 unitemized member; the recount
names `PlatformContextFacts` / `EvaluateExecutionContextResult` as the
two candidates, both present. **Decision: count `PlatformContextFacts`**
(`src/security/platformContext.ts:199`, non-exported) as the 21st, and
exclude `EvaluateExecutionContextResult` (`src/security/executionContext.ts:842`)
as a §0 result type. This is a judgment call between two live
candidates; either choice keeps the total at 21, and the pin records
which one was taken.

## 3. Resolver seed

- **Standalone 564** = the survey's 557 rows (all verified present on
  `e5541ff`, none missing) + the 7 new #6482 schedule-firing resolvers,
  each body-read (all apply a priority cascade / env-parse-with-
  validation / defaulting, i.e. they meet the survey §1 definition):
  `resolveScheduleFiringEnabled` (`src/config/scheduleFiringKillSwitch.ts:52`),
  `resolveScheduleFiringRateAlertThreshold` (`src/config/scheduleFiringRateAlert.ts:35`),
  `resolveScheduleFiringRateAlertWindowMinutes` (`src/config/scheduleFiringRateAlert.ts:45`),
  `resolveScheduleMinIntervalSeconds` (`src/config/scheduleFrequencyFloor.ts:50`),
  `resolveEffectiveScheduleFloor` (`src/services/scheduleControls.ts:102`),
  `resolveEffectiveScheduleFiringEnabled` (`src/services/scheduleControls.ts:141`),
  `resolveScheduleControlsView` (`src/services/scheduleControls.ts:402`).
  Overload signatures collapsed (13 lines: 6 for
  `resolveEtradeRestSwitch`, 7 for `resolveMarketDataRestSwitch`).
  `resolveOne` is 5 definitions in `src/config/otelModes.ts` (one per
  enclosing `resolveOtel*Settings` function) — the baseline row carries
  count 5.
- **Class methods 18** — exactly the survey §4 list (including the 18th,
  `resolveRoute`).
- **Resolver types 9** — exactly the survey §4 list.
- **Interface declarations 4** — see §4.

## 4. The 595th resolver — `resolveTokenSet` (recount correction)

The recount seeds 594 = 564 + 18 + 9 + **3** interface declarations.
An exhaustive scan of interface bodies finds a **4th** interface
declaration the survey and the recount both missed: `resolveTokenSet`
(`src/data/tokenPorts.ts:220`), a method of the `EtradeTokenPort`
interface, implemented anonymously in `src/data/tokenFamilyKvImpl.ts:188`
(`const etrade: EtradeTokenPort = { ... }` — the same anonymous-
implementation shape the survey already excludes from the definition
count). It is the same kind as the other three (contract-only
declarations: `resolveId` `runRegistryPorts.ts:139`, `resolveSymbols`
`retrievalPorts.ts:107`, `resolveStage`
`agentScheduleCapability.ts:599`). **Seeded total: 595.** Landing 594
would fail the pin on its first run, so the pin seeds the measured 595
and records this +1 here, in the test header, and in the PR body.

## 5. Questions — a range, never exact

Distinct questions ≈**306** (range **285–320**, central estimate —
`copies-and-overlaps.md` §5: "an estimate, not a recount"). The pin
asserts only that 285 < 306 < 320. Implied copies at the seeded total:
275–310 (595 − 320 … 595 − 285). Per-row question keys are UNMAPPED at
seed (the survey itemizes ≈190 of the long tail, not all 595); the pin's
same-question-duplicate check uses the definition NAME as the question
proxy for new definitions (a new definition whose name already exists in
the baseline at another file fails). The full question mapping is #3786
census work, not this slice.

The DI-fallback boundary is kept as seeded (3 `otelAlerting.ts`
bindings in, 4 same-shaped bindings out); a uniform re-adjudication
moves the standalone total to 561 (all out) or 568 (all in). The 8
excluded `const resolve*` non-functions (2 aliases, 4 DI-fallback
bindings, `resolveInput`, `resolveRoles`) are listed in the pin as data.

## 6. Tests-only resolvers — 15 rows, not 7

The survey §4 names 7 tests-only resolvers. The exhaustive scan finds
**15 rows / 14 keys** under `tests/`: the 7 named, plus
`resolvePlatform` (`tests/broker_stage_input_3960.test.ts:574`),
`resolveProvider` (`tests/iaaa_logged_in_users_2836.test.ts:39`,
`tests/security_hub_coherent_6164.test.ts:221`), `resolveRoles` ×2
(`tests/mcp_tool_context_6173.test.ts:343,355`), `resolveClassName`
(`tests/mesh_registry_s1_2322.test.ts:78`), and `resolveEngineClient` +
`resolveStrategyProfile` (`tests/single_pdf_path_s4.test.ts:183,180` —
class methods of a test-double class mirroring the production methods).
The pin baselines the measured 15 rows. `scripts/` has only
`resolveBase` (`scripts/lint-changed.mjs:31`), a CI lint helper.

## 7. Read-site inventory (for Phase 3 scoping — an investigation note, not a pin)

- Baseline method: **32 direct `env.<VAR>` line-hits in 16 files + 0
  literal string-keyed reads** (`env["NAME"]` 0; `readSettingRaw("KEY")`
  0 for all 51 names; `process.env` 0). Reproduced exactly on `e5541ff`
  (independent raw grep: 32 hits, 16 files).
- Precision note: the 32 lines contain 35 occurrences (3 lines read the
  var twice), and 1 line is a doc comment, not a read
  (`src/agents/chatPrompt.ts:356` — the real read is `:361`). True
  runtime reads: 34 occurrences across 31 code lines.
- Complete accounting (all read forms in `src/`): **65 code lines** (31
  direct + 23 `env?.VAR` + 3 aliased `?.VAR` + 8 dynamic string-keyed),
  **50 of 51 vars read, `WORKSPACE_ROOT` the only var with zero reads of
  any kind**. Per-var attributions total 79. Full tables in the recount
  §3.3–§3.6. Phase 3 must migrate the 65 lines, not just the 32.

## 8. Var / secrets provenance

- Text vars: counted from the repo — the pin parses `wrangler.jsonc`
  (comment-stripped) and counts keys in the `vars` block: 53 keys = 51
  live + 2 `_comment_*` (`_comment_wallet`, `_comment_stripe`). The
  commented-out `"STOCK_COPILOT_CADENCE"` line is not live and is not
  counted. `CF_DEPLOY_VERSION` IS counted (deploy-injected placeholder,
  a real deployed var).
- Secrets: **40, recorded as data with provenance, not derivable from
  the repo.** Source: Cloudflare error 10055, run 45546276362 (93 total
  − 53 vars = 40). The `sync-secrets` job in
  `.github/workflows/deploy.yml` writes at most 49 distinct names (21
  `require_secret` + 30 `optional_secret`, PROD/SANDBOX pairs mutually
  exclusive); `optional_secret` skips an absent value, so fewer than 49
  are actually deployed. If the recorded 40 drifts from reality, the
  deploy error — not the pin — is the detector.
- `keep_vars: true` (`wrangler.jsonc:14`): the pin measures the FILE;
  the deployed count only drops when vars are removed out-of-band.
  File-count green ≠ deployed-count green.

## 9. The var pin's shrink-only decision (and why)

A hard assertion `live + secrets ≤ 64` is red on main at landing
(91 > 64) and stays red until Phase 3 moves the vars into
`environment.config.json` — which conflicts with gitops §7 rule 2 ("No
red pins merge") and §10 (a red pin on main is a stop-the-line event).
So this PR lands the shrink-only ceiling (`≤` the seeded totals: live
≤ 51, all keys ≤ 53, deployed total ≤ 91) and the hard `≤ 64`
assertion replaces the ceiling in the Phase 3 PR that moves the vars
into the file — the PR that can actually turn it green. The pin asserts
the cap constant (64), not the total.

## 10. Phase 2 (#6540, 2026-11-25) — census delta 209 → 210 / 595 → 596

Phase 2 defines the one universal env context and its single resolver
(`src/config/environment.ts`); the pins are updated in the same PR
(gitops §7 rule 1). No other census number moves: worker vars stay
51 live / 91 deployed, platform-provided contexts stay 3 types,
test-only contexts stay 0.

| Census | Before | After | Delta |
|---|---:|---:|---|
| Contexts, app-created | 209 | **210** | +1 |
| Resolvers | 595 | **596** | +1 |

### 10.1 Context +1 — `UniversalEnvContext` (CANONICAL)

The new row is `src/config/environment.ts` / `UniversalEnvContext`,
disposition CANONICAL: the one universal env context the programme
adds (survey `target-state-counts.md` §2,
`per-domain-end-state.md` D1). Its nested dimension types
(`UniversalPlatformDimension`, `UniversalTenantDimension`,
`UniversalUserDimension`, `UniversalSettingSources`) and its input
(`ResolveUniversalInput`) deliberately carry no `Context` name, so
they are not separate contexts (survey §1.1: nested sections are not
contexts) and add no further rows. The `OfferContext` exclusion
(§2.1) still holds: counting the excluded server `OfferContext`
would now make the total 211.

### 10.2 Resolver +1 — `resolveUniversalContext` (CANONICAL)

The new row is `src/config/environment.ts` /
`resolveUniversalContext`, standalone, disposition CANONICAL: the one
universal resolver, a NEW resolver that calls
`resolveEnvironmentConfig` (reuse first) rather than an extension of
it, so the old resolver's row is untouched and the count grows by
exactly one. The source helpers it uses
(`sourceOfEnvironmentName`, `sourceOfBrokerBaseUrl`) are not
`resolve*`-named and are internal to the universal-resolution module,
hence 0 separate resolvers by the §2.1 counting rule (target-state
§2.1). Implied copies move 275–310 → 276–311
(596 − 320 … 596 − 285); the distinct-question range (285–320,
central 306) is unchanged — the universal resolver answers the one
config question, it does not add a question.

### 10.3 Neutrality pin — `environment.ts` brand row 51 → 56

The new resolver records the resolution source per setting, so it
names the provider's own environment bindings and reads the core
broker credentials — 6 new brand lines, 1 removed (the old cascade
comment's brand line is now broker-neutral). Dispositioned
INTEGRATION in `tests/neutrality_census_3525.test.ts`: naming the
provider is the config module's job — it resolves the provider's own
env bindings, and neutralizing the binding names would falsify the
source record. No other neutrality row moves.
