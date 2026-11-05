### Trial subscriptions (#3243)

- Plans now carry an operator-set trial length (`trialDays`, migration 0041; null means no trial) — no trial length or run count is hardcoded.
- Added a $0 trial checkout (`POST /subscription/trial`) that creates a trialing subscription with no Stripe charge and grants the plan's included runs to the account, so a trial user can actually run screens.
- Added a trial signup entry in the Selling section (pick a trial plan, start a free trial) with the trial terms shown up front.
- At trial end the tier lapses via the existing unexpired-row reads and the user gets an outcome-encoded message pointing at the subscribe / pay-per-run fallback.
