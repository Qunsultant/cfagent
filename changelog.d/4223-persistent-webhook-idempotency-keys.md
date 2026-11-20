### Fixed

- The schedule webhook now claims a persistent idempotency key in durable storage before minting a follow-up, so a re-delivered webhook is rejected with 409 instead of minting twice — even after the edge nonce expires. Spent keys are retained 30 days (env-overridable) and pruned best-effort on mint.
