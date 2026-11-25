# Copies and overlaps — definitions vs mentions, copies, and lossless consolidation

Repo surveyed: `Qunsultant/cfagent` main at `3e516f1c` (2026-11-25), from a fresh depth-1 clone.
Read-only counting. No code changed, no build run, no PR, no issue, no GitHub write.
Inputs: `resolvers-and-issues-survey.md`, `target-state-counts.md`, `context-survey-rca-plan.md`,
`domain-attribution.md`, `per-domain-end-state.md`; every multiplicity below was verified in the clone
or in the survey lists. Three workers contributed: definitions-vs-mentions (clone greps),
copies + overlap inventory, and arithmetic reconciliation.

## 0. Counts up front

| | Count |
|---|---|
| **Resolver definitions (today)** | **587 — confirmed** (557 standalone + 18 class methods + 9 Resolver types + 3 interface declarations). The survey's "586" / "17" labels are stale: its own §4 lists 18 class-method rows, the 18th being `resolveRoute` (`src/trading/dataProviders/registry.ts:189`), verified in the clone. |
| **Distinct resolution questions** | **≈306** (range ≈285–320, central estimate — see §5) |
| **Duplicate copies** (definitions answering a question already answered) | **281** (range 267–302) = 587 − ≈306 |
| **Distinct questions that become fields** of the one universal resolver (real questions, not duplicates) | **200** |
| **Total retired / folded (question-units)** | **481** (range 460–500) = 281 copies + 200 fields = 587 − 106 |
| **Survivors after the program** | **106** (range 87–127; honest high **126** on named evidence — see §4) |
| **Definitions in named overlap clusters** | **86**, of which **72 consolidate** (14 survivor question-units) |
| **Copies not in any named cluster (long tail)** | **209** = 281 − 72 (itemized ≈190, unallocated ≈19 — see §3) |

The rule: **mentions are call sites, definitions are what get consolidated.** A resolver with
157 mentions is still 1 definition. A question answered 6 times is 6 definitions and 1 question.

## 1. Definitions vs mentions — the 11 most-mentioned resolvers

The survey's "mentions" rule is a substring grep in `src/` (`grep -rn <name> src/`). All 11 survey
numbers reproduce exactly under that rule. But substring lines are **not** call sites: they include
the definition line, imports, comments, and longer identifiers that merely start with the name.
True call site = exact-word occurrence followed by `(` on the same line, excluding the definition line.

| Resolver | Definitions (verified) | Survey mentions (substring lines, src/) | Exact-word lines | True call sites |
|---|---|---:|---:|---:|
| `resolveIaaaTenant` | 1 — `src/security/iaaaGithubEndToEnd.ts:164` | 157 | 157 | 107 |
| `resolveTenantBroker` | 1 — `src/services/tenantProviders.ts:169` | 95 | 76 | 43 |
| `resolveEnvironmentConfig` | 1 — `src/config/environment.ts:102` | 64 | 64 | 43 |
| `resolveFeedJob` | 1 — `src/services/feedPipelineJobs.ts:360` | 63 | 8 | **2** |
| `resolveTenantProviders` | 1 — `src/services/tenantProviders.ts:111` | 26 | 26 | 12 |
| `resolveBrokerEnvironmentFromSettings` | 1 — `src/agents/routes/brokerEnvironment.ts:65` | 21 | 21 | 11 |
| `resolveTradeEnvironmentFromSettings` | **0 — alias** (see below) | 17 | 17 | 7 |
| `resolveAgentConfig` | 1 — `src/services/agentConfigResolver.ts:340` | 14 | 14 | 8 |
| `resolveScreenerAgentName` | 1 — `src/agents/screenerAgentName.ts:28` | 13 | 13 | 6 |
| `resolveChainSourceForRequest` | 1 — `src/workflows/brokerChainSourceResidency.ts:92` | 12 | 12 | 6 |
| `resolveScheduledLogin` | 1 — `src/agents/orchestrator/scheduleMaintenance.ts:77` | 10 | 10 | 7 |
| **Total** | **10 definitions + 1 alias** | **512** | — | **252** |

Two mention counts are materially misleading as "mentions":

- **`resolveFeedJob` (63 → 2 real calls).** Of the 63 substring lines, 55 are *different* resolvers:
  `resolveFeedJobTimeouts` 15, `resolveFeedJobCadenceMinutes` 14, `resolveFeedJobStaleMinutes` 13,
  `resolveFeedJobTimeoutMs` 8, `resolveFeedJobOrThrow` 5. The 8 exact-word lines are: the definition,
  2 calls (`asyncJobs.ts:995`, `meshDoors.ts:535` — the latter inside the OrThrow wrapper),
  2 imports, 3 comments. (Subcount caveat: a Python classifier counted 4 `name(` occurrences
  vs the grep enumeration's 3; the 2-true-calls figure follows the grep enumeration.)
- **`resolveTenantBroker` (95 → 43 real calls).** 19 of the 95 are `resolveTenantBrokerSelection`,
  a different resolver.

**Alias verified:** `resolveTradeEnvironmentFromSettings` is **not a definition**.
`src/agents/routes/brokerEnvironment.ts:105`:
`export const resolveTradeEnvironmentFromSettings = resolveSharedTradingEnvironment;`
— a compatibility re-export of `resolveSharedTradingEnvironment` (`:91`). Its 17 "mentions" are
7 calls + imports/comments of the alias name. It counts as 0 definitions and is excluded from
the overlap clusters (it is not a copy to consolidate; deleting the alias is a separate cleanup).

**Scope note:** repo-wide substring lines (tests + docs + changelog) are far larger
(e.g. `resolveIaaaTenant` 207, `resolveTenantBroker` 186, `resolveFeedJob` 182,
`resolveEnvironmentConfig` 94). The survey's numbers are src/-only. Tests were excluded from
definitions (e.g. `const resolveTenantBroker = vi.fn()` mocks are not definitions).

## 2. Copies — 587 definitions, ≈306 questions, 281 copies

Counting rule: **copies = definitions − distinct questions**;
**fields = distinct questions − survivors**;
**retired = definitions − survivors = copies + fields**.
Survivors are counted in question-units, as in the target doc.
200 + 281 = 481. The 200 are **not** duplicates — each is a real question that stops being a
standalone definition and becomes a field of the one universal resolver. The 281 are the true copies.

| Group | Definitions today | Distinct questions | Survivors | Copies folded | …of which become universal fields | Retired (copies+fields) |
|---|---:|---:|---:|---:|---:|---:|
| A — mode/switch | 73 | ~64 | 0 | 9 | 64 | 73 |
| B — tenant/broker/provider | 51 | ~17 | 6 | 34 | 11 | 45 |
| C — config/env/policy knob | 114 | ~102 | 9* | 12 | 93 | 105 |
| D — user/account/identity/binding | 28 | 4 | 4 | 24 | 0 | 24 |
| E — job/pipeline/chain/stage/schedule | 49 | ~20 | 11 | 29 | 9 | 38 |
| F — routing/DI/registry/manifest | 4 | 4 | 4 | 0 | 0 | 0 |
| G — generic duplicated helper | 34 | 5–6 | 2 | 28–29 | 3–4 | 32 |
| H — pipeline `*OrThrow` wrapper | 6 | 0 | 0 | 6 | 0 | 6 |
| I — symbols/universe/scope | 22 | 4 | 4 | 18 | 0 | 18 |
| J — other domain-specific | 176 | ~90 | 61 | 86 | 29 | 115 |
| Class methods (§4) | 18 | 4 new† | 4 | 14 | 0 | 14 |
| Types + interfaces (§4) | 12 | 1 new† | 1 | 11 | 0 | 11 |
| **Naive sum of group centrals** | **587** | **~315.5** | **106** | **~271.5** | **~209.5** | **481** |
| Cross-group overlap / rounding adjustment | — | −9.5 | — | +9.5 | −9.5 | 0 |
| **Headline** | **587** | **≈306** | **106** | **281** | **200** | **481** |

\* C survivors = 8 named in the target doc (tier, price, 3 policy-by-port, 2 catalogue, provenance)
**+ 1 universal resolver** (`resolveEnvironmentConfig` → `resolveUniversalContext`). It is counted
once, inside C's 114 — see the U-note in §4. Displayed either as U=1 + C=8 or as C=9, the total is 106.
† Class/types "distinct new" = questions not already counted in the standalone groups; the other
14 class methods / 11 types answer questions already counted under A–J.

**Fields vs same-question consolidation, in words:**

- **Fold into the universal resolver as fields (200 distinct questions):** A 64 mode fields +
  C ~93 knob fields are the bulk (158); plus B 11 (tenant, broker-env, provider selections,
  platform identity, run-broker context), E 9 (job-definition/stage/schedule raw→config validation,
  list/section filters), J ~29 (OTel fields, heartbeat due-hours, retention, shard pacing,
  session cap, vocab, research rules, etc.), G ~3–4 (bool/int/switch internals).
- **Consolidate into a surviving resolver of the same question (281 copies):** the duplicate
  definitions of a question that survives (as a resolver *or* as a field). Largest same-question
  piles: D account-binding family 10 defs → 1 survivor (9 copies); D actor-identity family
  12 → 1 (11 copies); I universe family 10 → 1 (9 copies); G 28–29 → internal primitives +
  `resolveCaller` + `resolvePorts`; B tenant/broker families (see §3); E job-by-id family
  8 → 1 catalogue resolver (7 copies); H 6 wrappers → their 6 underlying E resolvers;
  J tier family 7 → 1 tier question (6 copies), secrets 8 → 1–2 generic secret resolvers.

## 3. Overlap inventory — 86 definitions in clusters, 72 consolidate, losslessly

Counting rule: **a definition appears in at most one cluster.** Sub-clusters (the two pairs) are
counted inside their parent cluster, shown as indented rows with 0 additional. "Consolidate" =
definitions − survivor question-units. For adapter clusters, consolidation is a *count* collapse,
**not** deletions (rows 15–16). Every retired definition's home is named; the only retired
definitions without a confirmed home are the three in §5.

| # | Cluster | Definitions today → survivors | Consolidate | Lossless home for each retired definition |
|---|---|---:|---:|---|
| 1 | **Environment** | 8 → 1 | **7** | `resolveUniversalContext` (extended `resolveEnvironmentConfig`, `environment.ts:102`). Verified in clone: `resolveBrokerEnvironment` (`brokerEnvironment.ts:46`), `resolveBrokerEnvironmentDefault` (`:57`), `resolveBrokerEnvironmentFromSettings` (`:65`), `resolveSharedTradingEnvironment` (`:91`), `resolveEnvironmentFor` (`brokerConnect.ts:299`), `resolveRequestedEnv` (`brokerOrderCommands.ts:315`), `resolveETradeBaseUrl` (`environment.ts:73`, becomes an internal helper). Alias `resolveTradeEnvironmentFromSettings` excluded (not a definition). The reads-vs-trades default asymmetry (#3382) is preserved as **two Universal fields** (read-environment vs trade-environment), not two resolvers. |
| 1a | *Sub: `resolveSharedTradingEnvironment` / `resolveBrokerEnvironmentFromSettings`* | 2 → 1 (inside #1) | 0 add'l | Both read setting `etrade:environment`, fall back TEST → the one read-environment field. Verified near-identical pair: stored-read prefix identical; fallback differs deliberately per the #3382 comment (Broker → `resolveBrokerEnvironmentDefault(workerEnv)`; Shared → `void workerEnv; return "TEST"`). |
| 2 | **Tenant** | 9 → 1 question (0 separate defs — a field) | **8** | One tenant question: `UniversalEnvContext.tenant` / `ExecutionContext.tenantId`, canonical implementation `resolveIaaaTenant` (157 mentions). Verified 9: `resolveIaaaTenant`, `resolveTickTenant`, `resolveSubmissionTenant`, `resolveDeliveryTenant` (class), `resolveEffectiveTenantId`, `resolveCurrentTenant`, `resolveBackfillTenant`, `resolveAgentScheduleTenant`, `resolveAccountTenantId`. |
| 2a | *Sub: `resolveSubmissionTenant` / `resolveDeliveryTenant`* | 2 → 1 (inside #2) | 0 add'l | Both are the same "commercial adapter → `resolveTickTenant`" logic → the one tenant question (via `resolveTickTenant`). Verified near-identical pair: submission adds a TTL cache and silent catch; delivery adds audit-on-failure. |
| 3 | **Broker/provider selection** | 13 → 1 question (0 separate defs — fields) | **12** | `UniversalEnvContext.broker` / `.providers` fields. Verified 13: `tenantProviders.ts` 7 (`resolveTenantProviders`, `resolveEffectiveTenantProviders`, `resolveTenantBroker`, `resolveTenantBrokerSelection`, `resolveTenantDataProviderSelection`, `resolveScreenProviderForRun`, `resolveManualScreenProviders`) + `resolveTenantProviderContext` + `resolveChannelBroker` + `resolveNoSelectionBroker` + `resolveBrokerSelection` + `resolveTradingPlatform` + `resolveRunBrokerContext`. **Correction:** the task's "(~12 → 6)" conflates the cluster with the B-group after-count — those 6 are *different* questions (tenant credentials, tenant logins, provider binding, recipient binding, schedule-channel state, publisher channel), all store/state lookups outside this cluster. |
| 4+5 | **`resolveSwitch<T>` + `resolveOne<T>`** (one mechanism) | 10 → 1 internal | **9** | The one internal generic switch inside the universal resolver. Verified: `resolveSwitch` ×5 (`agenticPaymentsModes:182`, `etradeModes:165`, `goalChainModes:165`, `marketDataModes:262`, `quoteModes:217`); `resolveOne` ×5 in `otelModes.ts` (`:914`, `:997`, `:1058`, `:1159`, `:1222`, byte-identical, same md5, 18 lines each). Counted jointly because they are the same mechanism — 5+5→1 is 9, not 4+4=8. Correction: only 4 of the 5 `resolveSwitch` copies are generic `<T extends string>`; `agenticPaymentsModes:182` is non-generic (Payments-specific, no `valid` param) and differs in signature and legacy-message suffix — same logic, not byte-identical, so it needs adaptation, not deletion-as-identical. |
| 6 | **Bool primitive** (`resolveBool` ×3 + `resolveBoolean` ×1) | 4 → 1 internal | **3** | Internal bool parsing inside the universal resolver (0 separate). Verified ×3 at `autopilotVerdictTrend:50`, `judgeScoreFeedback:62`, `memoryConsolidation:83` (byte-identical, 7 lines, same md5); `resolveBoolean` at `stockCopilotLearningPolicy:76` is the same semantic question. |
| 7 | **Int primitive** (`resolvePositiveInt` ×3 + `resolveInt` ×1 + `resolveMinutesKnob` ×6 + `resolveDays` ×2) | 12 → 1 internal | **11** | One internal int-parsing primitive. Verified: `resolvePositiveInt` ×3 (byte-identical, 6 lines), `resolveInt` (`judgeScoreFeedback:55`, confirmed by read), `resolveMinutesKnob` ×6 (`analyzeJobs:352`, `deliverJobs:461`, `enrichJobs:316`, `feedJobs:263`, `generateJobs:322`, `pipelineChains:169` — byte-identical, 11 lines), `resolveDays` ×2 (`doSqliteJobOutcomeAdapter:55`, `inMemoryJobOutcomeAdapter:27` — byte-identical, 4 lines). |
| 8 | **Caller / operator** (`resolveCaller` ×3 + `resolveOperator` ×3) | 6 → 1 survivor | **5** ⚠️ | Surviving `resolveCaller` (one canonical copy; the target doc does not name which — open choice). ⚠️ **Body-read caveat:** the 3 `resolveOperator` copies are *merely same-named, not copies* — `dataLifecycle.ts:327` is a store-operator-access wrapper, and channels/tenants share only a login-header pattern with different contexts, error codes, and bodies. The 3 `resolveCaller` copies are 2 near-identical + 1 divergent (serviceUser adds a service-token guard and session-authoritative lookup). **If operator is a distinct role-checked question, this row becomes 6 → 2, consolidate 4, and the central after-count becomes 107.** J-side caller variants (`resolveWiredCaller`, `resolveDelegationCaller`, `resolveOperatorCaller`, `resolveNavCaller`, `resolveAdmin`, `resolveAdsViewer`) are **not** in this cluster; they fold into G's caller from the J long tail. |
| 9 | **Ports** (`resolvePorts` ×2) | 2 → 1 survivor | **1** ⚠️ | Surviving `resolvePorts` (one canonical copy; both current copies are file-local route helpers — which one is canonical is an open choice). ⚠️ **Body-read caveat:** the 2 copies are *merely same-named* — different return shapes (accounts returns `PlatformAccountPorts` with 8 adapters; users returns `{commercial, subscriptions}` with ctx overrides). If they are two different questions, consolidate 0 and the central after-count rises by 1. |
| 10 | **`resolveRunDetailMessage`** ×2 | 2 → 1 | **1** | One J run-detail-message question (`outcomeAspects.ts:163` / `runDetails.ts:72`, byte-identical, 3 lines); canonical copy not named in the target doc — open choice. |
| 11 | **`resolveScheduleUpdate`** ×2 | 2 → 1 | **1** | The unified one, `unifiedScheduleManagement.ts:2512`; the deprecated copy (`scheduleManagement.deprecated.ts:113`) folds into it. Verified near-identical; unified is the newer, longer copy (106 vs 83 lines) — same opening, plus #5100 identity/binding-tuple stripping, #4235 `subDailyOptIn`, and `isValidCron`/`isSubDailyCron` validation. The deprecated copy is a stale subset. |
| 12 | **`resolveScreenerNdGate`** | 4 → 1 field | **3** ⚠️ | One Universal screener-ND-gate field. ⚠️ **Correction to the survey's "4 variants":** the four lines are **four distinct function names, not copies of one name** — `resolveScreenerNdGate` (`:191`), `...FromEnv` (`:202`), `...Resolved` (`:217`), `...ForHost` (`:249`), layered wrappers (FromEnv calls :191; ForHost calls Resolved), different signatures. The fold stands as 3 definitions into one field; the "variants" wording was imprecise. |
| 13 | **Pipeline `*OrThrow` wrappers** | 6 → 0 | **6** | The 6 underlying E resolvers (`resolveFeed/Enrich/Analyze/Generate/DeliverJob`, `resolvePipelineChain` — themselves folding into the one job-by-id catalogue resolver); throwing becomes a call-site option. Verified in `meshDoors.ts` (`:534`–`:1210`): same pattern, 6 distinct wrappers, differing only in wrapped fn + error code/message. |
| 14 | **`resolveStrategyProfile`** | 2 → 1 | **1** | One J strategy-profile question. Verified: standalone `nlqOptionsStrategy.ts:737` + class method `unifiedOptionsService.ts:794`. Near-identical purpose, different shape (NLQ fn takes `(deps, profileName)`, requires `userLogin`; method takes `(req)`, accepts `profileId` or `profileName` via `this.profileStore`). Canonical copy (standalone vs class) not named in the target doc — open choice. |
| 15 | **`resolveId`** (interface + 2 adapter impls) | 3 → 1 question | **2 (count only; 0 deletions)** | **Adapters are NOT copies to delete.** One question (run-id resolution) carried by the `runRegistryPorts.ts:139` interface + 2 retained implementations (SQLite `doSqliteRunRegistryAdapter.ts:160`, in-memory `inMemoryRunRegistryAdapter.ts:105`). Interface + both impls survive; the "2" is excess definitions over question-units only. |
| 16 | **`resolveSymbols`** (interface + 2 adapter impls) | 3 → 1 question | **2 (count only; 0 deletions)** | Same treatment: one question (one of I's 4 surviving symbol questions) carried by the `retrievalPorts.ts:107` interface + 2 retained implementations (`d1MarketGraphAdapter.ts:167`, `inMemoryMarketGraphAdapter.ts:72`). 0 deletions. (Follows `domain-attribution.md` §3.11; the target doc's "fold" wording for these adapters means 0 extra *count*, not deletion.) |
| | **Cluster totals** | **86 definitions** | **72** | 14 survivor question-units (86 − 72). Rows 15–16 contribute 4 of the 72 as count-collapse only, with 0 deletions. |

### Reconciliation — cluster sum vs copies total

- Copies total (headline, §2): **281** (range 267–302).
- Named clusters (§3): **86 definitions in clusters, 72 consolidated**.
- **Residual: 281 − 72 = 209 copies not in any named cluster.**

Composition of the 209 (approximate; group figures carry the surveys' `~`):
- J long tail ≈ 83 (secrets 8→1–2, host-dispatch 6→1–3, delivery/recipient/email families,
  copilot/strategy/trading derivations, reports/ledger/provenance, OTel catalog, selected-run pair, etc.)
- D ≈ 24 (account-binding family 9 copies + actor-identity family 11 + DID 2 + remainder; no named
  D cluster except via the tenant pair, which is a class method)
- E ≈ 22 (job-by-id family 7, schedule-list/sections families, stage family, dispatch/run-id family
  — after removing the 6 `*OrThrow` + 1 schedule-update already clustered)
- I ≈ 16 (universe family 9, scope/leg-flow families — after removing the 2 `resolveSymbols` count-collapse)
- B ≈ 12 (logins pair, copilot-channel pair, channel-state pair, recipient-binding pair,
  prompt-broker-tools — after the tenant/broker/environment clusters)
- A ≈ 9 (RestSwitch overload collapses, `*FromEnv` variants, copilot duplicates — the 64 distinct
  fields are *not* copies)
- C ≈ 6 (tier family 6, price pair, provenance triple — after NdGate + environment clusters)
- Class methods ≈ 9 (`resolveApiKey`, `resolveWatchlistSymbols`, `resolveTokenIdentity`,
  `resolveMany`, `resolveEngineClient`, `resolveUnderlyings`, `resolveAccount`,
  `resolveDefaultAccountNumber`, `resolveChargePricing`)
- Types/interfaces ≈ 9 (8 folding types + `resolveStage` interface; the 2 adapter interfaces
  are in §3 rows 15–16)
- G / H / F: 0 residual (all of G and H are inside named clusters; F has no copies)
- Itemized subtotal ≈ 190; **unallocated remainder ≈ 19** (shared-cluster allocation across groups
  + the §2 cross-group double-count of ~9.5 + rounding on the `~` group distincts).

Why the residual is large is expected, not a gap in the analysis: the named clusters are only the
§2 headline overlaps. Most copies live in the long tail — per-family duplicates inside D, E, I and J
that the surveys name by family (account binding, actor identity, universe, tier, secrets, host
dispatch) but do not list as individual "top overlap" clusters. **Lossless check on the residual:**
every residual family names its surviving question in the target doc §2.4 (D 4, E 11, I 4, J 61
survivors); the only retired definitions *without* a confirmed home are the three in §5.

## 4. Reconciliation of the ±1s

### U-vs-C: U is counted ONCE — retired total is 481, not 482

- **U is a kind-C definition today.** The resolver survey lists `resolveEnvironmentConfig`
  (`src/config/environment.ts:102`) as a row in its §3-C list, verified in the clone. The target doc
  §2.2 says it *becomes* the universal resolver (`resolveUniversalContext`), "counted explicitly: 1",
  and §2.3 lists U today as 1.
- **C's 8 survivors do not include it.** Target §2.4 enumerates C's 8 as: (1) tier-for-user,
  (2) price, (3–5) policy-by-port (3 questions), (6–7) job-catalogue parameters (2),
  (8) provenance (1) — 1+1+3+2+1 = 8. None is `resolveEnvironmentConfig`/`resolveUniversalContext`.
  §2.2 separately absorbs `resolveETradeBaseUrl` and the broker-environment family as internal
  helpers/fields of the universal resolver (0 separate). The per-domain doc confirms the same split
  in D1: REMAIN = U 1 + C 8 = 9, as distinct items.
- **The trap in the target doc's §2.3 Today column, explained:** adding it literally —
  U 1 + A–J 557 + class 17 + types 12 — gives **587**, not the printed total **586**. That is
  because U's Today=1 duplicates one of C's 114 rows (the same definition shown twice, once as U
  and once inside C). The doc's own check line confirms the correct reading: A–J = 557, +17+9+3
  = 586 — U is **not** added there. So the "586" total already treats U as contained in C.
  The After column has no such overlap (U-after and C-after are disjoint sets), so 106 is clean.
- **Consequence:** the 482 figure would require the true survivor total to be 105, i.e. one of C's
  8 survivors being U itself. It is not. **Retired total = 587 − 106 = 481.** (The target doc's §0
  "≈480 retire" is stale for the same reason the "586" is stale.)

### High: 126, not 127, on the evidence as named

- Target doc group ranges (stated in the doc, re-added): U 1 (fixed), A 0, B 6 (5–8), C 8 (6–10),
  D 4 (3–5), E 11 (9–13), F 4 (3–4), G 2 (2–3), H 0, I 4 (3–5), J 61 (51–71), class +4 (3–5),
  types +1 (1–2). Central: 1+0+6+8+4+11+4+2+0+4+61+4+1 = **106** ✓.
  Low: 1+0+5+6+3+9+3+2+0+3+51+3+1 = **87** ✓.
  High: 1+0+8+10+5+13+4+3+0+5+71+5+2 = **127** ✓ (arithmetic).
- **But the per-domain highs re-add to 126:** D1 11 + D2 3 + D3 15 + D4 9 + D5 4 + D6 4 + D7 18 +
  D8 22 + D9 2 + D10 3 + D11 18 + D12 17 = 126. Per-domain low re-adds to 87 and central to 106,
  both reconciling exactly.
- **Where the 1 lives:** the class-method group is the only gap. Target §2.3/§2.5 gives it a range
  of **3–5**, but §2.5 names exactly **4** survivors: `resolveId`, `resolveUncached`,
  `resolveCalibratedPrompt`, `resolveRoute`. The 5th high-end survivor has no named row anywhere in
  the docs. The per-domain split allocates all 4 named survivors (`resolveRoute` → D4,
  `resolveCalibratedPrompt` → D10, `resolveId` → D11, `resolveUncached` → D12) and carries no
  unnamed +1. Cross-check of the other high-end components shows no other gap (D1 11 = U 1 + C 10;
  D3 15 = D 5 + J-secrets 2 + J-identity 8; D8 22 = E-rest 9 + J-job/stage 10 + J-host-dispatch 3;
  D9 2 = types high 2).
- **So:** 127 is correct only if a 5th class-method survivor exists and is named; on the current
  named evidence the honest high is **126**. Central (106) and low (87) are unaffected either way.

### Today-total cross-check: 557 + 18 + 9 + 3 = 587 — confirmed

- **587 re-adds** ✓. Standalone §3 rows counted programmatically: 557 bullets, per-kind counts
  matching the headings exactly (A 73, B 51, C 114, D 28, E 49, F 4, G 34, H 6, I 22, J 176).
- **§4 class-method rows counted programmatically: 18 bullet rows**, despite the heading saying
  "(17 implementations…)". The 18th row is `resolveRoute` (`registry.ts:189`), confirmed in the
  clone. The other 17: `resolveId` ×2, `resolveApiKey`, `resolveUncached`, `resolveDeliveryTenant`,
  `resolveWatchlistSymbols`, `resolveTokenIdentity`, `resolveMany`, `resolveEngineClient`,
  `resolveStrategyProfile`, `resolveUnderlyings`, `resolveAccount`, `resolveDefaultAccountNumber`,
  `resolveSymbols` ×2, `resolveChargePricing`, `resolveCalibratedPrompt`.
- **Types/interfaces:** 9 `*Resolver` type bullets + 1 line naming 3 interface declarations
  (`resolveId`, `resolveSymbols`, `resolveStage`) = 12 ✓.
- **Target §2.5 processes all 18:** survivors = 5 rows / 4 questions (`resolveId` ×2 adapters =
  1 question, `resolveUncached`, `resolveCalibratedPrompt`, `resolveRoute`); folded = 13 rows
  (`resolveDeliveryTenant`, `resolveWatchlistSymbols`, `resolveTokenIdentity`, `resolveMany`,
  `resolveEngineClient`, `resolveStrategyProfile` (class), `resolveUnderlyings`, `resolveAccount`,
  `resolveDefaultAccountNumber`, `resolveSymbols` ×2, `resolveChargePricing`, `resolveApiKey`).
  5 + 13 = **18** ✓ — every §4 row accounted for, none missing, none double-counted. (The
  `resolveSymbols` *interface* in the fold line is one of the 3 interface declarations, not a
  class-method row.) The target doc's §2.5 heading also says "(17)" — stale label, body covers 18.

## 5. What could NOT be verified / open sensitivities

- **Distinct-question count ≈306 (range 285–320) is an estimate, not a recount.** Group distincts
  sum naively to ~315.5; the −9.5 adjustment is cross-group double-counting (environment counted in
  B and C; tier in B/C; schedule in E/J; OTel in C/J; execution-context in D/J;
  `resolveETradeBaseUrl` in J vs the universal question). If the true distinct count is at the
  range ends, copies are 267–302. A body read of the ~40 ambiguous J entries would narrow it,
  not change the headline materially.
- **J is a range, not a point (51–71 survivors, central 61).** Trading-derivation granularity
  (`resolveThesis`/`resolveRiskProfile`/`resolveStrategyProfile` = 1 or 3 questions?), provenance
  genericity, and host-dispatch granularity (1 generic vs per-work-type, +4) move the after-count;
  this is the ±10 width in the 87–127 range.
- **Three no-home candidates** (target §3): `resolveStub` (`meshDoors.ts:413`), `resolveReaderHalt`
  (`scheduled-agent.ts:301`), `resolveCurrentList` (`server/routes/auth.ts:2999`) — each needs one
  body read to confirm it folds, survives (+1 each), or is scaffolding outside the count.
  `resolveBriefDate` is *not* one of them: it is a pure date formatter and drops as a classification
  correction, not a lost question.
- **Canonical-copy choices not named in the target doc:** which `resolveCaller`, which
  `resolvePorts`, which `resolveRunDetailMessage`, standalone-vs-class `resolveStrategyProfile`.
  Each is a ±0 count effect (the survivor count is fixed at 1 either way) but an open
  implementation choice. **Plus the two body-read caveats in §3 (rows 8–9):** if operator is a
  distinct role-checked question, central becomes 107; if the two `resolvePorts` are distinct
  questions, central rises by a further 1. Both are inside the 87–127 range; neither changes the
  headline.
- **Definition-level vs question-unit retirements:** the headline 106 counts question-units.
  Retained adapter/interface/factory definitions ride inside those units (`resolveId` 3 defs/1 unit,
  `resolveSymbols` 3/1, refund interface + 3 factories/1 unit), so *definitions actually deleted*
  are ~5–8 fewer than the 481 question-units folded. The exact definition-level number was not
  pinned because the target doc does not state which factories/adapters are retained vs deleted
  beyond the two adapter pairs.
- **Dead code not analyzed:** 134 of the 557 standalone resolvers are file-local; the survey did no
  dead-code analysis. Target §5 sensitivity only (not subtracted): if 10–20% of those are dead,
  the after-count could fall ~13–27 (to ~79–93). Do not subtract anything until that analysis exists.
- **DI-fallback boundary ±4–6** (survey §1): 3 `resolve*` DI bindings in `otelAlerting.ts` are
  counted while 4 same-shaped ones elsewhere are not; not re-adjudicated here.
- **Environment cluster floor:** the survey says "at least 4 places"; the verified family is
  8 definitions (+1 excluded alias). The #3382 reads-vs-trades asymmetry is preserved as two
  fields — verified only from the survey/target text and the `brokerEnvironment.ts` comments,
  not by re-reading the #3382 discussion.
- **Clone verification limits:** the remaining 17 class-method rows (beyond `resolveRoute` and
  `resolveEnvironmentConfig`) were counted in the survey's §4 list but not individually
  grep-verified in the clone; the 557 standalone bodies were verified only by programmatic bullet
  count per kind, not by re-reading bodies; `resolveOperator` (`dataLifecycle.ts:327`) exact end
  line was not established (brace-matcher misread a nested object literal; body read directly,
  logic confirmed different).
