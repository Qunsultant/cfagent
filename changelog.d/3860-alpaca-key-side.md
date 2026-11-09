### Fixed

- **Alpaca paper requests now use the paper key pair (#3860):** the provider preferred `ALPACA_LIVE_API_KEY` over `ALPACA_PAPER_API_KEY` unconditionally, so a paper call sent the live key to `paper-api.alpaca.markets` and Alpaca returned 401 ("Alpaca rejected the order"). Selection now follows the trading side (`ALPACA_TRADING_TYPE`, then the base URL; unset = paper), with legacy keys as fallback. Pinned by `tests/alpaca_key_side_3846.test.ts`. #rsi
