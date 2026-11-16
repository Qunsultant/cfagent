### Forbid drizzle db.transaction() on D1 by conformance pin (#4937)

Adds `tests/d1_transaction_pin_4937.test.ts` to the `test:pins` suite: any `db.transaction()` call in `src/` now fails CI, with an allowlist for the documented comment mentions and the DO `storage.transaction` API; the failure message names the correct primitive (`batch()` / the transaction aspect, `src/aspects/transactionAspect.ts`). The pin is recorded in `docs/architecture/code/14-cross-cutting-aspects.md` (Q3).
