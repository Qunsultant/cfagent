### Added

- Checkout-port guard (#3573): bounded timeout (configurable via `CHECKOUT_PORT_TIMEOUT_MS` / `checkout.timeoutMs`, default 10 s) plus a per-rail circuit breaker (Stripe, x402) on every external payment call the checkout port makes, with jittered backoff. A timeout or an open breaker fails closed with a catalog-coded 503 (`FAILURE_CHECKOUT_PORT_TIMEOUT`, `FAILURE_CHECKOUT_PORT_BREAKER_OPEN`); nothing is charged or credited on either outcome. Breaker state transitions are structured aspect events.
