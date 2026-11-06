### Added

- Outgoing rate limiting for E*TRADE, Alpaca, and LLM clients (#3515 S1): a token-bucket limiter built on the incoming `checkRateLimit` primitive, wired at each client's central request seam with conservative 120 req/min defaults, per-connector env overrides (`ETRADE_OUTBOUND_RPM`, `ALPACA_OUTBOUND_RPM`, `LLM_OUTBOUND_RPM`, `OUTBOUND_RATE_LIMIT_MAX_WAIT_MS`), and a bounded wait (default 10s) before a typed `OutboundRateLimitError`. Incoming throttling is unchanged.
