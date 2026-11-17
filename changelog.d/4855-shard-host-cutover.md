### Added

- **Shard executor's options scans dispatch through the strategy workflow host (#4855):** each per-symbol options shard now runs through `startStrategyScreenWorkflow` when the gate holds — the chain's recorded (broker, mode) pair validates (the recorded mode wins, per #3655; an unrecorded mode derives from the recorded broker + the chain's environment) and the residency bindings are configured. No universe input is stamped: a shard scan is symbol-scoped, so the residency rebuild constructs the screener without deps, exactly as the in-process shard does. Gated-out shards (no recorded broker, an unrecognized broker, or unbound residency) stay on the unchanged sync dispatch, and the skipped-verdict retry contract applies to both dispatches. Stage-boundary messages publish through the residency's queue wiring (#4851); host-path shards record over the residency's durable stores, so per-stage control from the copilot turn awaits #4859.

### Fixed

- **Scanner clock accepts the ISO string a stored request round-trips it to (#4855):** the `now` scan option is now `Date | string`, normalized once at each consumption site — the D1 job definition store JSON-serializes the dispatch request, so a hosted run's `now` arrives as a string, where the sync path's closure-read request always carried a Date.
