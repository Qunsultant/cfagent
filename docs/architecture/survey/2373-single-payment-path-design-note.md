# Design note — #2373: all screeners follow the same payment path

**Question from Mars (2026-11-03): "is your solution a stage in the workflow?"**
**Answer: YES.** The payment solution is the **admission/gate stage at submission**
(submit → gate → payment-or-coverage → screener), sitting **before** the pipeline
stages (schedule → queues → feed → gather → store → serve → deliver, per
`docs/architecture/business/screener-workflow.md` and #1904's target DAG).
#2373 makes every screener entry point pass through that same stage. It is not a
parallel pipeline, not a new engine, not a new gate, not a new workflow.

## 1. The stage, and where it slots

```
entry (route / tick / door)
  → spec validation + mode admission (ND 400 stays FIRST, #2530)
  → [PAYMENT STAGE — this issue]  flag → identity → coverage-or-payment → verified start
  → pipeline stages (broker / planner / chain / runScreen / deliver)
```

- The stage already exists as one funnel: `src/services/paidScreenSubmission.ts`
  (`resolvePaidScreenAction` + `resolvePaidScreenAccount` + `buildPaidScreenSubmission`
  + `startPaymentWorkflowViaBinding`). The payment workflow instance id IS the run
  request id, so a retried submission never double-starts or double-charges.
- Current stage users (pattern to copy): goal route
  (`src/agents/routes/screenerResearch.ts` ~1591–1660), goal ticks
  (`src/services/scheduledTasks.ts` ~1600–1760), mesh doors
  (`src/agents/orchestrator/meshScreenDoor.ts` ~797–817, `nlqPorts.ts` ~688–702).
- The stage is a **Facade** (GoF) over the gate (**Guard/Policy**) and the
  deterministic PaymentWorkflow state machine; ports/adapters are **Hexagonal**
  (ADR 0002); the broker is the GRASP Controller/Pure Fabrication for execution.
  No `step.prompt()` in the money path; approval waits only via `waitForEvent`
  (already true inside PaymentWorkflow; routes/ticks never prompt).
- Fifteen-factor mapping: API-first (the seam is the API boundary); telemetry
  (an audit event for every gate decision — `payment_started`, `skipped_uncovered`,
  never a silent refusal); auth (session-scoped identity, below); externalized
  config (prices live in the operator catalogue, never code constants — route code
  does not read prices at all; the workflow gate checks them, #2547).
- AOP (#2868): payment failures flow through `classifyScreenFailure` /
  `logScreenRunEvent` and the existing audit events. No bespoke logger, no new
  aspect. The #2868 map's `paidRun` join-point entry currently names chat paths;
  after #2373 it names the seam as the same join-point family (a naming
  extension, not a framework).

## 2. What is reused vs newly written

| Reused (never rebuilt) | Newly written in #2373 |
|---|---|
| `paidScreenSubmission` seam (gate → workflow → screener) | The payment-stage call site in each stock route handler, placed after spec validation + mode admission, before the async/sync fork |
| `buildParentScreenCommand` (#2914 G7, one parent command builder) + `shardsForUniverse` (#2867) + `manualWorkflowJobId` | One pure extraction: `buildStockScreenWorkflowCommand(spec, deps)` from the broker's `startStockScreenWorkflowOrNull` mapping (spec → builder inputs), used by both the broker and the seam path. Behavior-preserving; broker tests must pass unchanged |
| Goal-route call shape (flag check → binding 402 → email 400 → adapters 503 → account → submit → payment_started / 503 on start failure) | Stock-route call sites mirroring it exactly |
| Goal-tick decision shape (`resolvePaidScreenAction` with `trigger: "scheduled"`, skip-audit-return) | Scheduled-stock tick decision, adapted for chains (below) |
| `resolvePaidScreenAccount` / `resolvePlatformIdentity` (never re-derive tenant/tier/credits) | Nothing identity-related |
| CAIO #2547 price-approval state (gates refuse unapproved prices fail-closed, inside the workflow gate) | Nothing price-related at route level; ticks read the catalogue price and fail closed on missing/invalid/unapproved, mirroring the goal tick |
| CAIO #2549 refund/failure-credit XOR guard | Nothing (the workflow already carries it) |
| #2405 Phase 2 surfaces (Billing, tenant isolation #2664, refunds #2662) | Nothing |
| Commercial adapter ports `consumeIncludedRun` / `consumeCredits` (the workflow's `consumeCoverage` dep is exactly these two calls) | Tick-side covered-branch consumption via those same ports (see §5) |
| Existing pins/tests | New test files per slice only; existing pins untouched unless the change alters one, in which case the pin is updated in the same PR with a renamed test + comment explaining scope (#2306 pattern) |

## 3. Design decisions (binding on all slices)

1. **Tenant source parity with the goal route.** `tenantId` comes from
   `workflowTenantId(ctx.env)` (= `resolveIaaaTenant(env)`), `userId` from the
   session-verified `x-user-login` header (server.ts sets it from the verified
   session and never trusts a caller-supplied value). Client tenantId is never
   read anywhere. This keeps one tenant source across entries; changing the
   tenant source would diverge goal vs stock behavior and belongs to a
   platform-identity follow-up, not #2373. Free-path no-account scoping stays
   session-login-only (#2231); paid-path no-account is refused by the workflow
   gate (missing store row → Free account via `resolvePaidScreenAccount`, then
   the gate refuses) — same as the goal route.
2. **Checkout email required under flag ON, mirroring the goal route.**
   `buildPaymentWorkflowParams` throws unless userId, email, tenantId are all
   non-empty. Stock routes accept `email` from the POST body or the GET query
   param; missing → 400 (same wording as the goal route). Under flag OFF no
   email is needed and behavior is unchanged. No UI change is in #2373 scope;
   the 400/402 responses surface the requirement (fail loudly, never silently).
3. **Gate before the fork, no fallbacks under flag ON.** Under flag ON the seam
   path returns before the async/sync fork: no sync fallback, no broker-null
   fallback. Payment-workflow start failure → 503 with no run started (goal-route
   rule). Under flag OFF today's behavior is exactly unchanged (broker-or-sync,
   including broker-null → sync). The job id for the seam submission reuses the
   broker's derivation (`spec.jobId ?? manualWorkflowJobId(universe)`) so a
   retried submission adopts the same payment-workflow instance.
4. **Route tests assert the seam contract, not the workflow's internals.**
   Flag ON + uncovered → payment workflow submitted with a verified command,
   no screener started, no scan (the workflow's own gate refusal is covered by
   existing payment-workflow tests; it is not re-tested at route level).
   Flag ON + no workflow path (binding unbound) → the goal route's 402.
   Flag OFF → unchanged behavior. Covered → `payment_started` with the verified
   command handed to the workflow.
5. **Listings branch excluded by placement, not by exception.** The payment
   stage sits after spec validation AND after the `/etrade/screen` listings
   branch (which returns before spec building). Listings is not a screen run
   (audit-only, persists nothing, #2999 follow-up treats it separately), so it
   never reaches the stage. This is structural, stated here so it is not read
   as a bypass.
6. **Premium stock-signals is already paid — verified, not assumed.**
   `handleGatedEndpoint` (`src/services/agenticPayments.ts`, class
   `ETradeAgenticPaymentService`) never consults the monetization flag: it is a
   flag-independent x402/MPP gate, and both the async and sync branches run
   inside `fulfill` behind verified payment (402 otherwise). There is no unpaid
   bypass in premium today, in any flag state. Forcing premium onto the seam
   would replace a working paid path, discard #2408 metering / #2522 tier audit,
   and break anonymous payer-bound traffic (the seam requires a verified login
   + email + account row; anonymous traffic has only a verified payer scope).
   Slice B therefore verifies the unconditional wrap with tests and reports the
   seam-unification question as an owner decision — it does not re-route
   premium. Premium's sibling handlers (`/premium/options-scan`,
   `/premium/market-research`) are other families' entries, out of #2373 scope.
7. **Scheduled stock chains cannot ride the payment workflow — by design.**
   Scheduled stock runs execute as CHAINS (`autonomousMarketScreenSharded` via
   the broker's `startScheduledShardedChain`; nasdaq → etrade → yahoo → assemble
   → pdf/xlsx/csv), not as ScreenerScreenWorkflow runs, and CLO G7 explicitly
   rejected migrating them onto the workflow. The tick design is therefore a
   payment DECISION at the tick, not a workflow start (mirror the goal tick):
   flag ON → catalogue stock price (fail-closed throw on missing/invalid/
   unapproved, mirroring the goal tick) → account → `resolvePaidScreenAction`
   with `trigger: "scheduled"` and the schedule's `scheduleKind`
   (absent → fail-closed to recurring) → skip audits and returns a skipped
   result (no chain, no workflow) OR covered → consume via the adapter ports
   (§5) and run the chain as today. One-off authorized stock chains cannot
   checkout (no workflow to start) — that limitation is documented, not papered
   over, and is NOT filed as a cross-lane demand for the G7-rejected migration.
   The #2373 slotting question vs #2041/S3 remains Mars's call.
8. **Tick consumption is fail-closed; workflow consumption is best-effort —
   deliberately different.** The workflow's `consumeCoverage` is best-effort
   with loud logging because the run is already paid/covered; denying it would
   harm a paying user. The tick consumes BEFORE starting the chain, when nothing
   is yet paid: a consume failure → skip + audit, never run uncovered.
9. **Schedule-creation guard (POST `/schedules/create` + alias, `schedules.ts`
   ~584).** Under flag ON, for stock-chain callbacks: a payload claiming
   `one_off` without `authorizedAtSubmission` → 400 (cannot claim authorization
   never given); a payload claiming `one_off` WITH authorization → 400 with an
   honest explanation (one-off checkout is unavailable for chained stock
   schedules — the chain cannot ride the workflow; run manually via the seam or
   use a covered recurring schedule); absent `scheduleKind` → stamped
   `recurring` into the stored payload (fail-closed default, covering legacy
   schedules). Goal-schedule callbacks are NOT 400'd for one_off (goal ticks
   already handle one_off via the seam). The tick reads
   `payload.scheduleKind ?? "recurring"`. NLQ-scheduled screens are a separate
   door and out of slice C unless trivially shared.

## 4. Slice A — manual E*TRADE + market-data routes

- Files: `src/agents/routes/etradeBroker.ts` (handler ~278; dispatcher conditions
  untouched), `src/agents/routes/etradeBrokerScreen.ts` (executor), the broker
  extraction in `src/workflows/screenExecutionBroker.ts`,
  `src/agents/routes/marketDataResearch.ts` (handler ~292).
- Placement: in each handler, after spec validation + mode admission (ND 400
  first), before calling the executor / before the async/sync fork. The handler
  owns request parsing (including the email carrier); the executor stays the
  executor. Verify `executeEtradeScreen`'s callers before placing the stage —
  if it is handler-only, gate in the handler.
- Under flag ON the route mirrors the goal route exactly: flag check →
  workflow-binding 402 (read the goal route's exact condition + error code and
  copy it) → email 400 → commercial/subscription adapters (503 if unbound) →
  schema ensure (as the goal route does) → `resolvePaidScreenAccount` →
  command via the extracted builder → `buildPaidScreenSubmission` with
  `family: "stock"`, `trigger: "manual"` → `startPaymentWorkflowViaBinding` →
  audit `payment_started` (etrade: `etrade.screen_payment_started`;
  market-data: `market_data.screener.payment_started`) → return
  `{ runRequestId, workflowId, status: "payment_started" }` (goal-route shape).
  The payment workflow starts the screener workflow under the same run request
  id after payment/coverage; the route does not await it (goal-route parity).
- No catalogue price read at route time (the workflow gate checks prices,
  #2547). No broker call under flag ON. No change to the listings branch, the
  `ALL`-shard sync path, or any flag-OFF behavior.
- Tests (new file `tests/paid_screen_stock_routes_2373.test.ts`): per route —
  flag ON + uncovered → payment workflow submitted with verified command, no
  screener, no scan; flag ON + no binding → 402; flag OFF → today's behavior
  (broker-or-sync incl. broker-null fallthrough); covered → payment_started
  with verified command; ND + flag ON → command carries screenMode, no sync
  fallback. Follow the harness in `tests/paid_screen_submission_2186.test.ts`
  and the mesh paid suites for flag control + binding stubs.

## 5. Slice C — scheduled stock ticks + creation guard + goal-tick price test

- Files: `src/services/scheduledTasks.ts` (stock ticks + goal tick),
  `src/agents/routes/schedules.ts` (creation handler ~584+).
- First map ALL stock tick callbacks from the task registry + 
...[truncated 4164 chars]