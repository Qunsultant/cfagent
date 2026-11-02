# ADR 0026: cfpay acceptance decision — contract, options, and recommendation

- Status: Proposed — recommendation recorded, owner decision pending
- Date: 2026-11-02
- Author: #COO-spr9
- Deciders: owner (decision pending — see §6)
- Issue: #2663 (Monetization Phase 2 slice 2.8, under program #2405)
- Acceptance target: #2405 Phase 2 checkbox 7 — "cfpay decision recorded
  (accept as method, accept as channel, or explicitly decline) with
  contract or rationale"
- Related: #1076 (capability origin: "cfpay A2A payment acceptance"),
  #2012 Goal 1 (CBO programme: "Pay-per-run via cfpay"), #215
  (cfpayA2A client), #2019/#2022 (cfpay ledger + revenue),
  #2195 (native gate supersession), #2198/#2146 (native checkout),
  #2694 (2.1 Billing), #2662 (2.7 refunds), #2405 open decisions
  (method-vs-channel)
- Implementing PR: (this slice's PR; main commit, when merged)
- This ADR leaves #2663 open. #2663 stays open until the owner
  records one of the three decisions in §6; only then does #2405
  line 7 tick.

## 1. Context

The question is whether cfagent accepts payment through cfpay's
payments agent (`/a2a/payments` on the cfpay host) — as a tier payment
method (pay-per-use or subscription through cfpay beside direct
gateway payments, landing in the same DID-provenance ledger), as a
separate channel, or not at all. It is an owner decision: #2405 lists
"Whether cfpay A2A acceptance is a tier payment method or a separate
channel" among its open decisions, and #2663 requires the slice to
surface the decision with contract evidence, not default it.

This is not a hypothetical integration. cfagent consumed cfpay
checkout in the cfpay era, then superseded it with native machinery.
The decision is therefore whether to re-accept a path that was
deliberately replaced, and the evidence below is the contract as
published plus that supersession history.

## 2. The contract, as published

Source: the cfpay payments agent's own published agent card,
`https://pay.openaimp.com/a2a/payments/agent-card.json`, fetched
2026-11-02 (public, no auth). Card name: "CFmail Payments Agent" —
"Owns the CFmail payment ledger and the Pay And Process capability:
payments received and sent, Stripe card checkouts, and replay
protection for both rails."

Transport: JSONRPC over A2A `message/send`; the caller sends a data
part `{ operation, ...args }` and reads the data part of the
artifact-update / history. This matches cfagent's existing
`cfpayA2AOperation` (`src/services/cfpayA2A.ts`, #215) exactly,
including its `/a2a/payments` path entry. Write operations require a
bearer token (cfagent: `CFPAY_URL` + `CFPAY_A2A_TOKEN` /
`DASHBOARD_API_KEY_IS_A2A_TOKEN`).

| Operation | Access | Inputs (required) | Notes |
|---|---|---|---|
| `ledger.summary` | read | — | Payments ledger summary |
| `payments.list` | read | direction?, limit? (default 20, cap 100) | List payment records |
| `payments.totals` | read | — | Payment totals |
| `funding.list` | read | limit? (default 50, cap 200) | Recorded brokerage funding movements, newest first |
| `funding.totals` | read | tenantId? | Funding position for the named tenant or the instance's whole book |
| `funding.record` | write | records (FundingRecord array: sourceRef, direction, amount, currency, ts + attribution {tenantId, objectiveId, goal}) | Recording only — "executes no payment, checkout, or transfer"; idempotent on each movement's source reference |
| `payment.process` | write | email, request; claim? XOR card? (one of claim or card required) | "Process a payment request (refuses without a verified claim or card reference)" |
| `checkout.create` | write | requestId, email, request | "Create an x402 checkout" |
| `checkout.status` | read | requestId | "A checkout's status" |
| `checkout.fulfil` | write | requestId, paymentIntentId | "Fulfil a checkout after payment" — paymentIntentId is the Stripe payment intent id |

Confirmation flow, from the card plus cfagent's in-repo record
(`src/services/cfpayLedger.ts`, #2019): `checkout.create` (requestId
== run id as the join key) → payer settles via Stripe → a verified
Stripe webhook is observed → `checkout.fulfil` with the Stripe
payment intent id → the payment is recorded in `mas_transactions`
with gateway `stripe`, deduped server-side (one charge row per run).
cfagent's cfpay-era gate confirmed paid only via
`checkout.status == fulfilled` (`src/services/cfpayMonetization.ts`).

Card disclosures, verbatim in substance: "Write operations are
payment.process, checkout.create and checkout.fulfil; all require a
bearer token. This agent cannot move funds or refund."

## 3. Contract gaps (decisive for the decision)

1. **No amount or currency input on `checkout.create`.** The
   operation takes requestId, email, and a request text/id only.
   cfagent's catalogue prices (stock $0.02, options $0.05, market
   research $0.10 — #2405 item 5, #2694) are NOT transmissible as
   amounts on this path; the price is resolved from the request on
   cfpay's side, opaquely to cfagent. This is the "cfpay
   fixed-amount limitation" that #2195 fixed natively by passing the
   run's catalogue price as the native session amount.
2. **No refund operation.** The card states the agent cannot refund.
   Refunds stay on 2.7's operator-approved refund rail (#2662)
   regardless of this decision — acceptance would not buy a refund
   path.
3. **No webhook operation published.** Webhook/receipt semantics do
   not appear on the card; in cfagent's record they live only in
   comments (fulfil "called only after a verified Stripe webhook").
   There is no published receipt operation beyond `payments.list`.
4. **Payer identity is email + claim/card, not x402 payer-bound.**
   `payment.process` keys on an email address plus a verified claim
   or card reference. It does not carry cfagent's x402 payer-bound
   identity, and the cfpay ledger endpoint predates tenant scoping
   (`src/agents/routes/agenticPayments.ts` route comment) — cfagent's
   2.9 tenant-isolation work (#2664) would have to cover a path
   whose tenancy story is unwritten.
5. **No subscription operation.** Nothing on the card creates,
   manages, or cancels a subscription; 2.1 Billing (#2694) already
   owns subscription checkout, fulfilment, webhook application, and
   billing-aware cancel natively.

## 4. History: consumed, then superseded

- cfpay era: `cfpayMonetization.ts` built the gate on cfpay
  checkout (createCheckout / checkoutStatus, paid only via
  `checkout.status == fulfilled`, 24h checkout TTL in
  `paymentWorkflowFlow.ts`, `paidVia` fallback `cfpay_checkout`);
  `cfpayLedger.ts` (#2019) wrote cfpay-origin rows to
  `mas_transactions` with dedupe; #2022 added the cfpay revenue
  report over those rows.
- Native supersession: #2195 (native gate + CheckoutPort)
  deprecated `CfPayMonetizationGate` / `CfPayCheckoutClient` in
  place, superseded by `src/services/nativeMonetization.ts`, with
  in-flight cfpay runs draining — explicitly "fixing the cfpay
  fixed-amount limitation". #2198's native route replaced cfpay
  `checkout.status` re-reads with session retrieve; the re-read is
  gone from the native route. #2146's submission path carries no
  cfpay client and constructs no checkout.
- Current native coverage: the x402 gate covers crypto pay-per-use
  at catalogue prices; 2.1 Billing (#2694) covers Stripe
  subscriptions end to end (Checkout mint → confirm-by-retrieve
  fulfilment → verified webhook application → billing-aware
  cancel, operator-mapped provider prices, 503 fail-closed without
  a mapping). Both land in the same DID-provenance ledger with
  HITL confirm preserved.

## 5. Options analysis

**Accept as a tier payment method.** A pay-per-use or subscription
payment through cfpay `/a2a/payments` beside direct gateways. Cost:
a second Stripe checkout path (mint/fulfil/webhook) beside 2.1
Billing; a split ledger (cfpay-origin rows vs native rows, two
reconciliation paths — the record-cfpay read-back exists but the
write path would be live again); checkout.status polling
reintroduced after the native route removed it; catalogue prices
not transmissible as amounts (gap 1); refunds still on 2.7's rail;
tenant scoping unwritten (gap 4). Benefit: a buyer already on
cfpay could pay without touching cfagent's native checkout — but
no such buyer population is evidenced anywhere in #2405, #2012,
or #1076.

**Accept as a separate channel.** Same costs as method, plus a
second purchase path competing with the Products-panel Selling
flow — against the Phase 5 non-conflict rule (catalog as the single
discovery→purchase entry, one purchase UX). No additional benefit
over method is evidenced.

**Explicitly decline.** No new payment path. cfagent keeps the two
native rails that already cover both payment kinds (x402 crypto,
Stripe subscriptions), with operator-mapped prices, HITL confirm,
and one ledger. What continues unchanged: cfpay Slack/email
delivery via `cfpayA2A` (the client's live use today), and
record-cfpay ledger reconciliation reads over cfpay-era rows.
Declining acceptance removes nothing from the stack — it declines
to re-add a superseded checkout path.

## 6. Recommendation and pending decision

**Recommendation: DECLINE acceptance as a tier payment method and
as a separate channel, with the rationale in §§3–5.** The contract
as published cannot carry cfagent's catalogue pricing (no amount
input), cannot refund, publishes no webhook/receipt semantics, and
has no subscription operation; the native rails already cover both
payment kinds; re-acceptance would reintroduce a path #2195
deliberately deprecated and split the ledger and the purchase UX.

**Decision — PENDING OWNER DECISION.** The owner records exactly
one of:

1. Accept as a tier payment method (overriding §§3–5 with stated
   reason, e.g. a named cfpay-buyer population);
2. Accept as a separate channel (with the second-purchase-path
   conflict explicitly accepted);
3. Decline (recommended).

Recording the decision — here (status → Accepted, decision filled)
or as a comment on #2663 — is what ticks #2405 line 7. Until then
line 7 stays unticked and #2663 stays open. No code ships on this
decision either way from this slice: acceptance would be a new
slice (minimal wiring behind the monetization flag, HITL confirm
preserved, testnet-only), and decline ships no code path by design.

**What would reopen a decline:** a future revision of the cfpay
payments card adding an explicit amount/currency input on
`checkout.create`, a refund operation, published webhook/receipt
semantics, and tenant-scoped operations. That is a new decision on
new evidence, not an automatic reversal.

**Programme note (flagged, not actioned here):** CBO programme
#2012 Goal 1 still reads "Pay-per-run via cfpay (x402 + Stripe
checkout)". That wording describes the prototype era; the native
migration (#2195/#2198) superseded it in implementation. If decline
is recorded, #2012's Goal 1 wording needs a programme-level note
so the programme text stops pointing at a declined path. This slice
does not edit #2012.

## 7. Reused surfaces (no new system built)

- `src/services/cfpayA2A.ts` (#215) — transport + path list
- `src/services/cfpayLedger.ts` (#2019) — cfpay-origin ledger
  attribution, dedupe, Stripe-fulfil rule
- `src/services/cfpayMonetization.ts` (cfpay era, deprecated in
  place by #2195) — checkout.status == fulfilled rule, 24h TTL
- `src/agents/routes/agenticPayments.ts` (#2019/#2022) —
  record-cfpay write-through, cfpay read-back, revenue report,
  pre-tenant-scoping note
- `src/agents/routes/paymentAssuranceLive.ts` (#2198) — session
  retrieve replaces checkout.status re-read
- `src/services/stripeCheckoutAdapter.ts` + `nativeMonetization.ts`
  (#2195) — catalogue price as session amount, fixed-amount
  limitation fix, deprecation successor
- 2.1 Billing (#2694) — native Stripe Checkout mint /
  confirm-by-retrieve / webhook application / billing-aware cancel
- x402 gate (`src/services/agenticPayments.ts`) — crypto
  pay-per-use at catalogue prices
- cfpay payments agent card, live at
  `https://pay.openaimp.com/a2a/payments/agent-card.json`
  (fetched 2026-11-02, public) — the §2 contract source
- 2.7 refunds (#2662) — operator-approved refund rail, the only
  refund path under any outcome
