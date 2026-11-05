### Fixed
- Fixed Alpaca sign-in CSRF rejection (`csrf_invalid` / HTTP 403) on connect and disconnect by sending `...csrfHeaders()` on mutation requests from `AlpacaSignInCard` (#3401).
- Synchronized `AlpacaSignInCard` with active execution mode: `ETradeDynamicMenu` passes `activeEnv`, the card subscribes to `useBrokerEnvironment()`, and status reads and sign-in requests query with the effective environment (`TEST` for paper, `PROD` for live) (#3401).
- When no user keys or secrets are specified by the user, deployment keys and corresponding base URLs are used for both paper and live execution in `AlpacaTradingPlatform` and `AlpacaMarketDataProvider` (#3401).
