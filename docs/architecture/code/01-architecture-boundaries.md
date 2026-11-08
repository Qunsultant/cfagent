# 01 — Architecture boundaries

**Purpose.** The boundary rules: what may depend on what, where shared things
live, and which structural shapes are not permitted. These are the standards
most cheaply kept by construction and most expensively repaired after drift.

**Canonical sources.** ADR 0002 (port-first), ADR 0020 (storage topology),
ADR 0022 (data foundation), ADR 0027 (stage-runner), ADR 0003 (messaging),
repo AGENTS.md and gitops §7 (boundaries, reuse), `docs/compliance/anti-drift.md`
(framework — cited, not restated), `docs/compliance/multiple-implementations.md`
(the catalog of parallel implementations).

## A1 — Domain code depends only on port interfaces

**Definition.** Domain code imports port interfaces only. A violation is any
of: a store-client import in domain code, an `env.AGENT_DB` reference outside
the composition root, or SQL in domain code. The composition root wires
environment → adapter → ports; nothing else reads the environment to build a
store.
**Status.** ENFORCED — structural tests per ADR 0002; the SQL half by
`tests/global_dd_census_2356.test.ts`.
**Conformance at `9925ead8`.** The structural tests and the census are green
at base; the census baseline is carried in `02` (B1).

## A2 — Every cross-cutting capability is port-first, two adapters, one suite

**Definition.** A new cross-cutting capability ships as: one port interface,
at least two adapters (the production adapter and an in-memory adapter), and
one conformance suite that runs unchanged against both adapters. A capability
missing any of the three is not done. The pattern is established across ADR
0003 (messaging), 0005 (actors), 0006 (flags), 0007 (retrieval), 0008
(breakers), 0010 (LLM gateway), 0011 (observability), 0012 (MCP permissions).
**Status.** DOCUMENTED — conformance suites exist per port, but no meta-pin
enforces "a new port ships two adapters + a suite"; review enforces it. The
same gap is stated for data ports as B5 in `02`.
**Conformance at `9925ead8`.** Not mechanically measured; the eight ADR
families above are the conforming precedent.

## A3 — Storage topology

**Definition.** Durable Objects are the authoritative per-actor store and the
agent runtime. D1 is the queryable projection and relational layer, never the
per-actor store. R2 holds blobs only — never coordination, queries, or
transactions. A change that makes D1 authoritative for actor state, or uses
R2 for coordination, violates this standard.
**Status.** DOCUMENTED — ADR 0020, Decision items 1–5.
**Conformance at `9925ead8`.** Not mechanically measured; enforced by review
against ADR 0020.

## A4 — Trading internals are reachable only through the barrel

**Definition.** Code outside `src/trading/` imports trading functionality
only from `src/trading/index.ts`. Any deep import into `src/trading/**` from
outside the tree is a violation.
**Status.** ENFORCED — `tests/trading-boundary.test.ts`.
**Conformance at `9925ead8`.** Pin green at base.

## A5 — Routes stay thin; dispatch is an ordered, inventoried dispatcher

**Definition.** The orchestrator's `routeRequest` is an ordered dispatcher
that delegates to `src/agents/routes/*.ts`. Route handlers contain no inline
path-matched handler blocks and no business logic; they delegate. The Worker
entry dispatch is likewise inventoried: every route branch, in dispatch
order, with its method and auth guards. Adding, removing, or reordering a
route updates the inventory in the same PR.
**Status.** ENFORCED — `tests/thin_router_inventory.test.ts` (24 delegation
calls, exact order) and `tests/server_route_inventory_2902.test.ts` (every
route branch, dispatch order, auth guards).
**Conformance at `9925ead8`.** Both inventories green at base. Dispatch order
is also a security property; `09` J1 states the required order.

## A6 — Shared schema/DDL has exactly one source file

**Definition.** Every shared schema or DDL statement has exactly one source
file (`src/data/ormSchema.ts` for the shared schema). Every initialization
path consumes that source. A second copy of the same DDL anywhere is a
violation, even if the copies currently agree.
**Status.** ENFORCED — `tests/schema_single_source.test.ts`.
**Conformance at `9925ead8`.** Pin green at base.

## A7 — Reuse before you build

**Definition.** Before building, choose in this order: reuse → enhance →
optimize → consolidate → extend. A parallel implementation of an existing
capability requires explicit justification in the PR and in the completion
report. Duplicates found on contact are consolidated in the same change, or a
follow-up issue is filed in the same PR. "Reviewer-enforced: sent back, not
merged" is the enforcement today.
**Status.** DOCUMENTED — gitops §7, "Reuse before you build" items 1–6.
**Conformance at `9925ead8`.** Not mechanically measurable; discharged
through PR review and the completion report.

## A8 — Consult the multiple-implementations catalog before building

**Definition.** Before building, check `docs/compliance/multiple-implementations.md`.
Do not add another parallel engine, ranker, weight system, promotion
pipeline, or report generator beside one the catalog already lists.
**Status.** DOCUMENTED — gitops §7 "No drift" item 4.
**Conformance at `9925ead8`.** Not mechanically measurable.

## A9 — One stage-runner contract for every screen invocation mode

**Definition.** Every screen invocation mode (sync, async, workflow) runs
one plan with one checkpoint discipline. Drivers may differ; decisions never
do. Fan-out caps are named constants, never silent truncations.
**Status.** DOCUMENTED — ADR 0027, Decision items 1–2. The ADR's own status
is **Proposed**, not Accepted; this standard inherits that status honestly —
it is the stated direction, not yet a ratified decision.
**Conformance at `9925ead8`.** Not mechanically measured.

## A10 — Messaging crosses ports as CloudEvents v1.0 envelopes

**Definition.** Messages cross messaging ports as CloudEvents v1.0 envelopes
(`specversion` / `id` / `source` / `type` / `time` / `data` plus named
lowercase extensions). Port interfaces contain no Queue binding types, no
provider options, and no provider error shapes.
**Status.** DOCUMENTED — ADR 0003, Decision M1.
**Conformance at `9925ead8`.** Not mechanically measured.
