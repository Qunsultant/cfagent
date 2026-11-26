# ADR 0033: Cross-store consistency contract — DO + D1 dual-write discipline and read-your-writes rules

- Status: Accepted (user build directive 2026-11-16: priority queue — #4935 third after #4937/#4387; the 2026-11-12 "no build for now" hold applied only to the J-stack programme items and does not apply here)
- Date: 2026-11-16
- Deciders: #clo-arsi (implementation); #CAIO-quns (filer, #4935)
- Issue: #4935
- Implementing PR: Qunsultant/cfagent#4966
- Extends: ADR 0022 (D-C transaction aspect, D-F2 publication, D-G R9 restatement), ADR 0020 (DO/D1/R2 topology), ADR 0002 (R9)
- Related: #2288 (transaction aspect), #1760 (distinct race), #4930 (D1 retry/timeout policy — adjacent, not duplicated), #4933 (query observability — adjacent), #1976 (closed), #4116 (run-ledger projection), #1651/#1676/#1688 (chain/schedule, shard-job, audit-report projections), #1742 (telemetry)

## Context

Cross-store atomicity is explicitly unclaimed: the transaction aspect
(ADR 0022 D-C, `src/aspects/transactionAspect.ts`, #2288) guarantees a
unit of work on exactly one backend — a DO write plus a D1 projection
write can never be atomic, and a nested call naming a different backend
is refused with `TX_CANNOT_HONOUR` rather than silently split. The
design instead relies on idempotency and projection discipline — but
until this ADR, no written contract stated the rules callers must
follow: idempotency requirements, projection-lag tolerance, which reads
are authoritative (DO) vs projection (D1), dual-write ordering, and
read-your-writes behaviour. No audit verified that the existing
dual-write/projection paths follow any such rules. A read immediately
after a write could observe stale projection state, with no stated rule
for which reads must be fresh — freshness was accidental per call site.

This ADR states the rules, records the first audit of every existing
dual-write/projection path against them (Appendix A), and names the
conformance pins that enforce the pin-able rules
(`tests/cross_store_consistency_pin_4935.test.ts`, in the `test:pins`
suite). Caller fixes for violations the audit found are follow-up
sub-issues under #4935, filed at identification time — never left as
notes, TODOs, or "future work" lines.

## Decision

### R-1 — Idempotency: a projection write is a no-op under redelivery

Every projection write is idempotent under at-least-once delivery **and
under concurrent redelivery** — sequential replay is not the bar.
The mechanism must be atomic at the statement level
(`ON CONFLICT DO NOTHING` / `ON CONFLICT DO UPDATE` with a stale
guard), or a read-before-write guard whose losing race is **reported**,
never silent. A projection that drops a concurrent write while
reporting success is a lost update, not idempotency.

Natural keys (the grain each projection deduplicates on):

| Projection | Natural key | Mechanism on main (audited) |
|---|---|---|
| Audit events | `<tenantId>:<eventId>` | `ON CONFLICT DO NOTHING` (`d1AuditReportAdapter.ts`) |
| Canonical reports | `(tenantId, reportId, version)` | Read-before-write (latest version + `updatedAtMs` LWW) + `ON CONFLICT DO NOTHING` — see F-3: the version bump itself is not yet atomic |
| Async jobs | `jobId` + `updatedAt` stale guard | Atomic `ON CONFLICT DO UPDATE … WHERE updatedAt < bound` (`d1RunLedgerAdapter.ts`) — the pattern R-1 holds up as correct |
| Chain / schedule rows | `(tenantId, id)` + status | Replay of an already-projected status is a no-op (`chainScheduleProjection.ts`) |
| Shard jobs | `(tenantId, chainId, jobKey)` + status | Replay of an already-projected status is a no-op (`shardJobProjection.ts`); #2989 workflowRunId fill is new information, not a replay |
| Telemetry realizations | `(tenantId, outcomeId)` | SELECT-then-INSERT, no `ON CONFLICT` — see F-2: concurrent redelivery throws instead of no-op'ing |
| Canonical seed | `(tenantId, reportId)` | Latest-row check; a present report is counted, never rewritten |

**R-1c — Audit-event ids are derived from the occurrence.** An audit
row's idempotency depends on the caller passing a stable event id for
a retry of the same occurrence. A helper that mints a fresh id per
call (`recordAuditEventBestEffort` mints
`<eventKind>:<subjectType>:<subjectId>:<nowMs>:<counter>`) must never
be the retry path for an occurrence — a retried occurrence through
it writes a duplicate row, not a no-op. No live violation was found
(F-10): the current callers are single-shot per occurrence (replays
skip before the audit write; reconcile writes its own per-pass
event). The rule is recorded so the next retry path does not assume
the helper is safe to retry through.

### R-2 — Projection-lag tolerance is stated per carrier

There are exactly three lag classes. Every projection path declares
which class it is; no read may assume a lag class its path does not
provide.

| Class | Meaning | Paths |
|---|---|---|
| Synchronous | The projection lands before the write call returns. | ORM carrier (`postRunLedgerBestEffort`, awaited in the write path); chain/schedule `projectAfterTransition` (awaited after the DO save); shard-job `projectLegOutcomes` at run completion |
| Asynchronous | The projection lands when the consumer processes the message; retry, then DLQ — no silent loss. | Queue carrier (`runLedger.project` claim-check → `projectQueuedRunLedger`, which throws on failure so the queue core retries) |
| Operator | Unbounded lag until an operator deliberately invokes it. | Sweep / reconcile (`reconcileRunLedgerProjection`, `reconcileShardJobs`, `reconcileChainSchedules`, telemetry reconcile import) |

A projection that has not landed is **missing**, not evidence that the
row does not exist. A consumer that treats absence as a finding is
wrong by this contract (ADR 0022 D-F2.3, adopted here as the general
consumer discipline).

### R-3 — Authoritative vs projection reads

The DO is authoritative for execution state (ADR 0022 D-G, ratified
R9); D1 is the projection / read model. D1-native substrate families
(trace, proposal ledger, fleet registry — D-F) are D1-authoritative
and are not projections; this contract does not govern their reads.

- A read that must reflect a just-completed write reads the
  authoritative store.
- A D1 projection read is a cross-instance / analytical read and
  tolerates its path's lag class (R-2).
- The runs + reports surfaces read D1 only (issue #6103): there is
  no per-tenant mode and no mode rides the response — one mode,
  always D1. A read that follows a write in the same user journey
  sees the row only once the write path's carrier has landed it
  (R-5).
- A surface names the families it cannot serve (scans, discovery,
  screener feed, stage transitions are not projected — the list
  surface names each in `storeErrors`, never a silent empty list).
  Job outcomes ARE served, from the facts folded onto D1
  `job_run_records` (#6103 Q1) — not a projection of the DO list.

### R-4 — Tenancy: a projection row carries the owning tenant

A projection row carries the owning tenant; the deployment default
is never a tenant. `workspaceId` mirrors `tenantId` by the projection
convention. A record with no owner cannot be projected until its
owner is known — a row filed under a default tenant is a tenancy
violation, not a placeholder (see F-5). Tenant-scoped reads filter
by the row's owner exactly as the DO read filters by user login.

### R-5 — Read-your-writes

A read that follows a write in the same user journey reads the
authoritative store — **unless** the write path's projection carrier
is synchronous (R-2), in which case the projection has landed before
the write returns and a projection read sees it.

Consequence: **the D1-only read path requires a carrier for every
tenant.** There is no per-tenant mode anymore (#6103) — every tenant
reads D1-only — so a tenant with queue-only (or sweep-only, or no)
carriers reads stale or missing rows after a write; the run-detail
lookup 404s with no "not yet projected" signal (see F-1). Until the
F-1 fix lands, D1-only reads + a non-synchronous carrier combination
is a known violation of this rule, recorded in Appendix A with its
follow-up; it is not a grandfathered configuration. The list surfaces
name the gap when no carrier is configured for the tenant
(`storeErrors.runs`, #6103 Q4) so the missing rows are visible, not
silent.

### R-6 — Publication honesty: a failed projection is recorded, never dropped

A failed projection or publication is recorded with a stable catalog
code at the point of failure — never dropped silently (ADR 0022
D-F2.3). Best-effort means the caller's path continues, not that the
failure is invisible. A lost projection write is a gap in the
evidence base, and the gap must be discoverable where it happened —
not only later, as a missing row or a missing event id (see F-4).

### R-7 — Dual-write ordering: DO first, then projection; reconcile is the backstop

1. **DO first, then projection — never the reverse.** The projection
   carries what landed: the hook re-reads the stored row (a deduped
   store may return a pre-existing row); it never projects an
   in-memory guess.
2. **A projection failure never fails the DO write, the submission,
   or the run.** The hook catches, logs by name, and returns; the
   sweep / reconcile carrier is the backstop for a row whose
   carriers all missed it.
3. **The queue carrier is the one exception to rule 2, by design:**
   `projectQueuedRunLedger` throws when the row exists but the
   projection cannot land — the throw IS the retry signal (the
   queue core turns it into retry, then DLQ). That is the carrier's
   no-silent-loss landing, not a violation of this rule.
4. **Reconcile is a deliberate operator / maintenance invocation
   only** — never boot, deploy, or tick logic. A reconcile pass
   reports exactly what changed (checked / reconciled /
   already-current / errors); a tenant whose carrier is not
   configured gets a named refusal, never a silent zero-row pass
   that looks like a clean bill of health.
5. **The canonical report fan-out (row↔R2-body pair) follows the
   #2347 contract**, cited here, not re-decided: the R2 put
   precedes the row insert, and a row never claims a body it does
   not have. The index legs (Vectorize, AI Search) ride the same
   publish stage; their per-target outcomes are returned in a
   declared vocabulary.

### Decided non-goal — any cross-store atomicity mechanism

No cross-store atomicity mechanism is built, bought, or claimed by
this ADR. Grounds:

- ADR 0022 D-C: a unit of work spans exactly one backend. D1's
  request-per-statement API and DO's per-instance storage admit no
  distributed transaction between them; the transaction aspect
  refuses a cross-store unit with `TX_CANNOT_HONOUR` rather than
  silently splitting it.
- What replaces atomicity is the combination this ADR states:
  idempotency (R-1) + declared lag classes (R-2) + authoritative /
  projection read discipline (R-3, R-5) + publication honesty (R-6)
  + DO-first ordering with a reconcile backstop (R-7).
- Any future atomicity mechanism needs a new ADR that supersedes
  this section; it is not a follow-up slice of #4935.

## Consequences

- The contract is the rulebook the #4935 audit applied; Appendix A
  is the frozen record of that audit (2026-11-16, fresh main
  `1a07d119`). Future audits append dated entries to the ledger;
  they never rewrite it.
- Five violations found by the audit have follow-up sub-issues under
  #4935, filed at identification time: #4961 (F-1, carrier-mandatory
  gate — D1-only reads require a carrier for every tenant; the
  per-tenant mode it gated is gone, #6103),
  #4962 (F-2, telemetry `ON CONFLICT`), #4963 (F-3, report version
  bump), #4964 (F-4, audit-publication logging), #4965 (F-5,
  chain/schedule tenant). Each fix removes the #4935 pin's exception
  for its finding in the same PR (gitops §7).
- The pin suite (`tests/cross_store_consistency_pin_4935.test.ts`)
  enforces the pin-able rules: the dual-write call-site census, the
  DO-first ordering, the never-throw discipline, the reconcile
  operator-only rule, and the idempotency mechanism — with the
  F-2/F-3/F-4/F-5 exceptions allowlisted by finding number until
  their fixes land. Rules that are not pin-able are recorded in the
  "Not pin-able" section below with grounds, not silently skipped.
- Adjacent work this contract does not do: #4930 (D1 retry/timeout
  policy — retrying a dual-write is safe only once R-1 holds, which
  is why #4935 precedes #4930 in the queue); #4933 (query
  observability — the diagnostics the lag classes need).

## Not pin-able (recorded with grounds)

- **Projection-lag tolerance per carrier (R-2).** A runtime /
  operational property, not statically checkable from source. The
  lag classes are stated in the contract; observing them needs the
  query observability of #4933.
- **The carrier-mandatory gate (R-5 / F-1).** Enforcement is the #4961 fix
  (a runtime validation in the carrier-config write); no static scan can prove a tenant's stored config
  combination is valid.
- **Stable-eventId discipline (R-1c / F-10).** The event id is
  constructed at the call site; no scanner can tell whether two
  calls name the same occurrence. Caller discipline, reviewed at
  the call site.

## Alternatives considered

- **A cross-store transaction mechanism.** Rejected — not claimable
  (see the decided non-goal above); the aspect's refusal is the
  honest behaviour.
- **Making D1 authoritative for execution state.** Rejected — ADR
  0022 D-G ratified R9; DO stays authoritative for execution state.
  D1 hosts projections, read models, and the D1-native substrate
  families.
- **Synchronous projection everywhere.** Rejected — the queue
  carrier exists because the write path cannot wait on D1
  availability, and the sweep exists because some rows miss every
  live carrier. The three lag classes are the honest statement of
  what the system does; pretending one class exists would reintroduce
  the accidental freshness this contract removes.

## Appendix A — Audit ledger, 2026-11-16 (frozen)

Auditor: #clo-arsi. Base: fresh main `1a07d119`
(2026-11-16T17:05:18Z). Every path below was read on that base;
file:line references are to it.

### A.1 Population (measured)

Named D1 projection modules (`src/data`): `auditReportProjection.ts`
(316 lines), `chainScheduleProjection.ts` (282),
`runLedgerProjection.ts` (159), `shardJobProjection.ts` (298).
Run-ledger services: `projectionCarriers.ts` (55),
`runLedgerProjectionHooks.ts` (249), `runLedgerProjectionPosting.ts`
(90). Sync / reconcile: `corpusSync.ts` (367, read-only integrity
check + index bridge), `runLedgerReconcile.ts` (199),
`shardJobReconcile.ts` (108). Telemetry: `telemetryProjection.ts`
(225). Read side: `runLedgerReads.ts` (177).

Dual-write call sites (DO-first verified by reading each site):

| Path | Call sites | Verdict |
|---|---|---|
| Run-ledger reports | `reportDispatch.ts:410` (screen persist), `:477` (pipeline generate), `:633` (workflow parent row) — DO persist first, hook re-reads the stored row, never throws | Conform |
| Run-ledger async jobs | `asyncJobs.ts:533, :1697, :2841, :3101` via `projectAsyncJobTransition` (awaited) — re-reads the stored row, never throws | Conform |
| Queue carrier | `orchestrator.ts` `projectQueuedRunLedger` (re-reads the DO row; throws on failure = the retry signal); `queue.ts:226-249` (per-user instance first, shared fallback; missing in both throws) | Conform |
| Sweep carrier | `orchestrator.ts` `reconcileRunLedgerProjection` → `runLedgerReconcile.ts` (admin POST only, never auto-run; 100 rows/ledger bound; named refusal when unconfigured) | Conform |
| Chain / schedule | `scheduled-agent.ts:2741` (synthesize), `:2844` (approve), `:2864` (kill) — DO save first, then `projectSynthesized` (awaited) | Conform |
| Shard jobs | `createShardJobPorts.ts:60` (port wrapper), `screenerCollation.ts:295` (run completion, best-effort, failure surfaced in result) | Conform |
| Audit events | `createChainSchedulePorts.ts` `projectAfterTransition` (per-transition chain+schedule events); `createShardJobPorts.ts:66` (`projectRunLegs` audit event); `shardJobReconcile.ts:93`; `scheduled-agent.ts:2815` (reconcile event) | Conform, except F-4 (silent drop on failure) |
| Telemetry realizations | `research-agent.ts:1106` (`evaluateRun`, try/catch + log); `telemetryRoute.ts:335` (admin-gated reconcile import) | Conform, except F-2 (no `ON CONFLICT`) |
| Canonical seed | `canonicalReportSeed.ts:75` (operator one-time seed, idempotent) | Conform |
| Reconciles | Run-ledger sweep (admin POST `/api/ops/run-ledger-reconcile`); usage-events sweep (#3185 bridge, operator POST `/api/ops/usage-events-reconcile` — projects both DO halves into the `agent_usage_events` D1 mirror, oldest-first, 100 rows/call, prune-before-project 365d; the live hook covers async insertEvent sites only, sync research run/evaluation rows project only through the sweep); shard-job reconcile (`privacy.ts:476`, platform-admin gated); chain-schedule reconcile (`scheduled-agent.ts:2805`, admin-gated route) | Conform (operator-only) |

Read side: `resolveLedgerReadMode` ("d1-only" iff the tenant's stored
readMode says so; default "merged"; the mode rides the response).
d1-only surfaces: reports list/detail (`reports.ts:1123-1193`,
`:1236-1330`), Workflow Runs (`workflowRuns.ts:657-753`).
Unprojected families are named in `storeErrors` — except a
reports/async-jobs row that is merely not-yet-projected, which is
silently absent (list) or 404s (detail). See F-1.

### A.2 Findings

- **F-1 — VIOLATION, follow-up #4961.** d1-only read mode is not
  gated on the synchronous (ORM) carrier.
  `setTenantProjectionCarriers`
  (`src/data/d1RunLedgerAdapter.ts:231-256`) accepts readMode
  "d1-only" with any carrier combination, and
  `resolveLedgerReadMode` (`src/services/runLedgerReads.ts`) returns
  it unchecked. `setTenantProjectionCarriers` has no production
  callers in `src/` (the operator sets the row directly), so nothing
  validates the combination anywhere. Rules violated: R-5, R-2.
  Evidence: `d1RunLedgerAdapter.ts:209,231-256`;
  `runLedgerReads.ts`; `reports.ts:1184-1193`.
- **F-2 — VIOLATION, follow-up #4962.** Telemetry realization
  idempotency is SELECT-then-INSERT without `ON CONFLICT`
  (`src/telemetry/d1TelemetryAdapter.ts:121-171`). The table PK is
  (tenantId, outcomeId) (`src/data/drizzleSchema.ts:249-278`), so
  concurrent redelivery throws a PK violation instead of no-op'ing;
  the research-agent call site logs and swallows it, the reconcile
  route 500s. Rule violated: R-1.
- **F-3 — VIOLATION, follow-up #4963.** Report projector version
  bump is read-then-write (`runLedgerProjection.ts`
  `projectReport`: `latestReport` → insert version+1, `ON CONFLICT
  DO NOTHING`). Two concurrent carriers projecting the same report
  with different content both read version N and both try N+1; one
  wins the PK, the other is silently dropped while its caller
  reports projected:true — the newer content never lands. Rule
  violated: R-1. The async-job adapter's atomic stale-guard
  (`d1RunLedgerAdapter.ts:144-153`) is the pattern to follow.
- **F-4 — VIOLATION, follow-up #4964.** A failed per-transition
  audit-event publication is dropped silently.
  `recordAuditEventBestEffort`
  (`src/data/createAuditReportPorts.ts:46-66`) catches without
  logging, and all four call sites discard the result
  (`createChainSchedulePorts.ts:90-100`,
  `createShardJobPorts.ts:66` (the `projectRunLegs` audit event),
  `shardJobReconcile.ts:93`, `scheduled-agent.ts:2815`). Rule
  violated: R-6 / ADR 0022 D-F2.3.
- **F-5 — VIOLATION, follow-up #4965.** Chain/schedule projection
  rows stamp the deployment-default tenant. `projectSynthesized`
  (`src/agents/scheduled-agent.ts:2756-2775`) resolves the tenant
  via the `resolveIaaaTenant` fallback and logs it (the #3179 note:
  no tenant context is threaded through ScheduledAgent, and the
  record carries no owner — per-record owner derivation needs a
  record schema change, not made). Rule violated: R-4.
- **F-6 — RECORDED BOUNDARY, not a violation.** `scheduleManagement`
  pause state has no D1 projection (DO-only;
  `src/services/unifiedScheduleManagement.ts` has no projection/D1
  references). Whether any member is read cross-instance is unruled
  — the D-I step-2 audit owns the ruling (ADR 0022 D-0). No
  cross-store read exists today, so no contract rule is violated.
- **F-7 — RECORDED LIMITATION.** Shard-job inline outcomes are
  unrecoverable if never projected (documented in
  `shardJobProjection.ts` header); reconcile can only advance rows
  the projector created, or create version-1 rows for rails jobs it
  can see. The run path therefore projects synchronously at
  completion, and a projector failure is surfaced in the result.
- **F-8 — RECORDED LIMITATION.** The run-ledger sweep has no durable
  cursor (restart-from-top, 100 rows/ledger bound) — documented in
  `runLedgerReconcile.ts` header.
- **F-9 — DECIDED NON-GOAL.** Any cross-store atomicity mechanism
  (grounds in the Decision section above).
- **F-10 — LATENT RULE, no live violation.** Audit-event
  idempotency depends on the caller passing a stable event id for a
  retry of the same occurrence (R-1c). No live violation found — the
  current callers are single-shot per occurrence.

### A.3 Out of the audit population (verified, not DO+D1 dual-writes)

- `researchPublish.ts`, `discoveryReportPublish.ts`,
  `screenerPublishers.ts`, `etradeBrokerPublish.ts`: delivery
  (Slack/email/webhook/artifacts), not D1 persistence.
- `copilotChannelProjection.ts`: a UI composition rule, not a store
  projection.
- `documentPublish.ts` index legs (Vectorize / AI Search) and the
  R2-body leg: index/R2 targets; the row↔R2-body pair is governed by
  the #2347 contract (cited in R-7.5, not re-audited).
- `dataLifecycle.ts:816` `recordAuditEvent`: the IAAA audit log
  (`src/security/iaaaAudit`), not the D1 audit-report projection.
- `corpusSync.ts`: a read-only integrity check + index bridge (the
  D-F2 scheduled-sync exemplar), not a dual-write; its legs never
  throw into the tick.
- `telemetryProjection.ts` pure converters: audited via their two
  call sites and the adapter (F-2).
