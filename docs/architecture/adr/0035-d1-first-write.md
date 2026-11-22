# 0035. D1-first writes: one store, one transaction, linked by foreign key

- Status: accepted
- Date: 2026-11-22
- Deciders: owner (Mubasher)
- Issue: #6101 (consolidation), #6100 (envelope), #4116 (CDO data foundation)
- Implementing PR: Qunsultant/cfagent#6140

## Context

The run-ledger/event family is written twice — the Durable Object first,
then a D1 copy via the projector — and the copy is maintained by machinery
(the shared projector, the twin mechanism, the three carriers, the sweep).
Attribution is per-path, never platform-wide: the canonical audit is fully
attributable, OTel logs carry tenant/actor by design, `mas_events` is
session-scoped only, metering is tenant-scoped. There are zero foreign keys
anywhere (verified 2026-11-22: zero `.references(` in `drizzleSchema.ts`,
zero `FOREIGN KEY` in the DO catalogues), so the same run's data is linked
by convention (`asyncJobId`, `runId`, payload JSON, `twinOf`), not enforced.
The Logged-in users panel shows no tenantIds, so users-per-tenant is not
derivable from it. The decisions below (owner, 2026-11-22) correct this.

## Decision

### D1-first (governing rule)

Write to D1 unless there is a named reason to use the DO. The record
belongs in one place; the DO keeps only what is genuinely per-instance
state.

### D1 is ACID

D1 is ACID — SQLite plus the ORM's transaction management. The write is
ONE D1 transaction, idempotent (retry-safe, keyed so a retry cannot
duplicate), returning success or failure. The cross-database atomicity
problem disappears with one store: there is only one transaction, so there
is nothing to diverge. The transactional outbox / reconciler is only needed
if a second store remains — it is not the design for one store.

### Reasons to write to the DO (the only valid ones)

1. The agent framework's own state — the agent IS a DO (Agent extends
   DurableObject); its `this.state`, its schedules, its workflow state live
   in the DO's SQLite by the framework's design, not ours to move.
2. Genuinely per-instance ephemeral state — state only one instance ever
   needs, never queried across instances, not a record (in-flight turn
   state, transient flags).
3. Latency on the hottest path, IF measured — the DO's SQLite is local to
   the running code, D1 is a call over HTTP; a performance claim to be
   proven with numbers, not asserted.

NOT reasons: atomicity (D1 is ACID, settled); the write cap (100k
rows/day on BOTH the DO and D1); history ("we always wrote there"); "the
agent runs there" (the agent can write to D1 from the DO — that is just a
call).

### AOP / 15-factor / ORM

The D1-first write passes through the aspect boundary — transaction
management via the ORM's transaction API, coded messages for named failures,
structured logging, error reporting, externalized config, security tenant
scoping plus audit. The write uses Drizzle ORM transactions (no raw SQL
transaction strings) and the migration is a numbered Drizzle migration. The
applicable 15-factor rows (application, data, security, observability) are
evidenced in their full-stack sub-issues, with FS-2 (AOP) as the enforcing
sub-issue. The D1-first writer is a port per ADR 0002 R1 (port-first) —
domain code never imports the ORM or writes SQL.

### 3rd normal form + Entity-Relationship model

The consolidated D1 tables store each identity once and link by foreign
key — a session row holds its user and tenant, a job row holds its session,
a run row holds its job — so platform, tenant, user, session, job and run
are derived by join, not stamped into every table: Platform → Tenant →
User → Session → Job → Run → Report/Event. Foreign keys are enforced in the
D1 schema. The #6100 envelope is stamped only where a join cannot exist
(the append-only audit store, OTel logs, the R2 archive) and is derived
from the ER model at the boundary — it is a projection, not a second source
of truth; if a stamped envelope disagrees with the joined model, the model
wins and the disagreement is a named failure.

### Platform-id and tenant-id on every record

Every user, session, activity and record carries platform-id and tenant-id
(owner, 2026-11-22). The #6100 envelope gains platform-id: platform,
tenant, user, session, action, correlation/trace id. The platform-id comes
from the platformIdentity service — the `platformId` in code today is the
broker provider id (e.g. a broker slug), NOT the platform identity. The
tenant-id is already required at the audit boundary (fails closed
`MISSING_TENANT`); the boundary must populate platform + tenant for every
recording path, not just audit. The Logged-in users API already returns
`tenantIds: string[]` per user; the panel must render them (#5159), so
users-per-tenant is readable.

### Alignment with CDO work

The ER model extends the CDO's `docs/architecture/data/data-model.md` §2
logical view — the one ER model; no second model is created. The store
inventory (`docs/architecture/data/store-inventory.md`) references
data-model.md and does not restate its entities. The #6101 design is shared
for CDO review before the build starts.

### Sequencing

Projector-first (owner, 2026-11-22): #6099 (job_run_records projector)
finishes, then #6100 (envelope), then #6101 (D1-first consolidation, which
retires the projector). Read from D1 only for the run-ledger (#6103).
Sessions move to D1 unless proven impossible (#6131, sub-issue of #6101).

### Platform-wide scope

This change is platform-wide (owner, 2026-11-22). The governing rule —
write to D1 unless there is a named reason for the DO — applies to every
family, not only the run-ledger/event family that #6101 consolidates first.
The ledger family is the first application because it is where the
duplication is proven (the projector, the twins, the missing copilot
cycles). The remaining families follow by family, same pattern, as
sub-issues of #6101: the marketplace/commercial DO tables (`mas_ads`,
`mas_promotions`, `mas_referrals`, `mas_transactions`); the memory/messages
DO tables (`mas_memory`, `mas_messages`); the watchlists/categories DO
tables (`mas_watchlists`, `mas_categories`); and the D1-native families
(billing/entitlements, tenants/memberships, proposals, market data,
pipeline datasets), which need the envelope and the foreign keys, not a
move — they are already D1. No family is left as a follow-up note.

## Alignment with the DO — no duplicate work

This ADR does NOT restate work that already exists, and it creates no
second copy of it:

- The DO tables are documented in data-model.md §3 (physical view) — this
  ADR references them, it does not re-list them.
- The projector / twin / carrier design is recorded in the ADR 0002
  addendum (#4116) — this ADR references it, it does not re-decide it.
- The envelope type is #6100's — this ADR records only the platform-id
  addition and the boundary rule.
- The #6101 consolidation RETIRES the projector for the tables it covers;
  it does not build a second projector, a second ledger, or a second
  model.
- What stays in the DO is named in the reasons list above (framework state,
  per-instance ephemeral state). The DO keeps no record that D1 holds.

## Relation to ADR 0033

ADR 0033 states the cross-store consistency contract: cross-store
atomicity is explicitly unclaimed, and the transaction aspect guarantees a
unit of work on exactly one backend. This ADR does not overturn that — it
removes the cross-store pair for the consolidated families, so there is no
dual-write left to discipline on those paths. ADR 0033 remains the
contract for any second store that remains with a named reason (its
idempotency, projection-lag, and read-your-writes rules still govern the
outbox / reconciler where one exists). Where D1-first replaces the copy,
0033's discipline is vacated by the removal, not by an exception.

## Consequences

- One write, one D1 transaction; the twin / sweep machinery retires where
  D1-first replaces it.
- The four read questions (per-tenant, per-user, per-session, per-action)
  become join queries, not payload scans; per-platform is the top-level
  scope.
- The runs view is complete in D1-only mode (copilot cycles included).
- Sessions move to D1 (#6131) unless the design proves with evidence why
  they cannot; the audit keys ride with the sessions.
- The store inventory and the ER model stay single-sourced under
  `docs/architecture/data/` (data-model.md is the model; the inventory
  references it).
