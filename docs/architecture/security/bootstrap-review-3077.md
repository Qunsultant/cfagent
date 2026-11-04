# Bootstrap review (#3077) — the #945 Q3 answer

Q3 of the #945 adoption questions (assurance review §4, R1) asks for a
genesis/bootstrap procedure: who sets `IAAA_BOOTSTRAP_ADMINS`, through
which reviewed channel, what audit event a genesis grant creates, and
the revocation rule for genesis grants. This document records the
answer as built in #3077. It does not rewrite the PROPOSED spec or the
DRAFT assurance review — that is Q11 (spec refresh) territory.

## The answer (four elements)

1. **Who sets the list: the owner, via secrets.** The list lives in
   the `IAAA_BOOTSTRAP_ADMINS` env var, set through GitHub repo
   secrets → deploy sync. Nobody else can set it, and no code path
   writes it: the UI manages proposals/approvals/audit, never the
   env var itself.
2. **Channel: reviewed, via the UI — post-genesis.** Owner decision
   2026-11-04: the bootstrap channel is a REVIEWED channel, not
   owner-only-via-secrets. The flow is propose → approve → confirm
   application (see below). **Genesis exception:** the FIRST
   platform admin cannot be UI-approved — no reviewer exists yet —
   so initial genesis stays owner-via-secrets + audited.
3. **Audit event for a genesis grant: present already, verified.**
   Wired-login genesis/bootstrap grants emit durable audit events
   through the #1760 chained store: `iaaa.genesis.grant` (actor
   `system:bootstrap-genesis`) and `iaaa.bootstrap.grant` (actor
   `system:bootstrap`), with the granted user as initiating
   principal — granter attribution, never self-attribution. This is
   pinned by `tests/audit_coverage_1760.test.ts` (genesis grant
   emits a distinct genesis event; non-occurrences emit nothing)
   and wired at every server callback site that passes an audit
   store. Two honest limits, kept as design: the seam is
   best-effort (a failed write warns, never blocks a login — the
   post-login contract from #1760), and whether login belongs in
   Q7's audit blocking set is Q7's decision, not this slice's.
   This slice added no genesis audit event because none was
   missing. The NEW proposal flow audits every transition
   (proposed / approved / rejected / applied) through the same
   chained store, audit-before-persist: a failed append stores
   nothing, so no unaudited transition exists.
4. **Revocation rule: removal retains until explicit revoke.**
   Recorded default for owner correction: removing an identifier
   from the list does NOT drop an existing membership — it stays
   until explicitly revoked through the revoke path. The current
   view surfaces the divergence (bootstrap-granted members no
   longer listed, with roles and granter), and a remove proposal
   records the retained membership when one exists, so the UI
   states plainly what survives the removal.

## The reviewed flow

- **Propose** (platform-admin only): an add or remove of one list
  entry (UUID, derived `v1:` id, or `issuer:subject`, optionally
  `platform:` prefixed), with a required reason. Malformed
  identifiers, adds of already-listed identifiers, and removes of
  non-listed identifiers are refused. A proposal is inert.
- **Approve** (platform-admin only): proposer ≠ approver by
  default. Self-approval only with a named exception reason
  recorded on the proposal and audited — the single-admin case is
  that exception, not a bypass. Approval changes nothing by itself.
- **Confirm applied** (platform-admin only): after the operator
  changes the list through the secrets channel, they confirm here
  with an optional application note, closing the
  proposal → approval → application trace.
- **Reject** (platform-admin only): a proposed proposal only.
- Denials are audited (`bootstrap.access_denied`) and returned as
  403 before any state is touched. Corrupt stored proposals are
  counted as skipped, never served.

## Effect notes (do not misread the list)

- After genesis, a `platform:` entry grants tenant-admin only (the
  genesis-closed path) — it does NOT mint a second platform admin.
  Platform-admin grants go through Role grants (#2688), never
  through this list. The panel says so.
- A removed identifier's member keeps working until revoked. The
  panel shows the retained membership; it does not offer a
  one-click "remove + revoke" — revocation stays an explicit,
  separate, audited act on the revoke path.

## Files

- Pure core: `src/security/bootstrapProposals.ts` (proposal
  workflow, divergence helper, audit input builder, memory + KV
  stores — mirrors `src/security/policyProposals.ts` without
  duplicating it).
- Routes: `src/server.ts` (`/api/iaaa/bootstrap-proposals`,
  `/current`, `/propose`, `/approve`, `/reject`,
  `/confirm-applied`; session-gated, platform-admin-only).
- UI: `src/client/BootstrapProposalsPanel.tsx` +
  `src/client/bootstrapProposalsApi.ts`, mounted on IAAA Admin →
  Overview beside Policy proposals (no new tab); catalogued in
  `src/client/iaaaEndpointCatalog.ts`.
- Tests: `tests/bootstrap_proposals_3077.test.ts` (core, TDD Red
  first), `tests/bootstrap_proposals_panel_3077.test.tsx` (panel).

## Carried items (not dropped)

- Moving the list out of the env var into an app store is a
  separate architectural decision, not this slice. The reviewed
  flow is designed to survive it (proposals already carry
  action/identifier/reason/approval; only the application step
  would change from confirm-after-secrets to apply-in-app).
- Whether login belongs in Q7's audit blocking set (i.e. whether a
  failed genesis-audit write should ever block a login) is Q7's
  decision. Today it warns and never blocks, per #1760.
- The single-admin self-approval exception and the removal-retains
  rule are recorded defaults for owner correction (issue #3077).
