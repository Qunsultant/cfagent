### Changed
- Stock Hub no longer falls back to the first screening variant when the tenant's configured data provider has no hub variant: the run is blocked with the coded `NO_SCREENING_PROVIDER_FOR_TENANT` message instead of posting to a substituted endpoint.
- The broker gate's 409 body now carries an `error` field with the coded message, and the client maps 409 `FAILURE_BROKER_UNAVAILABLE` to the business message with a switch-to-Yahoo action instead of the generic 409 text; `message`-only error bodies are read at every screen call site.
- Docs-only: no code and no behaviour change (re-trigger commit to re-run CI after the ready flip so the merge-queue enqueue fires).
