# #945 Q4 — Step-up thresholds and freshness windows (#3102)

CISO answer to assurance review §4 Q4 (blocking Slice 2) and epic §4.
This document records the answer; it does NOT rewrite the PROPOSED spec
(`docs/plans/IAAA-945-spec.md`) or the DRAFT assurance review
(`docs/architecture/security/iaaa-945-assurance-review.md`) — that
refresh is Q11.

## The answer

| Action (epic §4) | Window | Rationale |
|---|---|---|
| Privileged role assignment | 5 min | Grants persist and can create platform admins |
| Integration-credential management | 5 min | Minted credentials outlive the session |
| Auth-method change | 5 min | Account-takeover vector |
| Provider linking | 5 min | Binds a new login path to the account |
| Payment-configuration change | 5 min | Money-adjacent configuration |
| Sensitive export | 10 min | Read-only exfiltration, bounded blast radius |
| Any unlisted action (fallback) | 15 min | The settled #1757 default; fail closed, never no-gate |

Implementation: `src/security/stepUpActions.ts` (frozen window table,
`stepUpWindowForAction`, `sessionRequiresStepUpForAction` reusing the
real `sessionRequiresStepUp` rule) and the wiring-aware predicate
`requiresStepUpForAction` in `src/security/iaaaGates.ts` (wiring OFF
never requires step-up, same as the pilot predicate).

No step-up-enforced action in code falls outside the six: the api-keys
mint pilot is integration-credential management and `role:assign` is
privileged role assignment, so this table adds nothing beyond the
epic list.

## Legacy-session rule (settled)

A session without `authTimeMs` (every legacy session) is STALE for all
six actions — fail closed, re-authenticate and retry. Legacy sessions
continue for low-sensitivity reads; no gate is placed on reads. Rotation
does not refresh `authTimeMs` (rotation is not re-authentication, per
`rotateSession` in `sessionPolicy.ts`). This reconciles the spec's "old
sessions are not invalidated" promise with main's fail-closed behavior,
per assurance review §1.2: not invalidated, but stale for every
sensitive action.

Freshness here is exact arithmetic on `authTimeMs`. The ±60s tolerance
belongs to idle enforcement (`lastActivityMs`, touched at most once
per 60s) and is stated alongside these windows, never folded into them.

## Enforcement map (wiring ON only)

| Route | Action / window |
|---|---|
| POST /api/iaaa/role-grants/grant | Privileged role assignment / 5 min, gated before the obligation evaluation, after the idempotent no-op check |
| POST /api/iaaa/membership/grant | Privileged role assignment / 5 min, gated before the per-binding obligation loop, after the idempotent no-op check |
| POST /api/iaaa/bootstrap-proposals/approve | Privileged role assignment / 5 min (approval authorizes a platform-admin grant), gated before the decision is written |
| GET /api/privacy/export | Sensitive export / 10 min, gated before the payload is built |
| POST /api/api-keys (mint) | Integration-credential management / 5 min (pilot predicate retimed from the 15-min default) |

The frozen #1751 `OBLIGATION_POLICY` is NOT edited: the route gates are
tighter than (or equal to) the obligation default (15 min), so the
tighter window governs real grants. A no-op grant (already-granted
binding) keeps its no-op semantics — nothing is granted, nothing is
gated — per the #2661/#2688 comments at those sites.

## Deliberately NOT gated, with reason (not dropped)

- **Auth-method change:** no in-app route (no app-level factors per
  #1752; auth-method changes happen at the IdP). Window defined and
  reserved for any future surface.
- **Provider linking:** no standalone route (`linkProviderToUser` has
  no callers); linking occurs at login-time binding, which is fresh
  authentication by construction. Window reserved for a standalone
  link route.
- **Payment-configuration change:** no in-app route (mode is
  env-controlled; subscription cancel is a payment action under HITL,
  not a config change). Window reserved.
- **Audit export download:** no download route exists today
  (`/api/audit/history` is a read); the sensitive-export window
  applies to any future audit-export route.
- **Revocations** (api-key revoke, membership revoke, role revoke,
  bootstrap reject): never blocked by staleness — revocation must
  always be available. Same principle as the mint pilot's deliberate
  non-gating of revocation.
- **Bootstrap confirm-applied:** records an out-of-band operator
  application; the privileged decision is the approval, which is
  gated.
- **E*TRADE connect start:** already PEP-enforced with a #1749 legacy
  grace bound; layering a step-up gate would silently override that
  grace. Window declared (5 min, integration-credential management);
  the gate lands when the grace retires (named follow-up).
- **Service-token mint/rotate** (`/api/admin/service-user/tokens`):
  dispatched through the orchestrator DO, where the session's
  `authTimeMs` is not threaded today (`resolveCaller` rebuilds the
  caller from headers + membership store). Window declared (5 min);
  enforcement needs that threading as a named follow-up.

## Tests

- `tests/iaaa_step_up_actions.test.ts` (new): window table per action,
  unknown-action fallback, per-action allow/deny boundaries (4 min
  passes 5-min actions, exactly 5 min fails them; 6 min passes export,
  exactly 10 min fails it), legacy/future/missing authTime fails all
  actions, wiring-off rule, mint retime boundary.
- `tests/iaaa_step_up_routes_3102.test.ts` (new): worker-fetch deny
  tests — a 60-minute-old wired session gets 403 + the step-up
  message on api-keys mint, role-grants/grant, membership/grant,
  privacy/export, and bootstrap-proposals/approve; plus a fresh-auth
  positive control on role-grants/grant (passes the gate, then fails
  the PDP deny — a different message).
- `tests/iaaa_wiring_phase2b.test.ts` (updated, not deleted): the mint
  fresh point moves from 5 min to 4 min with a Q4 comment — the
  intentional policy change, not a deletion to go green.
