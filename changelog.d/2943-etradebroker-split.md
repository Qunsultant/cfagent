### Changed

- Refactor (#2943): split portfolio-risk and positions tails out of `src/agents/routes/etradeBroker.ts` into `src/agents/routes/etradeBrokerPortfolioRisk.ts` (moves only, no behaviour change). Dispatcher falls from 51,172 B to under the 50,000 B target; route conditions, auth prologues, and `ETradeService` construction stay in the dispatcher.
