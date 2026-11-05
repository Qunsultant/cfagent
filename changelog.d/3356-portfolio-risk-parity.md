### Changed
- Portfolio risk follows the selected broker. The hub renders the risk panel whenever the broker catalogue declares `portfolioRisk` (as it always did for Alpaca, #3324) instead of checking for the E*TRADE name, and passes the broker down; the panel reads `/api/broker/portfolio-risk*` for any non-E*TRADE broker so the report, post-trade evaluation, concentration and sizing run on that broker's own book and Greeks.

### Fixed
- An Alpaca tenant is no longer told "portfolio risk analytics are not available for this broker" while the platform declares the capability and serves the route. The notice now appears only for a broker that genuinely declares no risk model, and it no longer claims the panel reads E*TRADE data.

### Notes
- E*TRADE behaviour is unchanged: same routes, same sections, same numbers. Moving E*TRADE onto the neutral route needs its own equivalence proof and is not part of this change.
- Hedge proposals, repair proposals, recommendation bundles and the trade guardrail check stay E*TRADE-only. For another broker they are named as unavailable and are never requested — a call that cannot succeed is not a state a user should see.
