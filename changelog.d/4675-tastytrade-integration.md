### Issue #4675 — Tastytrade integration Slice 1 (Gap 21)

- Added `src/config/tastytrade.ts` externalizing Tastytrade sandbox (`api.cert.tastyworks.com`), live (`api.tastyworks.com`), `User-Agent`, refresh margin (60s), and timeout settings.
- Added `src/trading/tastytrade/credentials.ts` porting the OAuth2 personal refresh-token grant (`grant_type=refresh_token`, proactive refresh, rotated `refresh_token` adoption, zero-secret error/JSON handling) and per-user `SessionStore` DO storage (`verify-before-store` via `GET /customers/me/accounts`).
- Added `src/trading/tastytrade/platform.ts` (`TastytradeTradingPlatform` implementing `ITradingPlatform`) and registered `"tastytrade"` in `BROKER_CATALOG`, `brokerPresentation`, `tenantProviders`, `config/order-capabilities.json`, and `TradingPlatformRegistry`.
