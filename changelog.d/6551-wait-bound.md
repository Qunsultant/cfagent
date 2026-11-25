### Added

- **`waitDefaultTimeoutMs` in the one policy resolver (#6551):** `pipeline.waitDefaultTimeoutMs` / `PIPELINE_WAIT_DEFAULT_TIMEOUT_MS`, settings beating env, default one hour, clamped to the platform's wait ceiling.

### Changed

- **Durable waits are bounded by configuration (#6551):** a `wait.event` stage that declares no `timeoutMs` now runs under the configured bound instead of inheriting the platform's 24-hour maximum. Expiry stays the declared outcome the job branches on, so nothing hangs and nothing stays resident by omission.
