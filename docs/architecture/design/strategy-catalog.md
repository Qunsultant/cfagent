# Strategy Catalog — Design

**Program:** #6593 — [Investment Program] Optimize Investment Research and Trading Capabilities
**Status:** Filed 2026-11-26. Plan approved in spirit by the owner, 2026-11-26.
**Decision (owner, 2026-11-26):** No DO — just D1 for system of record. D1 is the system of record for all durable application data; DO holds no system-of-record data, runtime state only.
**Companion docs:** Plan — `docs/plans/strategy-catalog-2026-11-26.md`. ADR — `docs/architecture/adr/data/0040-d1-system-of-record.md`. Survey — `docs/architecture/survey/6593-strategy-catalog-survey.md`.

## Problem

"Which strategies are active?" has four answers today: 4 sandbox ids (`sma_crossover`, `rsi_reversal`, `mean_reversion`, `breakout` — only 2 real rules, no RSI computed), a 6-member backtest enum whose emitted code is SMA for all 6, a 73-id client library, and 75 claimed in OODA. No strategy-definition table exists anywhere; definitions live in code. Usage by id is partial and split: the track record is keyed by the 10-name OODA vocabulary, outcome tracking has no strategy-id field, and there is no usage-count table. Four stores answer "which strategies are active", two backtests exist (one never invoked), three engines answer one NLQ screen, and at least two ranking systems exist.

## Principles (owner, 2026-11-26)

Reuse first, build platform-wide, no one-off solutions; reduce duplication to just one of everything — lossless/additive consolidation. Rank improvements by business value, technical effort, risk reduction, and user impact; map each optimization through reuse/enhancement/consolidation to the workflows, efficiencies, or outcomes it unlocks for end users. One engine, one scheduler, one ledger, one code base, one of everything.

## Target

One stock catalog, then one options catalog, then one pattern/study catalog on top (Thinkorswim, #6404 — a build, not a third strategy list). Canonical catalogs live server-side, versioned, in D1, served by one `CatalogService` (`get` / `list` / `resolve`). The client is a view: a cached, version-stamped read view; the Builder keeps only local modeling of legs being edited (the Discovery thin-client pattern, already working). One evaluator per kind, one ranker (`RecommendationKernel`), one screen engine (including channel NLQ — #6271 binds `stockScreenPort`), one backtest (walk-forward `screenBacktest`; the sandbox run is wired in as its invocation path, #5213, not a parallel backtest).

## Catalog model (D1)

Tables: `strategies` (id, kind stock|options, name, version, status, definition + params, gates, owner), `strategy_aliases` (every old id → exactly one canonical id, forever), `strategy_versions` (append-only), usage recorded per run (`strategy_id` + `strategy_version` + run ref on every screen, evaluation, backtest, and paper run). Seed from code definitions. Alias table first: nothing is deleted before the 73/74/75 counts are reconciled and recorded.

Status model: draft / active / disabled / deprecated / retired. A disabled entry is excluded from selection; existing runs keep their reference. Removal is soft-delete/deprecate only, with the alias retained, and blocked while usage-by-id shows the entry in use.

## Consumers, in migration order

Stock first: copilot loop → stock screener → opportunity-hunt (its thresholds move with it) → strategy evaluation/backtest → goal operations (follow via the operations they invoke) → calibration/outcomes. Only when every stock consumer reads the catalog and old sources are switched off do options start: OODA (vocabulary extended 10 → 74) → options screener → Discovery → recommendation kernel. Autopilot needs no migration (verified: policy verdict gate, no strategy content). Goal workflows hardcode nothing.

## Storage boundary — D1 is the system of record

D1 `AGENT_DB` (`agentdb`) is already bound in `wrangler.jsonc` (~130 `agent_*` tables in `drizzleSchema.ts`); no strategy table in D1 today. New Drizzle migration following the IV-history precedent (#2337: D1 adapter production when bound, env rollback lever, started empty with no backfill — the catalog differs by seeding from code, not starting empty). Port + D1 adapter following `d1IvHistoryAdapter.ts`, env rollback lever per store (`<STORE>_D1_ENABLED=false` back to the DO adapter).

**D1 is the system of record for all durable application data.** DO holds no system-of-record data: what stays in DO is runtime state only (chat store, hibernated sockets, alarms), which is transient by definition, never a record. Sessions/tokens/keys migrate last (D-I step 5). The weights/policy cluster stays out of the catalog tables by design only until the promotion unit is redesigned (ADR 0040): it references catalog ids by string; it is not absorbed. Tenancy: D1 is shared/global by design; per-login isolation by construction becomes tenant-scoped columns + query discipline on every moved table — catalog definitions are platform-wide, per-user selections stay tenant-scoped. Catalog ↔ weights consistency is eventual, not atomic (no cross-store transaction exists; ADR 0033).

## Lifecycle (Phase 4, UX at `?tab=strategy-catalog`)

Browse/search/compare → add (draft, with owner) → update (new version; old version retained and resolvable) → enable/disable (status flag) → remove (soft-delete/deprecate only, alias retained, blocked while in use) → clone → promote draft → active (human approval — recommend-only authority). Every change audited (who, when, version). One new page, `?tab=strategy-catalog`, tabs `view=stock` / `view=options`, in the Intelligence section of the left nav between Stock Hub (navOrder 5) and Options Screener (navOrder 6). Existing surfaces link to it rather than duplicating it. Everything is externalized, configurable, and manageable through UX/Chat with full lifecycle.

## Exposure

REST: `GET /api/catalog/strategies?kind=stock|options`, `GET /api/catalog/strategies/:id` (new); existing `GET /api/trading/options/catalog` and `POST /api/trading/options/strategies` become the canonical read/evaluate paths; `POST /stock-copilot/control`, `GET /stock-copilot/status`, `POST /stock-copilot/evaluate` stay, reading the catalog. MCP: `catalog.list`, `catalog.get`, `copilot.strategies.set`, plus existing `run_stock_screen`, `run_options_strategy_screen`, `nlq.execute` — all bound to the same engine. Design compliance: `docs/architecture/code/` — 01 boundaries, 02 data access, 05 security and tenancy, 06 client UX, 09 API standards, 10 MCP standards, 12 design principles (SOLID, GRASP, GoF, 15 factors), 14 cross-cutting aspects.

## Compliance summary

- **Reuse:** CatalogService, the `researchRules.ts` externalization pattern, the IV-history cutover pattern, the Discovery thin-client pattern, existing DO SQLite adapters as the migration source. Reuse order (gitops §7): reuse, enhance, optimize, consolidate, extend.
- **Tech stack (libraries first):** `docs/technology/tech-stack.md`; ADR 0034 D4 — best-fit FOSS first, custom code only where no best-fit FOSS piece exists, and an existing working repo capability always wins over both. No new scheduler, ledger, or catalog store — ScheduledAgent, runs ledger, and D1 `AGENT_DB` already exist.
- **Security:** IAAA; RBAC (default-deny, `docs/architecture/security/authz.md` §2). TBAC is a gap — no task-based access control model exists in the repo; to be defined in Phase 4 or restated as RBAC-only. Do not claim TBAC compliance until it exists.
- **One of everything:** one scheduler (ScheduledAgent), one ledger (runs ledger, `mas_async_jobs`), one engine, one catalog per kind, one store for durable data (D1). Acceptance test from the lifecycle doc: "what existing one thing does this invoke?"

## Open items (to be discussed as the plan is implemented)

TBAC gap; promotion-unit redesign (ADR 0040 open design problem); `mas_settings` G-7 block; backfill semantics per table; local-dev D1 setup; #3675 triage; human investment authority (TBD); subset pick for the 7 sweep candidates. None blocks starting P0. See plan §11b.
