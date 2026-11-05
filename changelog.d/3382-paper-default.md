### Changed
- A first trade is paper, for both brokers (#3382, programme #3292). The deployment's environment (PROD on the live worker) remains the right default for **reads**, but it is the wrong default for an **action**: `POST /broker/order/preview|execute` and the Alpaca sign-in now resolve the mode through `resolveTradeEnvironmentFromSettings`, which returns a tenant's stored choice when there is one and **TEST (paper)** when there is not. Live is an explicit act that persists a selection. Without this, a tenant who had never chosen anything previewed, executed and signed in against the live host on a live deployment.

### Fixed
- The Alpaca sign-in badge and the credential side now agree with the mode an order would use: both read the same resolver, so signing in and trading cannot disagree about paper vs live.
