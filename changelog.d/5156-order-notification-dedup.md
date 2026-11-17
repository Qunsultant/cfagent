### Fixed
- Added `(orderId, status, channel)` idempotency deduplication in `notifyOrderExecution` (`src/services/orderExecutionNotifier.ts`) so duplicate relays or retries never post duplicate Slack alerts for the same order (`#5156`, `#5154`).
