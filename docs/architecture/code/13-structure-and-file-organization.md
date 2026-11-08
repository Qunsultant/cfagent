# 13 — Structure and file organization

**Purpose.** Where code lives and how files are shaped: the canonical-home
table, the placement rule for new files, the ports-home ruling, the absolute
one-class-per-file rule, and file-size budgets.

**Canonical sources.** `component-taxonomy-01.md` (the pillar taxonomy, in
this directory), ADR 0022 (`02`), the decomposition programmes #992 / #995 /
#2943 / #2902 / #359 and their pins.

**The tree at `9925ead8`.** `src/` = 75 directories, 1,574 `.ts`/`.tsx`
files (1,609 files total), 49 top-level entries. 601 classes in 384 files;
79 files exceed 1,000 lines, 20 exceed 2,000.

## Canonical homes

| Directory | Canonical home for |
|---|---|
| `src/data/` (371 files) | Ports **and** their adapters (D1/Drizzle, DO-SQLite, in-memory), schemas, stores — the data layer behind ADR 0022; organized into domain subdirectories (`02`) |
| `src/services/` (244 files) | Domain/platform services, resolvers, job families, publish stage |
| `src/agents/` (+ `routes/`, 76 files) | Durable Object agents and their route modules (thin routers, `01` A5) |
| `src/server/` + `src/server.ts` | Worker entry + server route groups (auth/core/messaging/platform/privacy/queue/trading) |
| `src/mcps/` | MCP servers (`openaimp/`, `scanner/`, `public/`) + MCP client |
| `src/trading/` | Trading engines/providers — barrel-only access (`01` A4) |
| `src/workflows/` | Pipeline composers, stage ports, workflow flows (ADR 0027) |
| `src/security/` | IAAA, sessions, PDP seam, ExecutionContext, retention |
| `src/client/` | The React app (components, panels, hooks, client API modules) |
| `src/aspects/`, `src/outcomes/`, `src/observability/`, `src/errors/` | Cross-cutting machinery (`14`) — `src/errors/` now holds only `*.deprecated.*` files |
| `src/config/` | Mode/switch registries (`*Modes.ts` families) |
| `tests/` (repo root) | All tests (1,363 test files) — never inside `src/` |

## O1 — The pillar taxonomy classifies components for discussion

**Definition.** Components are classified by the 8+3 pillar taxonomy (Feed /
Gather / Analysis / Generate / Store / Serve / Deliver / Scheduling, plus
three cross-cutting pillars) for architecture discussion. The pillars are a
classification, not a directory map, and no document claims they are.
**Status.** DOCUMENTED — `component-taxonomy-01.md`.
**Conformance at `9925ead8`.** Descriptive standard; no measurement applies.

## O2 — New code goes in the canonical home for its kind

**Definition.** A new file is placed in the canonical home for its kind
(table above). Creating a new top-level directory, or placing a file in a
directory whose remit overlaps a canonical home, requires the placement to
be justified in the PR.
**Status.** DOCUMENTED — ratified here from the measured structure. At base
the practice had no document; the long tail of small top-level directories
whose remit overlaps the canonical homes (`src/api`, `src/gateway`,
`src/actors`, `src/events`, `src/features`, `src/models`, `src/shared`, …)
is the visible non-conformance.
**Conformance at `9925ead8`.** The canonical homes hold for the bulk of the
tree (data 371 / services 244 / routes 83 files in place). The overlapping
small directories are baseline rows, dispositioned on touch.

## O3 — The ports home: `src/data/` (ruling, 2026-11-08)

**Definition.** Ports live with their adapters in `src/data/`, organized
into domain subdirectories (`02`). `src/ports/` is **not** a port home: its
one file (`schemaMigration.ts`) is dispositioned into `src/data/`, and the
directory ceases to exist. No new file is ever placed in `src/ports/`.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — the survey found the practise
split (per-domain port files also exist beside domains, e.g.
`src/workflows/*Ports.ts`, `src/mcps/openaimp/mcpPermissionPorts.ts`) with
`src/ports/` as a vestigial one-file trap; the ruling resolves it as stated.
**Conformance at `9925ead8`.** Baseline: `src/ports/` = 1 file at base;
`src/data/` = 371 files. The move and the domain-subdirectory layout proceed
by slice and on touch.

## O4 — Routes live in the route directories

**Definition.** Routes live in `src/agents/routes/` or `src/server/routes/`.
No route logic lives in entry files. (The dispatch inventories that enforce
the shape are `01` A5.)
**Status.** DOCUMENTED as a placement statement; the inventories behind it
are ENFORCED (`01` A5).
**Conformance at `9925ead8`.** 76 files in `src/agents/routes/` + 7 in
`src/server/routes/` at base.

## O5 — Top-level `src/` stays flat-by-domain

**Definition.** Top-level `src/` is organized flat-by-domain. Loose single
files at the `src/` root are exceptional and must be legitimate entry or
type roots.
**Status.** DOCUMENTED — ratified here from practice.
**Conformance at `9925ead8`.** The survey records "5 loose files" at base
and then names nine — `judge-routing.ts`, `landing.ts`, `oauth.ts`,
`orchestrate.ts`, `pollingConfig.ts`, `schedule.ts`, `session.ts`,
`types.ts`, `server.ts` — several of which are legitimate entry/type roots.
The named list is the baseline; the count discrepancy is in the survey, not
resolved by this file.

## P1 — One class per file: absolute (ruling, 2026-11-08)

**Definition.** A file contains at most one class declaration. **There is no
exemption** — not for registries, not for adapter families, not for MCP
command files. Multi-class files are baseline violations to be restructured
into per-class files, grouped in per-domain directories where a family
exists (the MCP application is in `10` K3; the domain-breakdown principle is
in the README).
**Status.** ADOPTED-PENDING-IMPLEMENTATION — no rule existed at base; the
survey's proposed exemption form was considered and **rejected** by the
ruling.
**Conformance at `9925ead8`.** Baseline: 310 of 384 class-bearing files
conform (80.7%); **74 files violate**, shrink-only, restructured by slice or
cleared on touch. Worst offenders: `src/mcps/openaimp/meshDoorCommands.ts`
(28 classes), `src/mcps/openaimp/commands.ts` (18),
`src/services/recommendationKernel.ts` (16),
`src/mcps/openaimp/marketDataCommands.ts` (12),
`src/mcps/openaimp/cloudflareAgentCommands.ts` (9),
`src/data/inMemoryOrmAdapters.ts` (8), `src/data/doSqliteOrmAdapters.ts` (7).

## P2 — A file under active decomposition carries a shrink-only byte budget

**Definition.** A file under active decomposition carries a byte budget that
only shrinks, pinned by a test. Budgets are per file, set by the programme
doing the decomposition.
**Status.** ENFORCED where pinned. Precedents: `tests/etrade_routes_resplit_995.test.ts`
(every split module < 50,000 B; dispatcher allowance 52,000 B);
`tests/etrade_broker_portfolio_risk_split_2943.test.ts` (broker file + new
module < 50,000 B each); the #359 ratchet on `etradeOptions.ts` (50,000 B
ceiling).
**Conformance at `9925ead8`.** The 4 pinned decomposition budgets are all
green at base; `etradeOptions.ts` stands at 49,952 B against its 50,000 B
ceiling (48 B headroom, per the #3186 review).

## P3 — The orchestrator class stays within its pinned budget and inventory

**Definition.** The orchestrator class stays within its line budget
(`BUDGET_LINES = 3310`) and its class-body method inventory, both pinned.
**Status.** ENFORCED — `tests/orchestrator_class_inventory.test.ts` (#992
standing gate).
**Conformance at `9925ead8`.** Pin green at base.

## P4 — Every oversized file carries a budget (no universal ceiling)

**Definition.** There is no universal line ceiling. Instead, every file over
1,000 lines carries a per-file budget on the P2 pattern (shrink-only),
assigned by census. An oversized file with no budget is a violation; a
budgeted file may grow only within its budget. Under touch conformance, an
oversized file conforms by **budget assignment**, not by being split inside
an unrelated change.
**Status.** ADOPTED-PENDING-IMPLEMENTATION — no general file-size standard
existed at base.
**Conformance at `9925ead8`.** Baseline: 79 files exceed 1,000 lines and 20
exceed 2,000, none budgeted except the P2/P3 files. Largest:
`src/agents/routes/agenticPayments.ts` 5,615 lines,
`src/services/scheduledTasks.ts` 5,212,
`src/client/options/StrategyDiscoveryPanel.tsx` 3,779,
`src/trading/etrade/client.ts` 3,587, `src/services/marketDataResearch.ts`
3,406, `src/server/routes/auth.ts` 3,344. (`src/server.ts`, the former
~188 KB monolith, is 304 lines / 18 KB at base — decomposed under #2902.)

## P5 — Oversized files are decomposed by programme, not grown

**Definition.** An oversized file is decomposed by a programme — extraction
into helper or route modules behind inventories — not grown by accretion.
Adding substantial new surface to an oversized file without a decomposition
plan (or a P4 budget) is a violation.
**Status.** DOCUMENTED — the established pattern of #992 (orchestrator),
#995/#2943 (E*TRADE routes), #2902 (`server.ts`), #359 (options routes),
recorded in programme records; this file states it as a standing standard.
**Conformance at `9925ead8`.** Per the P2/P3 pins and the P4 baseline.
