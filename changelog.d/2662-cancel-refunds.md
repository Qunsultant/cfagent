### [#2662] Cancellation/refunds per owner-decided policies (Phase 2.7)

- Refund policy owner approval, per kind, fail-closed: `approvedKinds` /
  `approvedBy` / `approvedAtMs` on the refund policy (migration 0036),
  operator-only `POST /payments/agentic/commercial/refund-policy/approve`,
  request and execution refuse unapproved kinds with 422, and any value
  edit resets approval (never silently-still-approved). The refund-policy
  GET now reports real approval state instead of a hardcoded proposed flag.
- Billing immediate cancel: the cancel route follows the operator billing
  policy's `downgradeTiming` — `immediate` DELETEs the provider
  subscription and truncates local access (Billing rows and repurchase
  rows); `period_end` (or an unreadable policy) keeps at-period-end
  behavior. The response and audit carry the applied timing.
- Provider plan change: operator-only, flag-gated `POST
  /payments/agentic/commercial/subscription/billing-change-plan` sends
  the operator billing policy's `prorationBehavior` to Stripe on a
  provider subscription price update (fail-closed: unmapped plan, same
  price, non-Billing row, and provider failure all refuse).
- Deactivation interaction stated: cancel-at-period-end unblocks the 2.5
  gate (status canceled); an active unexpired subscription still 409s.
