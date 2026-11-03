# PAP editor: approval-gated policy administration (#2838, sub-issue of #2837)

## Design

Policy today lives in code: the `ROLE_GRANTS` tables in
`src/security/authorization.ts` are authoritative, with a portable
`PolicySnapshot` form served through the `PolicyProvider` port (#1755).
#1755 explicitly deferred a runtime editor ("a second source of truth
and an unaudited privilege path"). This slice is that follow-up's
approval/audit design, implemented in `src/security/policyProposals.ts`
(pure), routes in `src/server.ts`, and the IAAA Admin Overview section
(`src/client/PolicyProposalsPanel.tsx`, beside Role grants — not a new tab).

## Workflow

Platform-admin proposes → a different platform-admin approves →
promotion re-validates and swaps the PAP-active snapshot. Only promotion
activates anything: writing a proposal changes nothing, approving
changes nothing, and the compiled tables stay authoritative until a
promotion completes.

- **Proposer ≠ approver (default).** Self-approval without a non-empty
  named reason is refused (`SELF_APPROVAL`); with one, the reason is
  recorded on the proposal (`exceptionReason`).
- **No second source of truth.** Proposals validate through #1755's
  `parsePolicySnapshot()` — the same validator the snapshot policy
  source uses. Versioning beyond the `iaaa-authorization-1` version
  string is NOT invented: `beforeRef`/`afterRef` are `version:digest`
  references over canonical snapshot JSON (a reference hash only;
  tamper evidence lives in the audit chain, not the digest).
- **Fail-closed.** An invalid proposal is never created. A failed
  promotion returns the previous active snapshot untouched and leaves
  the proposal `approved` (re-promotion possible without re-approval).
  A corrupt stored proposal or active snapshot fails closed (skipped
  on list / compiled fallback on read).
- **Platform-admin only.** Propose, approve, reject, promote, list,
  preview, and active-read all require platform-admin; tenant admins
  get 403 before any state is touched. The core module takes the
  caller's platform-admin flag as input — it never decides adminhood.
- **Preview before approval.** `POST .../preview` returns the grant
  diff plus the decisions that would change (all role × permission
  probes), evaluated against synthetic memberships — nothing is
  activated by previewing.
- **Audit (tamper-evident, trace-joinable).** Every transition appends
  to the #1760 chained-hash audit store via `recordAuditEvent`
  (type `iaaa.policy`, action `policy.proposed|approved|rejected|
  promoted`, proposal id in `approvalId`, before → after refs in
  `resourceId`, platform scope, proposer/approver attribution).
  Audit order is audit-before-persist: a failed append aborts the
  transition, so no unaudited transition exists. The proposal's
  `correlationId` is carried verbatim (body value, else the request's
  `traceparent` header, else a minted UUID) so the record joins to a
  #2808 trace by that id. No second tracing pipeline is invented.
- **ONE role model.** `ALL_ROLES` from `authorization.ts` only. The
  panel renders whatever roles/permissions the server's active
  snapshot carries; it declares no role or permission list.

## Delivery boundary (read before adopting a promoted snapshot)

The PAP-active snapshot is what the PAP routes and preview evaluate.
This slice does NOT rewire the live PDP: live adoption of a promoted
snapshot goes through the existing platform-only
`IAAA_PDP_POLICY_SNAPSHOT_JSON` switch (#1755), an operator action
outside this slice — so a promotion can never silently flip live
enforcement. The promoted snapshot is retrievable from
`GET /api/iaaa/policy-proposals/active` (source `pap-promoted`).

## Carried question (undecided, NOT silently expanded)

Whether the frozen `OBLIGATION_POLICY` (#1751) is in scope for
editing is undecided. This slice neither reads nor writes it, and no
proposal can carry it. A future slice that opens it needs its own
design (versioning of a frozen, fail-closed table) and owner direction.

## Routes

`GET /api/iaaa/policy-proposals`, `GET /api/iaaa/policy-proposals/active`,
`POST /api/iaaa/policy-proposals/propose|approve|reject|promote|preview`.
Proposals persist in the session store under `iaaa-policy-proposal:<id>`;
the active snapshot under `iaaa-policy-proposal:active`.
