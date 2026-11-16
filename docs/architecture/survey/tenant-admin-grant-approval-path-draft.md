# Tenant-admin path for selective unlimited-free grants and per-run price approvals — DRAFT

Prepared 2026-11-09 by CBO-mlops (research stage, no build, no issue filed, no PR).
Decision it serves: Mars, 2026-11-05 ~13:34 EST — unlimited-free grants and per-run
price approvals are selective, by platform admin and/or tenant admin. None granted
or approved yet. Open since then: how a tenant admin actually exercises that, when
today's grant UI is Platform Admin only.

## What is true today (verified)

- Grant mechanism is on main: #3245 via PR #3267, landed 2026-11-05 as `d9eeef28`
  (migration 0040). Gate honours an active grant first, at price 0, including
  recurring runs; `UnlimitedFreeGrant { grantedBy, reason, expiresAtMs }`,
  `expiresAtMs: null` = no expiry.
- Write path is store-operator-only: `POST /payments/agentic/commercial/account`
  returns 403 "Forbidden: store operator required" otherwise; `grantedBy` is the
  session-verified operator login, never client-supplied. UI is
  `UnlimitedFreeGrantSection`, rendered in `AccountAdminPanel` inside Platform
  Admin → Accounts: https://agent.openaimp.com/?tab=platform-admin&view=accounts
- Tenant Admin panel (`TenantAdminPanel`, #2221) is tenant create / list / settings
  plus a read-only membership view. It has no grant section, and its calls gate on
  store-operator status. A tenant admin who is not also a store operator cannot
  reach the grant route today.
- Roles (#2688, `src/security/roleGrants.ts`): a platform-admin is NOT a tenant
  superuser. A tenant-admin grant requires the granter to hold `role:assign` in
  that tenant. So "tenant admin" is already a real, tenant-scoped role — the grant
  path can key off it rather than inventing a new role.
- Per-run prices: `agent_price_catalogue` carries `approval_status`
  (proposed/approved), `approved_by`, `approved_at_ms` (#2547, migration 0027);
  gates refuse unapproved prices fail-closed. Prices are platform-wide catalogue
  rows, not per-tenant rows — there is no per-tenant price to approve today.

Sources checked 2026-11-09: the `~/cfagent-3245` builder checkout (Nov 5 snapshot)
plus a re-verification the same day against the newest local checkout
`~/cfagent-3305-ui-build` at `7591e065` (2026-11-05, post-#3315): the grant
route's 403 "Forbidden: store operator required." (`src/agents/routes/
platformAccounts.ts:255,260`), the `UnlimitedFreeGrantSection` shape
(`grantedBy` session-set, `expiresAtMs: null` = no expiry), `TenantAdminPanel`
still having no grant section, `role:assign`-in-tenant (`src/security/
roleGrants.ts`), and `approval_status` defaulting to `proposed`
(`src/data/drizzleSchema.ts:749`) all still hold. Not yet re-verified against
fresh Nov 6–9 main (no checkout newer than Nov 5 exists locally) — re-check
file paths once more at filing time. One clarification from that re-read:
`TenantAdminPanel`'s "grants, revokes live on the IAAA Admin tab" refers to
membership/role grants (CISO lane), not unlimited-free grants.
`~/workspace/cbo-remaining-work/entitlement-model-verify-2026-11-05.md` and
`~/memory/2026-11-05.md` lines 59, 149, 392, 606. Live-store facts (whether any
real account holds a grant, the live approved price set) are not verifiable from
the repo.

## Proposed design

### Grants — Option A (recommended): tenant-scoped grant, same mechanism
- New tenant-scoped write, reusing the existing grant shape and upsert semantics
  (`undefined` = preserve, explicit `null` = revoke, object = grant) and the
  existing audit event, with `grantedBy` = session login.
- Server enforces, never the client: caller holds `tenant-admin` for the target
  tenant (via the #2688 role grant); target account's `tenantId` must equal the
  caller's tenant; a tenant admin can never grant in another tenant, and can
  never grant to an account with no tenant row.
- UI: a grant section in the tenant's own admin surface (Tenant Admin panel,
  tenant-scoped Accounts view) — same fields as today: account lookup within
  the tenant, reason (required), optional expiry. Platform Admin keeps working
  unchanged for platform admins.
- Scope decision for Mars: grant applies to the (user, tenant) account, matching
  the corrected multi-tenant model (each user keeps their own subscription within
  a tenant; subscriptions do not carry across tenants).

### Grants — Option B: request / approve
- Tenant admin files a grant request (account, reason, expiry); a platform admin
  approves it through the existing Platform Admin UI and existing operator route.
- No new write path, so smaller and safer — but slower, and it leaves the
  "tenant admin exercises it" decision half-answered. Use only if Mars wants a
  human platform-admin check on every grant.

### Per-run price approvals — recommend request-only for tenant admins
- A tenant admin approving a per-run price cannot mean setting the global
  catalogue price: that price applies to every tenant. Tenant-scoped approval
  only makes sense if prices become per-tenant, which they are not.
- Proposed: tenant admin proposes / requests a price (family, amount, reason);
  platform admin (or Mars as owner) approves it in the existing catalogue
  approval flow, recording `approved_by` / `approved_at_ms`. No tenant-admin
  write to `approval_status`.
- If Mars instead wants tenant admins to set prices for their own tenant only,
  that is a bigger change (per-tenant catalogue rows) and needs its own issue.

## Decisions needed from Mars (before any issue is filed)
1. Grants: Option A (direct tenant-scoped grant) or Option B (request/approve)?
2. Price approvals: request-only for tenant admins (recommended), or per-tenant
   pricing as a separate design?
3. Grant defaults: expiry required or open-ended (`null`) allowed? Reason required?
4. First account(s) for unlimited-free — still none granted; name them, or keep
   the mechanism dormant until the first case arises.

## Explicitly not decided here
- No per-run price is approved by this draft; catalogue seeds stay PROPOSED.
- No first grant is made; no account is named.
- The #3309/#3335 hold is unchanged (still blocked on Mars's Network-tab evidence).
- The go/no-go timing question (does the go/no-go need Mars's tap before a PR is
  marked ready, or is the discussion a debrief after?) is still open and is not
  answered by this draft.
