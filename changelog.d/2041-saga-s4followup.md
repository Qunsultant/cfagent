### Fixed

- **Forward the journey refusal reason on saga audit rows (#2041)** — the saga audit forwarder now maps `refusalReason` into the forwarded payload, so `saga.journey_decision_refused` rows keep their reason instead of dropping it.
- **Correct the saga mesh registry role string (#2041)** — it no longer says the trading leg is stubbed; it describes the completed four-leg journey through the trading leg.
