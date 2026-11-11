# IAAA decisions — decision record (#1757)

**Parent program:** #1717 (system-wide duplicate/overlap unification).
**Slice:** #1757 only. **Agent:** #CISO-bhdm. **Lane:** `lane:ciso-bhdm`.
**Base re-confirmed:** cfagent main `3b84863` (2026-10-28). Every row below
was re-checked against that main before recording; nothing here rests on a
stale clone or a relayed claim.

## What this record is — and what it is not

This is a **decision record**, not an adoption, not a build, and not an
owner decision. Each row ends in exactly one state:

- **SETTLED** — decided by the role named, with the value, and with the
  enforcement consequence stated; or
- **CARRIED** — not decided, with the deciding owner/role named, the reason
  it cannot be settled here, and the revisit trigger that reopens it; or
- **RECORDED** — the live behavior as it stands, deliberately kept, with its
  risk stated (used for the failed-audit-write-on-login row, where changing
  behavior without a directing decision would be the wrong move).

**Owner decisions are owner actions.** This slice records them; it never
makes them. Nothing below presents a carried item as decided, and nothing
silently drops an item. The Emergency Register stays **DRAFT, NOT IN
FORCE**; the assurance review stays **DRAFT, NOT ADOPTED**; no endpoint is
removed, no code path is deleted, no enforcement behavior changes in this
slice, and no production switch value is set.

**Guard (program rule, restated):** a configurable rule never lets a caller
disable its own enforcement. The settled values below are CISO values, not
caller-configurable switches: no env var, session value, run value, or user
value can widen, narrow, or disable them, and the owner may override them
by an explicit owner decision at any time.

## D-1 — F-11: step-up and idle windows — SETTLED as CISO values

- **Step-up freshness window: 15 minutes.**
- **Idle window: 30 minutes.**
- **Authority:** CISO lane, per assurance-review adoption question Q4
  (step-up thresholds: CISO). The values are the platform defaults already
  enforced in code (`DEFAULT_STEP_UP_FRESHNESS_MS = 15 * 60 * 1000` and
  `DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000` in
  `src/security/sessionPolicy.ts`), so settling them changes **no
  enforcement behavior** — it only retires the "proposed, not settled"
  status that `authz.md` §9, `obligations.ts`, `revocationTargets.ts`,
  and the #1750/#1751 tests carried.
- **Scope of the settlement:** the platform defaults only. Per-action
  freshness windows (whether any action on the epic §4 list needs a window
  other than 15 minutes) remain carried under Q4's remainder (see D-5).
  The absolute session deadline (7 days, `SESSION_TTL`) is already
  enforced and is recorded here as context only — it was not an F-11
  item and this slice does not re-decide it.
- **Owner override 2026-10-29:** the idle window is 8 hours in
  `config/session-limits.json` (the step-up window stays 15 minutes). The
  decision above records the CISO default, not the deployed value.
- **Revisit trigger:** an owner decision overriding either value, or a
  CTO-lane #945 wiring slice demonstrating that a specific action needs a
  different window (which then becomes a per-action Q4 answer, not a
  change to the platform defaults by the back door).
- **Consequential edits in this PR:** `authz.md` §9 and §10, the #1750
  target strings in `revocationTargets.ts`, and the #1750/#1751 comment
  pointers — all wording-only, values unchanged.

## D-2 — F-12 (login): failed audit write on wired login — RECORDED as deliberately non-blocking (live path)

- **Live behavior, kept:** a failed audit write does **not** block a wired
  login. This is the code as it stands on main, not a new choice:
  `src/security/iaaaLogin.ts` calls the login audit a "best-effort" seam
  that "never changes the outcome", and `src/security/iaaaAuthAudit.ts`
  states that `recordWiredAuthAudit` "never throws and its result never
  changes a login outcome in this phase" and that "a failed write is
  reported in the result, not enforced".
- **Risk, stated plainly:** a login whose audit write fails is unattributed
  in the audit sink. The failure is visible only in the returned result;
  no alerting path for a failed login-audit write is named anywhere on
  main. That is an accepted residual for the live login path until the
  blocking set is decided — it is not a claim that the gap is closed.
- **Not to be confused with:** the #1751 obligation evaluator, which
  *does* fail closed on a failed or throwing audit write — but only for
  `role:assign`, `membership:revoke`, and `audit:export` under
  `evaluateWithObligations()`, and only where CTO-lane #945 route wiring
  adopts the evaluator. The evaluator's fail-closed rule is not the login
  path's rule, and this record does not merge them.
- **Also not to be confused with:** the `iaaaAudit.ts` pure model, which
  proposes that consequential actions BLOCK when audit cannot be recorded
  but states explicitly that it is "deliberately NOT live audit
  enforcement" and that a later slice wires it into live call sites. The
  model's blocking rule is therefore not live behavior today.
- **Carried part:** whether a failed audit write should block a wired login
  as part of the consequential-action blocking set is **CARRIED** to
  adoption question Q7 / #945 Slice 5 (deciding roles CISO + CDO, owner
  Mubasher approves). Revisit trigger: the Q7 answer, or a login-audit
  failure observed in production that forces the question early. Until
  then, no behavior change: blocking logins on audit failure without a
  directing decision would trade a known, visible residual for an
  availability failure mode nobody has approved.

## D-3 — F-12 (retention): audit retention period — CARRIED

- **State:** undecided. No retention period is asserted anywhere on main;
  `iaaaAudit.ts` states it "makes no retention claim".
- **Deciding owner:** Mubasher (human owner), on a CISO + CDO
  recommendation (adoption question Q7).
- **Reason it cannot settle here:** retention is a legal/operational
  commitment (storage cost, legal hold, tenant deletion coupling — the
  review's §1.7 offboarding gap), not a value this lane can fix from code.
- **Revisit trigger:** the Q7 answer in #945 Slice 5 adoption, or a
  tenant/user deletion slice that needs a retention rule to proceed.

## D-4 — F-12 (tamper): tamper mechanism and tamper response — CARRIED

- **Mechanism, as it stands:** PROPOSED, not settled. `iaaaAudit.ts`
  implements a SHA-256 hash chain with `verifyChain()`; the assurance
  review (§1.6) records its own header as calling this "the proposed
  tamper-detection mechanism, not a settled [policy]". This record does
  not upgrade "tamper-evident hash chain (proposed)" into "tamper-proof
  audit" or into settled policy.
- **Response, as it stands:** undecided. What happens when verification
  fails — alert, block, quarantine, or something else — is specified
  nowhere on main.
- **Deciding owner:** Mubasher, on a CISO + CDO recommendation (Q7).
- **Revisit trigger:** the Q7 answer; a detected tamper event would also
  force the response question immediately.

## D-5 — F-22: #945 adoption refresh — review stays DRAFT; §2 NOT adopted as written

The assurance review (`docs/architecture/security/iaaa-945-assurance-review.md`)
remains **DRAFT, NOT ADOPTED**. Its §2 assessment is now stale twice over:
frozen at main `975c3ed` (2026-10-21) in the issue text, re-based to main
`1418ee0` (2026-10-25) in the review's own baseline, and main has since
moved to `3b84863` — past the #1749 legacy bound, the #1750 revocation
targets, the #1751 obligations evaluator, and the #1754 gate-coverage
inventory. **Adoption must adopt a refreshed spec, not the 2026-10-21 text
verbatim** (review Q11). This slice does not refresh the spec and does not
adopt §2.

### Adoption questions 1–12, refreshed against current main

| Q | Status after this slice | Evidence / owner |
| --- | --- | --- |
| Q1 Provider + cost | **ANSWERED at option level by the owner (2026-10-25): provider APP-OWNED, framework FOSS.** This supersedes the review's Option A recommendation (Auth0 for identity); the Auth0 cost verification the review asked for is moot while Auth0 is deferred. Recorded here, not re-decided here. | Owner direction 2026-10-25, standing program record; #945 stays open for implementation. |
| Q2 Tenant model | **ANSWERED at option level by the owner (2026-10-25): tenant APP-OWNED.** The mapping of the app-owned tenant model onto the spec §4 `Membership`/`RoleBinding` types is still owed. | Owner direction 2026-10-25; mapping owed by the CTO lane, not this slice. |
| Q3 Genesis / bootstrap | **CARRIED** (CISO + CTO; owner approves the channel). No genesis procedure beyond the existing bootstrap/genesis-window docs is settled here. | Revisit: #945 adoption itself. |
| Q4 Step-up thresholds | **SETTLED in part (D-1):** platform defaults 15 min step-up / 30 min idle. **CARRIED remainder:** per-action windows for the epic §4 action list, and the legacy-session rule. | Revisit: CTO-lane #945 route wiring. |
| Q5 Session values | **SETTLED in part (D-1):** idle 30 min. **CARRIED remainder:** rotation triggers, cookie settings, CSRF rule for cookie-authenticated mutations, the ±60 s idle tolerance stated as a tolerance. | Revisit: #945 Slice 2. |
| Q6 Revocation measure | **SETTLED in part by #1750 (not by this slice):** per-trigger table and numeric targets live in `src/security/revocationTargets.ts` and `authz.md` §9 (membership/session/API-key/admin/token-expiry). **CARRIED remainder:** measures for cached decisions, running tasks, pending approvals, queued actions, and re-delegated work, which Q6 asked for and #1750's table does not cover. | Revisit: #945 Slice 2 follow-up or a dedicated measure slice. |
| Q7 Audit blocking set, retention, tamper | **CARRIED** (CISO + CDO; owner Mubasher approves) — see D-2, D-3, D-4. | Revisit: #945 Slice 5 adoption. |
| Q8 Delegation definitions | **CARRIED** (CISO + CTO). `maxCost` is **not implemented**: `delegation.ts` is action-count only and says so explicitly; adoption must carry `maxCost` as a future requirement, not as an implemented control. "Scoped" re-delegation definition and the proposal-version/hash binding for approvals are also carried. | Revisit: #945 Slice 4. |
| Q9 Grant rules | **CARRIED** (CISO + CTO). Second-approver rule, default grant expiry, and granter-revocation consequences are not settled here. | Revisit: #945 Slice 3. |
| Q10 Service / workload identity | **PARTIAL on main, CARRIED as a spec question.** `src/security/serviceIdentity.ts` and `docs/operations/runbook/service-identity.md` exist; incorporating that model into the spec (or scoping it as a named separate slice with acceptance tests) is still owed. | Revisit: #945 Slice 1 or the named separate slice. |
| Q11 Spec refresh | **CARRIED** (CEO-aimp as spec owner + CTO + CDO). A revised spec re-based to current main, reconciling the §1.9 conflicts and mapping the §6 test table to existing `tests/iaaa_*.test.ts` files, is owed. This slice is not that refresh. | Revisit: before any adoption. |
| Q12 Independent evaluation | **CARRIED** (Independent Evaluation, not this lane). This lane does not approve its own review, and the spec author does not approve its own spec. | Revisit: at adoption. |

### Stale claims in the review that must not be adopted as written

- The §2 assessment predates Slices 1–3, Google login, PDP, admin UI,
  delegation, audit, and revocation code now on main (and now also
  #1749–#1751/#1754).
- "Delegation `maxCost`" as an implemented control — false on main
  (action count only).
- "Tamper-proof audit" or a settled retention policy — false on main
  (proposed hash chain; no retention claim).
- Revocation "per-trigger table and numeric measure missing" — now
  partially stale: #1750 supplied the table for five triggers (see Q6);
  the remainder is carried, not missing wholesale.
- The review's Option A (Auth0) provider recommendation — superseded at
  the option level by the owner's APP-OWNED decision (Q1).

## D-6 — F-30: design.md §4 open items — updated, not closed

- **#945 open list:** updated in this PR to reflect this record —
  provider choice decided (APP-OWNED/FOSS/APP-OWNED), step-up/idle
  settled as CISO values (D-1), the rest carried (D-2–D-5). The list is
  not removed: #945 itself stays open.
- **#1066:** referenced only. Removing the `default_trader` static-token
  exception via explicit service identity (Phases A–C) is unchanged by
  this slice and is not re-filed here.
- **#1024:** referenced only. The `DOCS_PUBLIC_SURFACES` decision, A2A
  POST per-agent authentication verification, and framework-adapter
  conformance are unchanged by this slice and are not re-filed here.
- **#907:** referenced only. The kill switch as a measurable objective
  and the RiskPolicyEngine boundary remain a proposal, not adopted, and
  are not re-filed here.

## D-7 — F-34: Emergency Register decisions D1–D13 — ALL PENDING, none dropped, none invented

Verified on current main: the register
(`docs/architecture/security/emergency-authority-register.md`) §7 table
lists every decision D1–D13 as PENDING (D2, D3, D5, D13 per entry), and
its approval record is blank by design ("— blank until adoption —").
Issue #1757 itself carries no owner decision comment (zero comments
before this slice's claim comment). **No owner decision on any D-item was
found in the register or the issue history, so every item below stays
PENDING/carried.** The register is NOT marked in force by this PR, and no
entry's proposed value is treated as approved.

| # | Decision | Status | Deciding owner | Revisit trigger |
| --- | --- | --- | --- | --- |
| D1 | Adopt this register at all, in whole or entry by entry | PENDING | Mubasher | Explicit owner adoption decision, whole or per entry |
| D2 | Approve each Part A entry's trigger, scope, reversal (EA-01–EA-05) | PENDING, per entry | Mubasher | Owner approval per entry; nothing in Part A is in force until then |
| D3 | Approve each proposed maximum duration (EA-01 72h-or-review; EA-02 until owner decision; EA-04 until evidence reviewed; EA-05 24h single window) | PENDING, per duration | Mubasher | Owner approval per duration |
| D4 | Decide whether any Part B entry may EVER be pre-authorized (EA-10–EA-13), or stays escalation-only permanently | PENDING, per entry | Mubasher | Owner decision per entry; **default while undecided is escalation-only** |
| D5 | Approve Part B durations + EA-11 auto-resume vs. fail-closed question (EA-11 4h auto-resume proposed; EA-12 1h; EA-13 until owner order) | PENDING, per entry | Mubasher | Owner approval per entry |
| D6 | Confirm EA-14 is recommendation-only | PENDING | Mubasher | Owner confirmation |
| D7 | Name notification channel + maximum notification delay for invocations | PENDING | Mubasher | Owner naming; delay is not asserted by the draft |
| D8 | Decide whether an EA-02 release-hold request becomes binding under any policy, and which policy | PENDING | Mubasher | Owner decision + named policy; no policy is named by the draft |
| D9 | Set evidence-retention location and period for invocation records | PENDING | Mubasher | Owner decision; no period asserted by the draft |
| D10 | Set review cadence + lapse-on-non-renewal rule (proposed: quarterly + after any invocation; lapse to escalation-only if not re-approved) | PENDING | Mubasher | Owner decision; the proposed lapse rule is not in force until approved |
| D11 | Name an alternate human owner if Mubasher is unavailable, or confirm there is none | PENDING | Mubasher | Owner naming or confirmation of none; if none, invocations requiring owner action wait |
| D12 | Confirm scope boundary: entries apply to the CISO lane only, never to other lanes' work | PENDING | Mubasher | Owner confirmation |
| D13 | Name concrete rotation procedure, enforcement points, notification tool for any approved Part B entry | PENDING, per entry | Mubasher | Owner naming per entry; **an entry is uninvokable until named** |

## What this slice deliberately does not do

- Does not change any enforcement behavior, session value, gate, or audit
  path. The only code-file touches are wording-only comment/string
  updates that stop saying "unsettled, see #1757" for values D-1 settles.
- Does not adopt the assurance review, refresh the IAAA spec, or mark the
  Emergency Register in force.
- Does not duplicate, re-file, or close #945, #1024, #1066, or #907.
- Does not set any production switch value or create any production goal.
- Does not touch #1980, #2037, #1819, or #2052/#2053.

## Evidence index (all re-confirmed on main `3b84863`)

- `docs/architecture/security/authz.md` §9 (open decisions), §10
  (residuals) — F-11/F-12 source rows.
- `docs/architecture/security/design.md` §4 (open items) — F-30 source row.
- `docs/architecture/security/iaaa-945-assurance-review.md` (DRAFT, NOT
  ADOPTED; baseline main `1418ee0`) — F-22 source row.
- `docs/architecture/security/emergency-authority-register.md` §7 + blank
  approval record (DRAFT, NOT IN FORCE) — F-34 source row.
- `src/security/sessionPolicy.ts` (`DEFAULT_STEP_UP_FRESHNESS_MS`,
  `DEFAULT_IDLE_TIMEOUT_MS`) — enforced defaults D-1 settles.
- `src/security/iaaaLogin.ts` (best-effort login-audit seam),
  `src/security/iaaaAuthAudit.ts` (never throws, result never changes a
  login outcome), `src/security/iaaaAudit.ts` (pure model, explicitly not
  live enforcement; no retention claim) — D-2/D-3/D-4 evidence.
- `src/security/revocationTargets.ts` + #1750 tests — Q6 partial
  settlement by #1750, not by this slice.
- Issue #1757: zero comments before this slice's claim comment
  (6465313443); no owner decision on any D-item found in the register or
  the issue history.

#CISO-bhdm
