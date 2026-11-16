### D1 retry policy (#4930)

Transient D1 failures (lock contention, timeouts, transport faults) are now retried at the DML executor boundary by one shared helper, `withD1Retry` — at most 3 attempts with 100ms doubling backoff, a coded `SCHEMA_RETRY_EXHAUSTED` error when the budget runs out, and an explicit idempotency gate (ADR 0033 R-1) so an ambiguous failure never re-issues a non-idempotent write.
