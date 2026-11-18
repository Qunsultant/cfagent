### Fixed

- **The scheduled options seam no longer surfaces uncoded failures (#5231):** a run that died on the Alpaca path reported `Error: internal error` — a raw provider/RPC string, unclassifiable in the alert and the run record. `ensureCodedOutcome` now passes an existing `[FAILURE_…]` through untouched and wraps anything else as `FAILURE_UNEXPECTED_ERROR` with the broker and the raw text kept as detail; the audit row keeps the original message. Alert and record now agree on a code.
