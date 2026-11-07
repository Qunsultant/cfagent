### Added

- Usage/billing reader in the Billing servicing surface (#2667, monetization Phase 2.12): one read-only, session-bound GET /payments/agentic/commercial/usage-billing plus a Billing tab section showing the caller's usage (metered calls, included-run balance, credit balance) AND billing (subscriptions with periods, renewals, refunds, referral balance) together, with per-row real/simulated/audit provenance. Self-only (no userId parameter); failures are coded catalog bodies, never raw store text; no new tables, no new writes, no money totals across mixed provenance.
