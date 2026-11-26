# Strategy Catalog — Plan

**Program:** Investment Program #6593 — Optimize Investment Research and Trading Capabilities
**Scope:** One stock strategy/pattern catalog, then one options catalog, with all screening/evaluation consumers migrated; all durable application data moved out of Durable Objects into D1 (zero data in DO).
**Status:** Approved in spirit 2026-11-26; D1 is the system of record (owner decision). Filed 2026-11-26.
**Date:** 2026-11-26

## Where this plan lives (per owner direction, verified against repo conventions)

| Artifact | Location | Status in repo today |
|---|---|---|
| Design | `docs/architecture/design/strategy-catalog.md` | `design/` exists, nearly empty (1 file: `assessment-02.md`) |
| Plan | `docs/plans/strategy-catalog-2026-11-26.md` | `docs/plans/` exists, ~50 entries; do not confuse with `docs/architecture/plan/plan-01.md` |
| Architecture changes | `docs/architecture/adr/` — new ADR(s) superseding ADR 0022 D-G and ADR 0033's rejected alternative | `adr/` exists (28 top-level + `data/` 11 files); ADR 0022 lives at `adr/data/0022-data-foundation.md` |
| Survey / research | `docs/architecture/survey/6593-strategy-catalog-survey.md` | `survey/` exists (~90 files, naming `<issue>-<topic>-survey.md`) |
| Work tracking | Sub-issues of #6593, one per phase (gitops §5: each phase is a sub-issue with scope, acceptance, rollout) | #6593 has 30 sub-issues as of 2026-11-26 |

## 0. The decision this plan needs first

"Zero data in DO" conflicts with three recorded decisions, verified live 2026-11-26. The owner decided 2026-11-26: no DO — just D1 for system of record. This section records the conflicts the decision resolves, and the new ADR 0040 records the decision:

1. **ADR 0022 D-G (ratified 2026-10-29):** "No execution state moves to D1 under this ADR." A zero-DO direction directly contradicts this ratified gate.
2. **ADR 0033 (cross-store consistency contract):** "Making D1 authoritative for execution state. Rejected — ADR 0022 D-G ratified R9; DO stays authoritative for execution state." No cross-store transaction mechanism exists; a DO write + D1 write can never be atomic (`TX_CANNOT_HONOUR`).
3. **Champion/challenger promotion unit** (port header `src/data/strategyWeightsPorts.ts`, verbatim): "ADR D-0 ruled this family DO-resident behind a port: the champion/challenger promotion unit is a DO `transactionSync` wrap over these tables, so residency is load-bearing — a D1 move would dissolve the unit." D1 `batch()` is atomic per batch but is not a synchronous closure over multiple port legs.

And a scope correction: the agent runtime **is** a Durable Object by definition (Agents SDK). `cf_ai_chat_agent_messages`, hibernated WebSockets, and per-instance alarms are runtime state, not migratable tables. Literal "zero data in DO" is unachievable unless the agent runtime itself leaves DOs, which is out of scope. The decided definition:

> **Zero durable application data in DO — D1 is the system of record.** Every DO SQLite table/row moves to D1, and D1 becomes the system of record for all durable application data. DO holds no system-of-record data: what stays in DO is runtime state only (chat store, hibernated sockets, alarms), which is transient by definition, never a record. Sessions/tokens/keys migrate last (D-I step 5). This framing is the decision: authority moves to D1; DO is the execution runtime, not a record — which is also how the ADR 0022 D-G conflict is resolved (see §0 decision below).

A new ADR supersedes 0022 D-G (and 0033's rejected alternative) and records: the new authority story (D1 authoritative for durable application data; DO retained as agent runtime only), the replacement for the promotion unit (D1 batch + versioned conditional writes / saga with idempotency — to be designed in the ADR, not assumed), and the tenancy story (see §7).

## 1. What exists today (survey summary — full detail in the survey doc)

- **Stock, server:** 4 sandbox ids, 2 real rules (`sma_crossover` SMA 5/20; one shared dip rule behind `rsi_reversal`/`mean_reversion`/`breakout`, no RSI computed). 6-member backtest enum whose emitted code is SMA for all 6, with hardcoded metric fallbacks (Sharpe 1.42, win rate 62.5%) that must NOT migrate. Real technicals in `technicals.ts` (RSI₁₄, MACD, ATR, Bollinger, VWAP, HV, fractals, Fib, regime, death cross, ORB, gap) unwired into any strategy. Screener labels, `screenScore`, 6-vote composite, factor grades (3 distinct "momentum" formulas). `baseBreakout.ts` (20-bar base + ladder plan).
- **Options, server:** 74 definitions in `catalog.ts` (11 categories), engine/profile/choice/risk, acceptance rules, PMCC gates, 11 discovery signals (signals, not strategies). Research side maps only 10 structures (vocabulary #6507); 64/74 have no OODA name.
- **Client:** `STRATEGY_LIBRARY`, 73 ids; 45 overlap with server, 29 server-only, 28 client-only (mostly directional renames). Exact duplicates on the server: `short_put` ≡ `cash_secured_put`; `long_call` vs `leaps_call` (DTE parameter only). Count 73 vs 74 vs 75 unresolved — no 75th server definition exists.
- **Hardcoded, to externalize:** opportunity-hunt thresholds (`opportunityHuntLevels.ts`: entry band 0.5%, stop/take 5%/10% sma, 3%/3% others); OODA `buildStructure` 10 cases (duplicate catalog templates) and `structuresForOutlook` mapping; copilot defaults/selection; screener/scoring weights; technicals parameters (functions stay, params move). Goal workflows hardcode nothing (strategy comes from the operation invoked). Autopilot hardcodes nothing (policy verdict gate). OODA research rules already externalized (`researchRules.ts`, 21 keys, versioned) — the precedent to copy. `docs/PATTERNS.md` does not exist; Thinkorswim patterns/studies/drawings exist nowhere — #6404 is a build, not a consolidation.
- **Exposure divergence:** 4 stores for "which strategies are active"; 2 backtests (walk-forward live, sandbox never invoked); 3 engines for one NLQ screen (chat → engine, channel → listings branch, manual → panel); ≥2 ranking systems.
- **Storage:** D1 `AGENT_DB` (`agentdb`) bound in `wrangler.jsonc`; ~130 `agent_*` tables in `drizzleSchema.ts`; **no strategy table in D1**. No strategy-definition table anywhere. DO estate: 47 adapter files, 50+ classes, 69 CREATE TABLEs in the catalogue — but the catalogue undercounts: ~90 tables per ADR 0022 survey, 186 in `table-domains.md`; ≥14 tables created inline by `src/orm/` (`mas_memory`, `mas_messages`, `mas_transactions`, `mas_trades`, …). Usage by id today: track record keyed by 10-name OODA vocabulary; outcome tracking has no strategy-id field; no usage-count table; no FK to a canonical id.
- **Cutover precedent:** IV history #2337 — D1 adapter is production when `AGENT_DB` is bound, env rollback lever (`IV_HISTORY_D1_ENABLED=false`), started empty with no backfill.

## 2. Phases (each a sub-issue of #6593)

| Phase | Work | Consumers migrated | Exit criterion |
|---|---|---|---|
| P0 | Stock catalog in D1: tables (`strategies`, `strategy_aliases`, `strategy_versions`, usage per run), Drizzle migration (0020 precedent), port + D1 adapter, CatalogService, alias table for all old ids, seed from code definitions. New ADR superseding 0022 D-G + 0033. Promotion-unit redesign. | — | Catalog reads return the seeded stock entries; old ids resolve via aliases; ADR accepted |
| P1 | Migrate stock consumers, one at a time with pin tests + replay verification | Copilot loop → stock screener → opportunity-hunt (thresholds move with it) → strategy evaluation/backtest → goal operations (follow via operations) → calibration/outcomes (record `strategy_id` + version on every run) | Every stock consumer reads the catalog; old sources switched off; same inputs → same outputs on replay |
| P2 | Options catalog in D1, same pattern | OODA (vocabulary extended 10 → 74) → options screener → Discovery → recommendation kernel | Same as P1 for options |
| P3 | Patterns/studies catalog (Thinkorswim, #6404) on top of the two catalogs | Opportunity-hunt patterns, screener pattern views | No third strategy list |
| P4 | Lifecycle UX (see §5) | — | Add/update/enable/disable/remove/clone/promote all work through `?tab=strategy-catalog`, audited |
| P5 | Remaining DO estate → D1 (all durable application tables), sessions last (D-I step 5) | All remaining DO stores | Zero durable application tables in DO; runtime state only |

Autopilot needs no migration (verified: no strategy content). Stock first, options only after P1 exit criteria are met.

## 3. Benefits delivered

- One answer to "which strategies are active?" (today: four — 4 sandbox ids, 6 enum members, 73 client, 75 claimed).
- One evaluator per kind, one ranker (`RecommendationKernel`), one screen engine (including channel NLQ), one backtest.
- Every run, screen, evaluation, backtest, and paper trade records `strategy_id` + `strategy_version` — calibration per strategy becomes honest; enable/disable becomes safe.
- Client stops carrying a hard-coded catalog that must be kept in sync by hand; it becomes a cached, version-stamped view.
- D1 becomes the single durable store: one backup, one query surface, one audit trail; DO keeps only what it must (runtime).

## 4. Risks eliminated

- False labels: `rsi_reversal` computing no RSI; `breakout` being a dip-buy; backtest text claiming volume/MACD/Bollinger rules the emitted code does not implement; hardcoded "results" (Sharpe 1.42) presented when a backtest returns null.
- Silent drops: unknown strategy ids silently dropped by `parseStrategiesInput`; channel NLQ silently taking the listings branch instead of the screen engine.
- Count drift: 73 vs 74 vs 75 unresolved; client/server copies drifting (only documented cross-port: `jelly_roll` backfilled from client).
- Duplicate logic: 3 ids sharing one rule; `short_put` ≡ `cash_secured_put`; 3 momentum formulas under one name; 4 scoring systems with no shared scale.
- Split authority: 4 config stores, 2 backtests (one dead), 2+ ranking systems, weights that live ranking never reads at decision time.
- DO residency risks: per-instance data invisible to cross-agent queries; tenancy by construction hiding a missing tenant key; abandoned DO tables (`mas_iv_history`) left behind after cutover.

## 5. User journey — lifecycle (Phase 4, UX at `?tab=strategy-catalog`)

Browse/search/compare either catalog → open an entry (rule/params, gates, theses, evidence, version history, usage counts, calibration) → **add** (draft, with owner) → **update** (new version; old version retained and resolvable) → **enable/disable** (status flag; disabled excluded from selection, existing runs keep their reference) → **remove** (soft-delete/deprecate only, alias retained, blocked while usage-by-id shows it in use) → **clone** → **promote** draft → active (human approval — recommend-only authority; a human approves before anything executes). Status model: draft / active / disabled / deprecated / retired. Every change audited (who, when, version). Before/after journey-impact statement per issue, per gitops template.

## 6. Resources optimized

- One catalog service, one evaluator per kind, one ranking path, one screen engine, one backtest — instead of 5 stock vocabularies, 3 options name systems, 4 config stores, 2 backtests.
- DO estate shrinks by audit (D-0's own rule): ~90 tables + ≥14 inline tables → D1; DO instances stop carrying per-login data they cannot share.
- Client bundle drops a 62 KB hard-coded library; Discovery's thin-client pattern (server ranks, local engine only models legs being edited) becomes the single client pattern.
- OODA's already-externalized `researchRules.ts` is reused as the config pattern instead of re-inventing it.

## 7. Compliance with architecture

- **Reuse (owner principle; "just one of everything"):** reuse first — CatalogService, `researchRules.ts` pattern, IV-history cutover pattern, Discovery thin-client pattern, existing DO SQLite adapters as the migration source. No one-off solutions; lossless/additive consolidation (alias table, versioned updates, retained superseded entries).
- **ADD.md:** design recorded as portable principles (ports/adapters, one security model, one implementation per rule); ADD.md itself links, duplicates nothing.
- **AOP:** Exception Handling, Coded Messages, Logging, Externalized Configuration, Security, Transaction Management. Transaction Management is the load-bearing aspect here: the promotion unit's `transactionSync` must be re-established in D1 (batch + versioned conditional writes / saga) — the ADR's core design problem. Externalized Configuration: all thresholds/params leave code for the catalog.
- **15-factor (IBM):** API first (catalog REST/MCP), config/credentials/code separated (env + D1, no hardcoded thresholds), backing services (D1 as the backing service), environment parity (same catalog in dev/prod via migrations), disposability/stateless processes (DO keeps no durable state), telemetry (usage by id), authn/authz (IAAA, see §8).
- **Multi-tenant (M-4):** no silent narrowing. D1 `agentdb` is shared/global by design; per-login isolation by construction (D-0 property (f)) becomes tenant-scoped columns + query discipline on every moved table. Catalog itself is platform-wide (shared definitions); per-user selections/profiles stay tenant-scoped. Any narrowing is a stated, reviewed decision on the M-4 line.

## 8. Compliance with the security model (IAAA)

Single home: `docs/architecture/security/`. Catalog writes go through the same PDP/authz path as other mutations (roles, bootstrap/genesis per `authz.md`); promotion draft → active requires human approval with identity recorded (derived stable identity, ADR 0001; one identity resolution path, ADR 0039). Tenancy isolation audited (`tenancy-isolation-audit-1761.md` pattern) for the D1 move — tenant key on every moved table, verified by test, not by convention. Secrets: none in the catalog (no credentials in definitions; env/secret handling unchanged). Audit: IAAA chain append covers lifecycle changes; `security.md` consolidation is still pending under #1450 (CISO lane) — the folder docs are the current record.

## 9. Operational anomalies discovered / resolved

Discovered in the 2026-11-26 inventories (all verified live on `main`): sandbox code-gen emitting SMA for all 6 types; hardcoded metric fallbacks; `rsi14` a feed passthrough in the screener while real bar RSI₁₄ exists elsewhere; `dayAction`/`sentiment` duplicate fields; weights v2 never read at decision time; deprecated policy-state shim still present; dead sandbox module never invoked; `researchStructure()` throwing for 64/74 ids; discovery signals' consumer unverified; `preferFibLevels` and `isStrategyAllowedUnderRegime` implemented but uncalled; DO catalogue undercounting the estate by ≥14 tables; abandoned `mas_iv_history` data left after cutover. Resolved by: the catalog (single definitions), alias table + reconciliation, replay pin tests per consumer, usage-by-id recording, and the P5 estate audit (catalogue + `src/orm/` inline tables).

## 10. Platform improvements (one of everything)

One stock catalog, one options catalog, one pattern/study catalog, one config source, one evaluator per kind, one ranker, one screen engine, one backtest, one store for durable data (D1), one lifecycle UX, one identity path, one security model. Every view (Builder, Discovery, Copilot panel, OODA, ticker, calibration) is a projection over the same entries — never a copy.

## 11. Risks and open questions

- Promotion atomicity redesign (the ADR's hardest problem); cross-store atomicity explicitly unclaimed (ADR 0033) — catalog ↔ weights consistency is eventual, not atomic.
- Tenancy: tenant key + query discipline must be designed and tested per table; a missed key leaks across logins.
- `mas_settings` independently blocked (D-A.5 single-owner ruling G-7) — selection migration needs that ruling addressed.
- Migration semantics: IV precedent started empty with no backfill; the catalog seeds from code (not empty) and the strategy-state cluster needs a backfill decision per table.
- ADR numbering: confirmed at filing — 0040 (highest listed in the ADR index was 0039).
- Local-dev D1 setup (wrangler d1 / miniflare) not verified in this pass.

## 11b. Open items — to be discussed as the plan is implemented (owner direction, 2026-11-26)

These are recorded, not decided; none blocks approval in spirit or starting P0. Each is discussed and decided at the phase that owns it:

- **TBAC gap (§17):** define task-based access control as part of P4, or restate the requirement as RBAC-only.
- **ADR number** for the ADR superseding 0022 D-G and 0033 (confirm against the ADR index at filing time).
- **Promotion-unit redesign:** the D1 replacement for the `transactionSync` wrap (batch + versioned conditional writes / saga) — designed in the ADR, not assumed here.
- **`mas_settings` G-7 block** and the backfill semantics per table (§11).
- **Local-dev D1 setup** (unverified).
- **#3675 triage:** whole epic (paper + human gate) vs S1/S2 only vs leave out.
- **Human investment authority:** still TBD, not named in the repo — do not invent.
- **Subset pick for the 7 sweep candidates** (analytics lake four, #5502, #5213, #6271) — user to pick; nothing moves before that.
- **Approval status:** plan approved in spirit by the owner, 2026-11-26; D1 as system of record decided (§0). Filing authorized by the owner 2026-11-26 ("file it on GitHub now"); design doc, plan, ADR 0040, survey, and six phase sub-issues filed under #6593.

## 12. Rollback

Per-store env lever, following `IV_HISTORY_D1_ENABLED` (`<STORE>_D1_ENABLED=false` back to the DO adapter). Cutover per consumer, not big-bang. Old sources retained as read-through until the last consumer migrates; abandoned DO tables are deleted only after a retention window, not at cutover.

---

# Part II — Operating framework (owner direction, 2026-11-26)

Applies to this plan and to all program work. Locations verified live 2026-11-26; corrections to assumed locations are stated, not smoothed over.

## 13. Ranking — how improvements are prioritized

Every candidate improvement is scored on four axes before it is scheduled: business value, technical effort, risk reduction, user impact. Ranking order: highest value-per-effort with the largest risk reduction first; user impact breaks ties. Each optimization is then mapped through reuse / enhancement / consolidation to the existing workflow, efficiency, or outcome it unlocks for end users — an optimization with no mapped workflow does not get scheduled. Applied to this plan: P0/P1 rank first (one catalog unblocks every consumer; eliminates the false-label and silent-drop risks); P2 next (same pattern, options side); P4 lifecycle UX ranks on user impact (it is the only phase whose value is direct user control); P5 ranks last on effort (largest estate, lowest per-table value) except for the strategy-state cluster, which rides with P0/P1 because the promotion unit forces the decision.

## 14. Architectural gap analysis (per phase)

- **P0/P1 — systemic bottleneck:** five stock vocabularies with no mapping table; the copilot evaluates a dip rule under three names while real RSI/MACD sit unwired. **Scalability:** per-login DO stores cannot be queried cross-agent; D1 is the shared projection. **Maintainability:** thresholds in code (`opportunityHuntLevels.ts`, screener weights) change only by deploy. **Maturity:** scoring is draft-only, calibration is report + dashboard, not a loop.
- **P2 — bottleneck:** 10/74 OODA vocabulary coverage; `researchStructure()` throws for the other 64. **Maturity:** options evaluation is the most mature path (engine + acceptance rules) and therefore the template for stock.
- **P4 — bottleneck:** no lifecycle surface at all; strategies can only change by code deploy. **Maturity:** moves strategy management from deploy-time to run-time.
- **P5 — bottleneck:** ~90 tables + ≥14 inline `src/orm/` tables, 94 direct `ctx.storage.sql` call sites in 16 files; D-D end state is "no call site holds SQL". **Scalability:** per-instance serialization does not scale to cross-agent queries; **maintainability:** schema evolution is scattered.

## 15. RCA — one per set of related changes

No central RCA rule or directory exists in the repo today (verified). The observed convention is per-incident files named `<topic>-rca-<issue>.md` in the owning domain's folder, filed against the incident issue (e.g. `docs/architecture/security/do-rows-read-rca-2280.md`). This plan establishes the program convention: **one RCA per set of related changes**, filed in `docs/architecture/survey/` as `6593-<set>-rca.md` and linked from the phase sub-issue. Planned RCAs: (a) false strategy labels (rsi_reversal/breakout/sandbox code-gen/hardcoded metrics); (b) silent drops and split engines (parseStrategiesInput, channel NLQ listings branch, dead sandbox); (c) count drift and catalog duplication (73/74/75, client/server copies); (d) DO residency and the promotion unit (ADR 0022 D-G, ADR 0033, TX_CANNOT_HONOUR). Each RCA records cause, impact, fix, and the regression test that prevents recurrence.

## 16. Measurable success criteria

Per enhancement, with a baseline measured before the phase starts:

| Enhancement | KPI | Adoption metric | Performance target |
|---|---|---|---|
| Stock catalog (P0/P1) | Catalog entries live / total stock entries; consumers reading the catalog (target: all stock consumers) | % of copilot cycles, screens, hunts, and evaluations resolved via catalog ids (target: 100%) | Catalog read p95 < 100 ms; zero silent id drops (target: 0) |
| Options catalog (P2) | OODA vocabulary coverage 10/74 → 74/74 | % of options evaluations via catalog ids (target: 100%) | Same as stock |
| Lifecycle UX (P4) | Strategies managed via UX vs code deploys (target: 100% of changes via UX) | Monthly active catalog managers; promotion approvals with human sign-off (target: 100%) | Draft → active promotion < 1 business day |
| DO → D1 (P5) | Durable application tables remaining in DO (target: 0) | % of reads served from D1 (target: 100% for migrated stores) | No regression in screen/evaluation latency vs DO baseline |
| Program-wide | Duplicate strategy definitions (target: 0); distinct "momentum" formulas (target: 1); scoring vocabularies (target: 1 canonical id set) | Sub-issues completed / total; calibration coverage per strategy (target: every active strategy has a track record) | Backtest replay parity: same inputs → same outputs (target: 100% of pinned cases) |

## 17. Compliance — tech stack, design, security

- **Tech stack (libraries first):** `docs/technology/tech-stack.md` is the one record; ADR 0034 D4 — best-fit FOSS first for every layer, custom code only where no best-fit FOSS piece exists with the gap documented, and an existing working repo capability always wins over both FOSS and custom code. Applied: no new logging library (OTel pipeline consolidated on the module logger seam, #5082/#5083); no new scheduler, ledger, or catalog store — ScheduledAgent, runs ledger, and D1 `AGENT_DB` already exist.
- **Design (components, services, API, MCP):** `docs/architecture/code/` — 01 boundaries, 02 data access, 05 security and tenancy, 06 client UX, 09 API standards, 10 MCP standards, 12 design principles (SOLID, GRASP, GoF, 15 factors), 14 cross-cutting aspects. `standards.md` itself lives at `docs/architecture/standards/standards.md`, not at the repo root. CatalogService follows the port/adapter pattern (ADR 0022); catalog API/MCP follow code/09 and code/10.
- **Security (IAAA, RBAC — TBAC is a gap):** RBAC verified in `docs/architecture/security/authz.md` §2 — role-based, default-deny, "the role table is the whole model". **TBAC was not found anywhere in the repo** (0 matches in `authz.md` and `security-workflow.md`) — there is no task-based access control model today. The plan records this as a gap: either TBAC is defined as part of P4 (lifecycle approvals by task/role) or the requirement is restated as RBAC-only. Do not claim TBAC compliance until it exists.
- **One of everything (verified):** one scheduler — ScheduledAgent (`src/agents/scheduled-agent.ts`); one ledger — the runs ledger (`mas_async_jobs`, §6 of the lifecycle doc); one engine, one catalog per kind, one store for durable data (D1). The lifecycle doc's acceptance test applies: "what existing one thing does this invoke?" — a second implementation fails the bar regardless of whether it works.

## 18. Executive roadmap (short / medium / long term)

- **Short term (to program target 2026-11-30):** P0 design + ADR + stock catalog in D1; P1 first consumer (copilot loop) migrated with pin tests; RCAs (a) and (b) filed. Decision needed: zero-DO working definition (§0).
- **Medium term:** P1 complete (all stock consumers), P2 options catalog, P4 lifecycle UX live; KPIs in §16 reported per phase; DO strategy-state cluster migrated with the redesigned promotion unit.
- **Long term:** P3 patterns/studies, P5 remaining DO estate to zero durable application tables; catalog as the platform's single strategy substrate for every future workflow.

## 19. Platform entries

- **Correction:** the investment platform is **already listed** in `docs/agentic-org/platforms.md` (CIO — Investment and portfolio platform: Investment Policy Statement, portfolio construction, asset allocation, factor/scenario analysis, performance attribution; governance rows name the CIO as owner/approver). No new entry is needed — the plan updates the existing entry to name the unified strategy catalog as its strategy substrate, rather than adding a duplicate platform.
- **Platform plan:** the investment platform's plan entry goes in `docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md` (130 KB target-architecture doc, governing tracker #3842, record #3844), whose §1 principle is "one of everything, full reuse". The entry records the catalog, the one scheduler, and the one runs ledger as the platform's shared substrate.

## 20. Operating rules carried forward

- Reuse order (gitops §7): reuse, enhance, optimize, consolidate, extend — reuse is mandatory, rework needs justification; consult `docs/compliance/multiple-implementations.md` before building. Issue template requires `## Reuse class`, `## Dependencies`, `## Conformance`, and a before/after journey-impact statement; the Policy Gate enforces a `Reuse class:` line in the PR body.
- No hard-coding: the rule lives in AOP (Externalized Configuration aspect) and `docs/architecture/code/03-errors-logging-config.md`.
- Every implementation change has a GitHub issue; every change to `main` arrives through a PR; one issue-scoped branch and one focused PR per issue; TDD for behavior changes; post-merge CI verification before Done.
- Failing PRs are fixed through the browser (preferably GitHub.dev or GitHub.com) when possible/applicable.
- Standards are complied with and improved where necessary: where this plan finds a gap (TBAC missing, RCA convention missing, ADR numbering non-contiguous), the plan names the gap and the fix instead of working around it silently.
