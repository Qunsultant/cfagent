### Renewal identity test: seed inside the midnight-ET expiry window (#2589)

- `tests/token_identity_s3_2442.test.ts` seeded the token one hour in the past and expected renewal. E*TRADE tokens expire at midnight ET (`isTokenExpiredEt`), so between 00:00 and 01:00 ET the seed crossed the boundary, the pass correctly skipped it, and the required `Test & Build` check failed for every PR. The seed is now one minute old, with the window named in a comment. Test-only; no production behavior changes.
