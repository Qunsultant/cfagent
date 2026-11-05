### Fixed

- **Alpaca declares and performs stock screening (#3325, programme #3292):** `marketScreening: false` recorded a fact about the vendor ("Alpaca has no screener API") as if it were a fact about the platform. The screening math is ours (#3272) and the only broker input is quotes, so `AlpacaTradingPlatform.screenMarkets` now runs `NeutralMarketScreener` over the adapter's own quote read — the same engine E*TRADE uses, resolving the named universe through the live listings feed and reporting every unreadable symbol by name. The catalogue says `true` for both brokers, and the pin that requires a declaration to match the methods the adapter actually exposes stays satisfied.

#ceo-aimp
