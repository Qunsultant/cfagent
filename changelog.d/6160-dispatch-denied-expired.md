### Fixed

- Scheduled dispatches denied for an expired membership no longer report `OWNER_MEMBERSHIP_REVOKED`: the run gate now denies as `OWNER_MEMBERSHIP_EXPIRED` when memberships exist but none is revoked and every binding expired, and the audit detail names the latest binding expiry (or the revoked membership and its revocation time for a genuine revocation). The deny itself is unchanged — expired still denies.
- The orchestrator schedule callbacks (`autonomousMarketScreen`, `autonomousGoalScreen`, `autonomousOptionsAnalysis`, `autonomousStrategyDiscovery`, `collectIvHistory`, `runWorkflowStage`, and the operations callbacks) now classify into their family kinds in the run ledger, so a denied Stock dispatch is visible under `kind=stock` instead of landing in "other".
