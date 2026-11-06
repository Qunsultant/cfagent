### Added

- Monthly + annual subscriptions (#3357): plan price approval (new plans land PROPOSED; operator approves via POST /plans/approve; every charging path refuses an unapproved plan with 402), annual price derivation from a monthly plan at the operator-managed annual discount (PROPOSED seed 15%), and per-user-within-tenant scoping pinned by tests.
- Plan/annual/discount outcomes are outcome-catalog codes (AOP, #3357): 8 new commercial entries resolved through the single resolver (successes + failures incl. the 402 unapproved-price refusal); annual prices derive as decimal USD rounded to cents at the derivation; a replayed plan create (same id) is a 409.
