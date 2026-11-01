# Tenancy isolation: app-level WHERE-clause leak class — occurrence audit (#1761)

Parent: #1717 system-wide unification program. Source rows: F-36
partial (`security/assessment/assessment-01.md` SEC-006) and F-37
partial (`data/assessment/assessment-01.md` DATA-003), both claiming
multi-tenancy rests on application-level `WHERE tenant_id = ?`
filtering whose omission leaks cross-tenant state.

## Verification method (current main, 2026-11-01)

The assessment claim was verified against code, not taken on trust:

1. Every table in `src/data/drizzleSchema.ts` was classified by
   whether it carries a `tenant_id` column.
2. Every read method on the D1 adapter for each tenant-carrying
   table was checked for a tenant predicate.
3. The DO-SQLite surface was checked separately: only one
   DO-SQLite adapter table carries `tenant_id` at all.

The claim is CONFIRMED in part and CORRECTED in part: most
tenant-table adapters already predicate on tenant_id (the
foundation slices did that work), but two live omissions existed,
and one of them contradicted a port doc that already claimed "no
unscoped read".

## The mechanism (the fix for the class, not one query)

`src/data/tenantScope.ts` — a binding a query cannot run without:

- `TenantScope` is an opaque token constructible only via
  `bindTenantScope(tenantId)`, which throws on a missing, blank, or
  non-string tenant id. There is no unscoped construction path.
- `tenantEq(table, scope)` builds the Drizzle tenant predicate, so
  adopting adapters get the filter from the mechanism instead of
  re-typing it per query.
- `assertTenantScopeMatch(rowTenantId, scope)` is the fail-closed
  guard for id-keyed paths whose lookup key is not itself the
  tenant: a stored row belonging to another tenant throws instead
  of being returned or overwritten.

Deliberately NOT behind a runtime config switch: this is
enforcement, not a behavior variant. A switch letting a caller
disable its own tenant scoping would be exactly the defect the
program's security guard forbids (enforcement is never opt-out).
No endpoint, route, or code path is removed by this slice.

## Fixed in this slice (verified live omissions)

| # | Surface | Defect | Fix |
|---|---|---|---|
| 1 | `D1LifecycleAdapter.getPreferences(userId, tenantId)` (+ in-memory twin) | Accepted `tenantId` but predicated on `user_id` alone, returning another tenant's stored row for the same user. | Predicates on `user_id AND tenant_id` via the bound scope; a blank tenant throws; a mismatched tenant reads the defaults, never the other tenant's row. |
| 2 | `D1LifecycleAdapter.setPreferences` (+ in-memory twin) | The table's primary key is `user_id` alone, so the upsert conflicted on user and silently overwrote another tenant's row. | A stored row for another tenant throws (`TenantScopeError`) before any write. |
| 3 | `JournalPort.getEntriesByRef` (D1 + in-memory adapters) | Took no tenant and returned any tenant's entries for the ref — contradicting the port doc's "no unscoped read" claim — so a replay post in another tenant was short-circuited by the first tenant's entries. | Signature now requires `tenantId`; both adapters predicate on `ref AND tenant_id`; the idempotency probe in `postEntries` passes the post's single tenant. |
| 4 | Journal cross-tenant replay (consequence of 3) | The entry id is tenant-blind (`ref:account`), so a tenant-B post for an already-posted ref silently no-op'd on the D1 id conflict while the adapter returned phantom rows that were never stored (and the in-memory twin overwrote tenant-A's row). | Fail closed: after the insert loop the D1 adapter re-reads scoped and throws when nothing landed; the in-memory adapter throws on an id clash with a different tenant. Posting is best-effort upstream, so the ledger write itself is unaffected. |

Tests: `tests/tenant_scope_1761.test.ts` (Red first: 8 adapter
assertions failed against the pre-fix code, then green). The
journal and lifecycle conformance suites (`journal_ports`,
`lifecycle_ports`) still pass unchanged against both adapters.

## Already scoped (no change; the pattern that works)

D1 adapters whose every tenant-table read already predicates on
tenant_id: governance (`latestHalt`/`isHalted`),
chain/schedule (`latestChain`/`latestSchedule`), audit-policy
chain (`getChainHead`/`listChainEntries`/`listAgedChainEntries`/
`deleteChainEntries`), audit-report (`listAuditForChain`/
`listAuditForTenant`/`latestReport`/`listReports`/`deleteReport`),
provider capture (`getCaptureById`/`listWhere` family),
shard jobs (all reads), journal `listEntries`, commercial tenant
settings (`getTenantAdsEnabled`/`getTenantAutoRefresh` family),
native-ledger `listRowsForTenant`. DO-SQLite provider capture
reads (`getById`/`listWhere` family) are likewise tenant-scoped.
These are the precedent the mechanism generalizes.

## Remaining occurrences, named with reasons (not fixed here)

| Surface | Why it remains | Residual risk |
|---|---|---|
| Subscription reads by id / provider refs (`getSubscription`, `findByProviderSubscriptionId`, `findByPaymentRef`, `updateProviderBilling`, `revokeSubscription`) and refund reads (`getRefund`, `updateRefund`) | Keyed by globally-unique ids (UUID / provider refs), not by a tenant listing query; the omitted-filter class is a listing/query omission, and these are single-row lookups behind session-gated routes. `listSubscriptions(userId)` / `listRefunds(userId)` are owner-keyed by the globally-unique login. | A caller holding another tenant's unguessable id could read that row. If login reuse across tenants is ever introduced, these need tenant parameters. Carried, not a verified leak. |
| Commercial `getAccount(userId)`, `adjustCredits`, `consumeCredits`, `consumeIncludedRun` | Keyed by the account id, which is the user login (globally unique); the row's tenant column is carried, not predicated. Same owner-keyed reasoning as above. | Same as above. |
| Native-ledger `findRow` / `listRowsForRun` | Keyed by the session id derived from the runRequestId (a globally-unique run identifier); `listRowsForTenant` is the tenant-scoped list. | Same as above. |
| Lifecycle `listEarnings(userId)`, `redeemableBalance`, digest guard (`hasSentDigest`/`markDigestSent`) | Owner-keyed by user login / (user, day); the earnings table's tenant column is not predicated on these user-scoped paths. | Same as above. |
| Mesh trace `hopsFor(traceId)` | Trace-id-keyed diagnostic read; `tenant_id` is nullable by design (boundary hops record null, never a fabricated tenant, per the #1743 scope rule). A tenant predicate would drop boundary hops. | Trace ids are run-scoped; no tenant listing exists here. |
| Resource-usage rollup reads (`resource_sql_ops` totals) | Operator aggregate consumed by the #1819 rollup/alert goals, not by any tenant-serving route; `tenant_id` is recorded per op for attribution. | None for tenant reads; the aggregate is operator-only by construction. |
| Generic DO-SQLite `Repository` (`ormRepositoryCore.ts`) and D1 marketplace adapter `findMany` with optional `where` | Their tables carry no `tenant_id` column at all, so the WHERE-omission class does not apply: DO-SQLite tenancy is DO-instance residency (per-login instances; the shared orchestrator instance's tables are platform-global by design), and the marketplace tables are platform catalog data. | If a tenant column is ever added to these tables, reads must adopt `tenantScope` at that time. |
| `agent_calibration_decisions` | Schema-defined with a `tenant_id` column but no adapter or port reads it on current main — no live read surface. | Revisit when an adapter lands. |
| Non-tenant tables (no `tenant_id` column) | Market data (IV history, price catalogue, quote source), fleet registry, mesh eval/proposals, proposal ledger, trace records, work-item events, billing/refund policy, audit-policy actions/settings, journal accounts, credit claims/redemptions, paid submissions, subscription plans, referral rules, commercial claim tables, resource rollup/comparison tables, migration metadata. | None — not tenant data. Platform-global or operator data by design. |

## Assessment status carried

SEC-006 and DATA-003 stay **PARTIAL FIT** after this slice: the
mechanism exists, the two verified omissions are fixed, and the
audit above names every remaining occurrence with its reason —
but the owner-keyed single-row lookups in the table above are not
yet tenant-predicated, so "strict multi-tenant data isolation"
cannot honestly be marked FIT until a follow-up slice either
predicates them or records an owner decision accepting the
owner-keyed reasoning. The recommended actions in both assessment
rows are updated to point at this audit and at
`src/data/tenantScope.ts`.

## Follow-ups (not built here)

- Tenant-scoped journal entry ids (migration) if per-tenant reuse
  of a transactionRef ever becomes a legitimate flow; today a
  cross-tenant replay fails closed by throw, which is the safe
  behavior for runRequestId-derived refs.
- Tenant parameters on the owner-keyed single-row lookups above,
  if the identity model ever permits login reuse across tenants.

#CISO-bhdm
