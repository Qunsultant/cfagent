# #764 P0 remainder verification — audit & enforcement integrity

Parent program: Qunsultant/cfagent#764. Slice issue: Qunsultant/cfagent#2927.
Verified 2026-11-02 against current main (base `db9a0bea`; evidence files
re-checked on that head after the `b3977ce7 → db9a0bea` advance, which
touched none of the cited evidence files except refund sections of
`src/services/agenticPayments.ts`, unrelated to the MPP-payer function
cited below). This record verifies; it does not close anything — the
close-out pass is later, per the 2026-11-02 sequencing override.

## #700 residual — shipped

| #700 point | Current main | Pin |
|---|---|---|
| persistAudit | `src/mcps/scanner/cloudflareWalletsScanner.ts` `persistAudit` POSTs `/api/audit/event` through the orchestrator channel into `recordAudit()` (the single owner of `mas_events` inserts, #270). It never rejects, so a failed audit write never fails the paid scan, but it always logs explicitly with the event id — no silent swallow. The old `new DatabaseORM(this.ctx.storage)` construction is gone. | `tests/scanner_persist_audit_reroute.test.ts` |
| Session affinity, not identity | `src/server.ts` `/mcp/scanner` route: `x-scanner-session` is the honest header; `x-user-id` is a DEPRECATED alias retained only for instance continuity (same literal value → same instance). No identity propagates downstream from either header. | `tests/scanner_session_affinity.test.ts` |
| MPP payer binding | `src/services/agenticPayments.ts` `verifiedMppPayer` recovers the payer DID from the verified credential (`Credential.fromRequest` after charge success, cryptographically bound by the tempo verifier); the pooled `mpp-credential` identity survives ONLY where no payer is exposed (source-less, unparseable, or undeserializable credential). | `tests/agentic_payments_mpp_payer_binding.test.ts` |

Stale branches `fix/700-mpp-payer-binding`, `fix/700-persist-audit-reroute`,
`fix/700-scanner-affinity`, `fix/700-scanner-residuals` still exist on
origin. They are branch-hygiene leftovers, not live claims for this slice
(no open PR rides them, and their content is superseded by the merged
fixes above); they were recorded, not deleted, in this slice.

## #143 / #237 P0 reconciliation — shipped, with two noted remainders closed by code

#237's P0 checklist is all `[x]`, and its two P0-2 sub-remainders have
since shipped as well:

- Inbound replay cache: `src/security/webhookReplay.ts` plus the
  TradingView/E*TRADE nonce-claim path in `src/services/tradingWebhooks.ts`
  (replay → 409). Slack verification keeps its 5-minute timestamp window
  (`src/security/webhookSecurity.ts`).
- Email domain allowlist: `EMAIL_TO_ALLOWED_DOMAINS` via
  `validateEmailRecipient` (`src/security/webhookReplay.ts`), wired in
  `src/server.ts`, `src/agents/orchestrator/researchPublish.ts`, and
  `src/services/screeningDelivery.ts`. Format is always enforced; the
  domain list itself is owner-supplied configuration — supplying the
  domains is an owner action, not a code gap.

Other #143/#237 P0 items: NLQ bound parameters pinned by
`tests/nlq.sql-injection.test.ts`; outbound SSRF guard; rate limiting;
gitleaks in CI (a required check). #237's P1/P2 lines (lint config,
separate-worker option, cross-channel threat model, confirmation drawer +
PII redaction, XLSX queue) are TRUE remainders of #237, not of this P0
slice — recorded here, not rebuilt here, and #237 is NOT closed by this
slice.

## #290 remainder — COMPLIANCE.md open questions carried

The #290 deliverables shipped: `src/trading/index.ts` as the sole import
boundary (enforced by `tests/trading-boundary.test.ts`) and
`docs/COMPLIANCE.md` with a names-only secret inventory. Its §7 open
questions were refreshed in this slice (see `docs/COMPLIANCE.md` §7):
Q2 resolved (owner revoked/rotated the Alpaca keys 2026-10-25; only the
separate history-purge decision is pending), Q1/Q3/Q4/Q5 still open as
owner decisions. The lane answered none of them.

## What this slice did NOT do

- No code-path, endpoint, or behaviour change anywhere.
- No issue closed (#764, #237, #290, #700 all keep their current state).
- No production switch value set; no secret created; no owner question
  answered by inference.
