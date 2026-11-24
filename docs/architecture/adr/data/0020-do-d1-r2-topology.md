# ADR 0020: DO vs D1 vs R2 — actor runtime, queryable projection, blob storage

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner (direction 2026-10-27), #CAIO-quns
- Issue: #1987
- Implementing PR: #1989 (main commit, when merged)
- Related: #1546 (D1 AgentDB, R1–R9 contract), #1976 (Drizzle repo-wide program — this ADR informs its design), #1951 (Think fleet migration — deepens the DO commitment), ADR 0002 (data foundation layer), ADR 0004 (agents on DO + Agents SDK), ADR 0005 (actor port)

## Context

A discussion chain on 2026-10-27 exposed a terminology tangle that needed writing down, because it already caused a real misunderstanding. The chain, in order:

1. "Are we using Drizzle now?" — Yes: `drizzle-orm ^0.45.4` is live on main, but confined to the D1 AgentDB projection layer (`src/data` adapters, `drizzleSchema.ts`, migration runner, migrations 0001–0006, serving the #1546 tables plus telemetry and retrieval tables). DO SQLite storage still uses the platform's own SQL directly, and the Postgres adapter was deferred, not built. Drizzle is the D1 adapter, not a repo-wide ORM.
2. "Drizzle has support for SQLite?" and "is there any difference between R1 and DO?" — The precise answers: Drizzle DOES support SQLite as a family — its D1 driver is SQLite under the hood, which is why the D1 adapters work. What it does NOT have is a first-class driver for Durable Object `ctx.storage.sql`. Same engine family, different product and access path: D1 is a standalone serverless database reached via a binding; DO SQLite is an embedded per-instance database reached via `ctx.storage.sql`. No Drizzle driver targets `ctx.storage.sql` out of the box, so "Drizzle supports SQLite" does not imply "Drizzle supports DO storage." That gap is #1976's open design question (custom driver/proxy vs raw SQL behind the port), not settled here. And R1 is not a store at all: R1 is the #1546 contract rule — port-first, domain code never imports a storage client or writes SQL, adapters only. DO is a Cloudflare platform primitive — a stateful object with embedded SQLite, alarms, and WebSocket that hosts an agent instance. R1 is a rule; DO is a runtime. The owner phrase "do R1/sqlite" (2026-10-26, when Postgres was deferred) meant: apply the R1 rule with SQLite as the adapter for now (D1 only, no Postgres yet) — rule plus engine choice in one phrase, not two names for one thing. A second shared letter adds to the tangle: contract-R2 is the #1546 dialect-isolation rule, while Cloudflare R2 is object storage (blobs). Neither R1 nor either R2 is a compute runtime.
3. "Do we need to use DO at all given we have R1 and R2 now?" — The question this ADR settles. Its premise bundles a rule (R1), another rule or a blob store (R2), and treats them as replacements for a runtime. They are not.

What a DO provides that D1 + R2 + plain Workers do not: single-writer serialization per entity (a DO instance is the one and only instance for its ID, so concurrent operations on the same agent's state do not race); in-memory state colocated with compute (an actor holds state across requests and runs code next to its data; Workers are stateless isolates, so every operation would be a round trip to D1 with nowhere to hold per-entity working state); alarms per entity (per-instance timers for scheduled turns, retries, timeouts — Workers have global cron triggers, not per-entity ones); WebSocket hibernation (holding many long-lived sockets — what the chat surfaces and Think's native WS chat run on); and the agent runtime itself (Agent and Think classes ARE DO classes; the Agents SDK, the actor port, and the turn runner all execute inside DOs).

What D1 and R2 cover is exactly the #1546 topology: D1 covers cross-actor queries, projections, audit, reports, and telemetry — everything that cannot be done when state is locked inside individual DO instances. R2 covers blobs: report PDFs, artifacts, large payloads. Neither covers coordination, scheduling, live sockets, or actor state machines.

## Decision

1. **DO is retained as the agent runtime and the authoritative per-actor store.** Agents (Agent/Think) remain DO classes. ADR 0004 stands; this ADR clarifies it, it does not supersede it.
2. **D1 is retained as the queryable projection and relational layer** — read projection, cross-actor queries, audit, reports, telemetry. It is NOT the per-actor authoritative store. Contract R9 ("D1 is not a DO-SQLite replacement") stands unless #1976's design explicitly revises it with owner approval.
3. **Cloudflare R2 is retained for blobs only** — report PDFs, artifacts, large payloads. Never for coordination, queries, or transactions.
4. **R1 (port-first) and contract-R2 (dialect isolation) govern ALL access.** Domain code never imports a storage client or writes SQL, regardless of which store sits behind the port.
5. **The topology is DO + D1 + R2, each for its job — not DO versus D1/R2.** The data foundation narrows DO's job (it stops being the only store and the query layer); it does not remove DO.
6. **Dropping DO is out of scope.** It would mean abandoning the agent runtime (Agents SDK/Think) and rebuilding coordination, scheduling, sockets, and state machines from scratch on Workers + D1 — a new program overturning ADR 0004, not a storage swap. The in-flight Think fleet program (#1951) deepens the DO commitment, since Think extends Agent extends DO.

## Consequences

- Developers must know which store a datum lives in and why: authoritative per-actor state → DO; queryable or cross-actor data → D1; blobs → R2. The written topology is now the reference that settles that question.
- The DO-SQLite Drizzle question stays open under #1976: this ADR records that DO stays; HOW Drizzle covers DO stores (if at all) is #1976's design decision, and it may not silently drop DO or move authority to D1.
- The D1 read path's completeness still depends on the #1546 seeds (halt seed, canonical reports seed), which have not run: `agent_reports` starts empty until the canonical seed lands. This ADR does not change that.
- The Think fleet program (#1951) proceeds on the DO runtime this ADR confirms; no fleet slice needs re-scoping on storage grounds.

## Alternatives considered

- **Workers + D1 + R2 only, no DO.** Rejected: loses single-writer serialization per entity, in-memory colocated state, per-entity alarms, WebSocket hibernation, and the Agents SDK/Think runtime itself; would require distributed locking that D1 does not provide, plus rebuilding the agent framework from scratch.
- **D1 as the single store (DO SQLite retired).** Rejected for now: contradicts R9 without a design, and DO SQLite's per-actor transactions + colocation have no D1 equivalent for actor state machines. Revisit only via #1976's design with owner approval.
- **R2 as a general store.** Rejected: object storage has no transactions, queries, or coordination. Blobs only.
- **Status quo without a written topology (no ADR).** Rejected: the terminology tangle (R1/R2/DO/SQLite) already caused a real misunderstanding in discussion; the topology needs to be written down where future readers find it, in the form the repo uses for hard-to-reverse decisions.
