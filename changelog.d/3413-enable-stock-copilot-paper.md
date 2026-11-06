### Changed

- Stock Copilot paper trading is enabled in production (issue 3413): `STOCK_COPILOT_PAPER_ENABLED` is now set to "1" in the production Worker vars, so the pattern-driven paper-trading loop (issue 3391) is live — it declares itself only on instances holding a screener execution context, trades Alpaca paper only (its guard refuses any live Alpaca configuration), and runs over the default universe SPY/QQQ/AAPL/MSFT/NVDA unless `STOCK_COPILOT_UNIVERSE` is set. First cycles run at the next ET market open. Rollback is unsetting the var and redeploying.
