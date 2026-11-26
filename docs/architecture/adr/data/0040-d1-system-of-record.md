# 0040. D1 as the system of record for durable application data

- Status: proposed
- Date: 2026-11-26
- Deciders: owner (Investment Program #6593), CIO-prot (RSI-CIO agent, `cio`)
- Issue: #6593
- Implementing PR: (to be linked when the catalog PR merges)

## Context

Verified live on `main`, 2026-11-26. Five facts force this decision:

1. **ADR 0022 D-G (ratified 2026-10-29)** states: "No execution state moves to D1 under this ADR." D-0 (a section inside ADR 0022; there is no separate "ADR D-0" document) ruled the strategy-state family DO-resident behind a port.
2. **ADR 0033 (cross-store consistency contract)** records the rejected alternative: "Making D1 authoritative for execution state. Rejected — ADR 0022 D-G ratified R9; DO stays authoritative for execution state." No cross-store transaction mechanism exists: a DO write plus a D1 write can never be atomic, and a nested call naming a different backend is refused with `TX_CANNOT_HONOUR`.
3. **The champion/challenger promotion unit is a DO `transactionSync` wrap.** The port header (`src/data/strategyWeightsPorts.ts`) states verbatim: "ADR D-0 ruled this family DO-resident behind a port (step-4 audit §3): the champion/challenger promotion unit is a DO transactionSync wrap over these tables, so residency is load-bearing — a D1 move would dissolve the unit." D1 `batch()` is atomic per batch but is not a synchronous closure over multiple port legs.
4. **The DO estate is larger than the catalogue.** 47 `doSqlite*Adapter.ts` files, 50+ adapter classes, 69 CREATE TABLEs in `src/data/schemaComponent/doCatalogue.ts` — but the catalogue undercounts: ~90 tables per the ADR 0022 survey, 186 in `docs/architecture/data/table-domains.md`, and ≥14 tables created inline by `src/orm/` (`mas_memory`, `mas_messages`, `mas_transactions`, `mas_trades`, …). There is no strategy-definition table anywhere; definitions live in code.
5. **The agent runtime is definitionally a Durable Object** (Agents SDK). `cf_ai_chat_agent_messages`, hibernated WebSockets, and per-instance alarms are runtime state, not migratable tables.

The owner direction (2026-11-26) is: no DO — just D1 for system of record. The strategy catalog program (#6593) needs one canonical id set with usage tracked by id, which per-login DO stores cannot provide: they are invisible to cross-agent queries and keyed by free-form strings with no foreign key to any definition.

## Decision

**D1 is the system of record for all durable application data. DO holds no system-of-record data.**

- Every durable application table/row moves to D1 (`AGENT_DB` / `agentdb`, already bound in `wrangler.jsonc`). D1 is authoritative; DO is retained as the agent runtime only.
- What stays in DO is runtime state only (chat store, hibernated sockets, alarms), which is transient by definition, never a record.
- Sessions/tokens/keys migrate last (D-I step 5), as the most availability-critical data.
- Tenancy: D1 is shared/global by design (#1546: "shared cross-agent query projection"). Per-login isolation by construction (D-0 property (f)) becomes tenant-scoped columns + query discipline on every moved table, verified by test, not by convention. Catalog definitions are platform-wide; per-user selections stay tenant-scoped.
- Rollback: per-store env lever, following the IV-history precedent (`IV_HISTORY_D1_ENABLED=false` back to the DO adapter, #2337).

This ADR supersedes ADR 0022 D-G and the rejected alternative recorded in ADR 0033. Per gitops §5, ADRs are never deleted or rewritten: on acceptance of this ADR, ADR 0022's Status is updated to superseded with a pointer to this ADR, and ADR 0033 is updated the same way for its rejected alternative. ADR 0022 itself is NOT edited by this filing.

## Consequences

- **The promotion unit must be redesigned — open design problem, not an assumed solution.** The `transactionSync` wrap over `mas_strategy_weights_v2` / versions / caps / gates / challenger tables has no D1 equivalent today. Candidate approaches: D1 `batch()` + versioned conditional writes, or a saga with idempotency. The redesign is designed in the implementing work, not claimed here. Until it lands, the weights/policy cluster references catalog ids by string and is not absorbed into the catalog tables.
- **Catalog ↔ weights consistency is eventual, not atomic.** ADR 0033's non-goal stands: no cross-store transaction mechanism exists. The design must tolerate it (versioned writes, idempotent replays, reconciliation reads).
- **Per-table migration, not big-bang.** Cutover per consumer with pin tests and replay verification (same inputs → same outputs); old sources retained as read-through until the last consumer migrates; abandoned DO tables deleted only after a retention window.
- **Scope undercount risk.** Any migration scoped to the DO catalogue alone misses ≥14 inline tables. The P5 estate audit covers the catalogue plus `src/orm/` inline tables.
- **`mas_settings` is independently blocked** (D-A.5 single-owner ruling G-7), separate from the residency question; the selection migration must address that ruling.
- **Migration semantics differ from the IV precedent.** The IV-history cutover started empty with no backfill; the catalog seeds from code definitions, and the strategy-state cluster needs a backfill decision per table.
- **Local-dev D1 setup** (wrangler d1 / miniflare) was not verified in this pass and must be confirmed during implementation.

## Alternatives considered

1. **Keep DO authoritative for execution state (status quo, ADR 0022 D-G).** Rejected by the owner: the catalog needs one canonical id set and cross-agent queryable usage, which per-login DO stores cannot provide.
2. **Literal "zero data in DO", including runtime state.** Rejected as unachievable: the agent runtime is a DO by definition; removing the chat store, hibernated sockets, and alarms would mean leaving DOs entirely, which is out of scope.
3. **Dual-write DO + D1 with DO remaining authoritative.** Rejected: it preserves the split authority the program exists to eliminate (four stores for "which strategies are active"), and ADR 0033 already records that dual-write atomicity cannot be guaranteed.
4. **D1 as a projection only (D-G's "intelligence substrate" reading).** Rejected for durable application data: a projection cannot be the system of record, and usage-by-id, lifecycle, and calibration all need an authoritative store.
