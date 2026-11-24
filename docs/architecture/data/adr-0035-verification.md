# ADR 0035 (PR #6140) — verification of the two open flags

Checked 2026-11-22 ~18:20 UTC against main tip `16d39b51`
(worktree `~/workspace/wnorm/wt`, the same tip the 3NF survey used).
PR #6140 was open, not merged, at 18:08 UTC the same day; re-check its
state before using this at the #6101 design check.

## Flag 1 — "platform-id comes from the platformIdentity service"

**Confirmed as a gap, not a contradiction yet.** The ADR is a proposal
in an open PR; the code has no platform entity for it to draw on.

- `src/services/platformIdentity.ts` — the `PlatformIdentity` interface
  (lines 193–212) carries `userLogin`, `tenantId`, `currentTenantId`,
  `currentTenantSource`, `candidateMembershipTenants`, `hasAccount`,
  `tier`, `creditsUSD`, `includedRunsRemaining`, `stored`. There is no
  `platformId` field, and the file contains zero occurrences of the
  string `platformId`.
- The module header (lines 21–22) states the identity source explicitly:
  "the commercial and subscription ports ARE the platform identity
  source in this slice; later platform slices may add a dedicated
  identity port behind this same shape." Identity is resolved from a
  commercial account row + IAAA memberships + subscriptions
  (`resolvePlatformIdentity`, lines 229–270); a missing row resolves to
  `tenantId: null`, never a guessed value.
- `src/data/drizzleSchema.ts` — no `platforms` table and no `platform_id`
  column anywhere. (Consistent with the 3NF survey: no `tenants`/`users`
  master table either.)
- The only `platformId` values in `src/` are broker/provider ids:
  `platformId: "etrade" | "alpaca" | "sandbox"` (`src/trading/agent.ts:25`)
  and per-provider consts (`"tastytrade"`, `"public"`, `"alpaca"`,
  `"etrade"` in `src/trading/*/platform.ts`).

**Design-check question for #6101:** either the ADR must define a new
platform entity / master table (which is #6113 S6 territory — the
identity-linking design the user asked for on 2026-11-22), or "platform-id"
must be clarified to mean the tenant id already resolved by
`resolvePlatformIdentity`. It cannot be read off the service as written.

## Flag 2 — "the write uses Drizzle ORM transactions"

**Confirmed: as written, that wording trips the pin.** The D1 atomic
primitive is `batch()`, not `db.transaction()`.

- `tests/d1_transaction_pin_4937.test.ts` (issue #4937) — conformance pin,
  zero-tolerance in CI: any `.transaction(` call in `src/` whose receiver
  is not the DO storage API (`storage`) fails. Header: "drizzle-orm/d1
  implements `db.transaction()` as sequential BEGIN/COMMIT statements,
  which is not Postgres-equivalent atomicity."
- `src/aspects/transactionAspect.ts` header — "`db.transaction()` is never
  used (sequential BEGIN/COMMIT, not atomic — migrationRunner header,
  ADR 0002)." D1 leg (`D1BatchTransactionBackend`) buffers statements and
  applies them with ONE `batch()` call; DO leg uses
  `storage.transactionSync`.
- The correct spelling for ADR 0035's "one D1 transaction" is therefore
  the transaction aspect (`withTransaction`, `src/aspects/transactionAspect.ts`,
  issue #2288) over the D1 batch backend — not a Drizzle `db.transaction()`
  call.

**Caveat the design check should carry:** the aspect's own header states
it "is exercised only by the proof pins in
`tests/transaction_proof_2288.test.ts`. No production surface consumes it
yet." A #6101 D1-first write routed through it would be a first production
consumer (or the design routes through `batch()` directly). Either way the
ADR's transaction wording needs that correction before the build starts.

## What this does not settle

- The ADR 0035 text itself was not re-read here; the two claims above
  are as summarised in the 2026-11-22 18:08 UTC chat reply and memory.
  Read PR #6140's body at the design check and match its exact wording
  against these findings.
- PR state (open vs merged) was last checked 18:08 UTC 2026-11-22.
