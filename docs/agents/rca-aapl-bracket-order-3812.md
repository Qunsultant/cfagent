# RCA — the AAPL +4% / -2% bracket request never produced a draft

**Issue:** #3812 · **Severity:** high (a money-path task ended in a question
instead of a draft) · **Status:** fixed · **Surfaces:** Stock Copilot chat,
Alpaca preview/place MCP tools, dynamic settings menu, Workflow Runs.

## 1. What the user asked for

> “Draft a limit buy order for 10 AAPL with +4% take-profit and -2%
> stop-loss bracket exits.”

The requested deliverable is a **draft** (preview), not a placement. The
bracket legs are percentages of the entry, so the draft must resolve a live
entry price and convert both legs deterministically.

## 2. What actually happened

Recorded transcript, in order:

1. The Stock Copilot chip `🎯 Buy AAPL Bracket (TP +4% / SL -2%)` sent the
   prompt above.
2. The first tool call was `tool_openaimp_get_async_job` — the turn had a
   **job id**, not a quote. The quote request had been queued.
3. The job was still pending. The agent said it was “awaiting the live
   quote” and then offered three options: placeholders, wait, or a paid
   Alpaca quote.
4. It produced a “provisional bracket” with `limit = +4%` and
   `stop = -2%` as **placeholders** and asked for confirmation.
5. **No preview draft was created. No order was placed. No run was
   recorded for the attempt.**

## 3. Root causes

### RC-1 — Split-brain default broker (primary)

The platform's stored default was E*TRADE (`DEFAULT_TENANT_PROVIDERS`,
client mirror, and the settings-menu fallback), while the Stock Copilot
resolver defaulted to Alpaca (`COPILOT_BROKER_ID`). The menu therefore said
“E*TRADE · Sandbox” for a tenant who had selected nothing, and the turn's
tools drifted toward the E*TRADE quote path — which returns a queued job.

**Fix:** the server default, client mirror, and menu fallback are all
`alpaca`; paper remains the mode default (`TEST`), so the resolved state is
“Alpaca · Paper” with no stored selection. Live remains an explicit act.

### RC-2 — A quote was queued instead of resolved

The chat tool delivery wrapped the quote as an asynchronous job. The agent
then polled `get_async_job` inside the turn and stalled. Rule 8 already says
job polling happens only when the user asks for status; the turn had no
synchronous one-call path for “quote + bracket draft”.

**Fix:** the Stock Copilot steering now defines a **bracket draft protocol**:
one `alpaca_preview_order` call with `takeProfitPercent` / `stopLossPercent`.
The adapter fetches the live quote itself when no user limit is supplied.
The steering explicitly forbids `get_async_job` polling for this flow and
requires an honest failure + fix URL if the quote cannot be fetched.

### RC-3 — Percent brackets were unsupported

`OrderPreviewParams` and the MCP schemas accepted only absolute
`takeProfit.limitPrice` / `stopLoss.stopPrice`. A “+4% / -2%” request left
the model to do arithmetic and rounding on a money path — exactly what the
#3782 price-provenance rule forbids it from presenting.

**Fix:** `src/trading/bracketPercent.ts` converts percent exits from the
same entry the draft is priced from (user limit, or live quote), side-aware,
half-up to cents, with coded refusals (`invalid_bracket_entry`,
`invalid_bracket_percent`, `invalid_bracket_prices`). Preview and place both
accept the percent form; the place path requires a positive `limit_price`
and refuses otherwise (`bracket_percent_needs_limit`) rather than guessing.

### RC-4 — The prompt contradicted itself

Rule 6 said “For trade orders, ALWAYS use `etrade_preview_order`”, while the
Stock Copilot block said the copilot's broker is Alpaca. A model reading
both rules can pick either; the transcript picked the E*TRADE quote job.

**Fix:** rule 6 is broker-neutral: use the active broker's preview tool
(`etrade_preview_order`; `alpaca_preview_order` on an activated Stock
Copilot turn). The prompt fixtures were re-pointed in the same slice.

### RC-5 — No preflight and no provider UX

The refusal paths named a failure but not a fix, and the user had no way to
see whether the blocker was credentials, credits, or market-data
entitlement. There was also no run record for the order attempt, so this
RCA had to be reconstructed from prose.

**Fix:** `src/services/providerUxLinks.ts` is the one table of deep links;
the quote-unavailable error and the payment terminal notes now include the
exact fix. Every preview/placement records a `trading` outcome
(`order:<orderId>`) that Workflow Runs renders as its own run.

## 4. What must be in place for the order to succeed

| Prerequisite | Check | Fix URL |
| --- | --- | --- |
| Default broker = Alpaca, mode = paper | Settings menu shows `Settings (Alpaca · Paper)`; `resolveCopilotTradingSelection` returns `brokerId: "alpaca"`, `mode: "paper"` | `?tab=trading` |
| Alpaca credentials (paper) | Deployment keys, or the user's own pair signed in | `/api/broker/connect/alpaca?environment=TEST` |
| Alpaca market-data entitlement (live quote) | A quote returns provider `alpaca`, provenance `live`, timestamp | `?tab=trading` (Alpaca panel) |
| Credit/run coverage (when monetization is on) | Account balance or included runs cover the run price | `?tab=checkout&checkoutTab=topup` |
| Explicit human approval for placement | Preview returns `status: "previewed"`, `requiresConfirmation: true` | `?tab=workflow-runs` for the trace |
| Live trading (only when explicitly selected) | User's own verified key pair; deployment keys are paper-only | `/api/broker/connect/alpaca?environment=PROD` |

### Credits

A signed-in user needs coverage only when monetization is enabled. The
balance and included runs are on **Checkout**; credits are added in
**Checkout → Top up** (`?tab=checkout&checkoutTab=topup`), and a
subscription is activated at `?tab=checkout&checkoutTab=subscriptions`.
The payment terminal note now prints both URLs when a run is blocked.

## 5. The correct one-turn behavior (and the exact call)

For the user's prompt, the copilot makes **one** call:

```jsonc
{
  "tool": "alpaca_preview_order",
  "arguments": {
    "symbol": "AAPL",
    "action": "BUY",
    "quantity": 10,
    "orderType": "LIMIT",
    "takeProfitPercent": 4,
    "stopLossPercent": 2
  }
}
```

- With no `limitPrice`, the adapter prices the parent at the **live Alpaca
  quote** and labels `priceSource` as `live-quote` (provider + timestamp).
- With a user limit, that limit wins and `priceSource` is `user`.
- Exits are computed from the same entry. Illustrative arithmetic at an
  entry of `$342.37` (a worked example, **not** a quote): take-profit
  `342.37 × 1.04 = 356.06`, stop-loss `342.37 × 0.98 = 335.52`.
- The result is a **draft**: `status: "previewed"`,
  `requiresConfirmation: true`, DID-attested, no shares moved.
- Placement is a separate, explicitly approved call:
  `alpaca_place_order` with `limit_price`, `take_profit_pct`,
  `stop_loss_pct` (the same percentages), and `type: "limit"`.

## 6. Traceability in Workflow Runs

Every preview and placement now writes one `mas_job_outcomes` row:

| Field | Value |
| --- | --- |
| `id` | `order:<orderId>` (`alpaca_preview_order`), or the broker order id on placement |
| `kind` | `trading` |
| `status` | `completed` for a draft/accepted order; `failed` for a coded refusal |
| `origin` | `alpaca_preview_order` / `alpaca_place_order` |
| `deliveryStates` | `broker`, `mode`, `action`, `symbol`, `quantity`, `orderType`, `orderClass`, `priceSource`, `takeProfitPercent`, `stopLossPercent`, `takeProfitPrice`, `stopLossPrice` |
| `codedError` | the refusal code, e.g. `invalid_bracket_percent`, `bracket_percent_needs_limit` |

The Workflow Runs tab (`?tab=workflow-runs`) renders the row as
**“Trading order workflow”**. The ledger's honesty rules still apply: a
field the store does not record renders “Not recorded”, never invented.

## 7. Verification

- `tests/alpaca_bracket_percent_3812.test.ts` — helper math (BUY/SELL,
  rounding, coded refusals), preview with user limit and with live quote,
  half-specified refusal, place with percent exits (asserts the Alpaca
  request body), place without a limit refusal, defaults, workflow-run
  mapping, provider links.
- `tests/orchestrator-actor-cutover.test.ts` — prompt byte-identity
  fixtures re-pointed for the broker-neutral rule 6.
- `tests/prompt_bulk_knowledge_2719.test.ts` — size pin re-measured
  (6,164 chars, pin 6,200).
- `tests/neutrality_defaults_onboarding_3525.test.ts` — default pin moved
  to Alpaca.
- Existing Alpaca suites (`alpaca_bracket_orders_3658`,
  `mcp_preview_price_provenance_3782`, `alpaca_place_order_remote_3158`)
  stay green.

## 8. Residual risks / follow-ups

- The NLQ order fast-path (`src/agents/nlq/orderParams.ts`) still parses
  only absolute prices and routes previews through E*TRADE. It is not the
  copilot path after this fix, but a chat turn with `CHAT_NLQ_MODE` on
  could still take it. Follow-up: add bracket-percent parsing and an Alpaca
  branch there, or gate the fast-path off for copilot turns.
- A Cloudflare queue transport can still wrap a tool call as an async job
  under `HTTP_DELIVERY_MODE`; the steering now tells the model not to poll,
  but a delivery-mode change should exempt trading preview/place tools.
- `alpaca_place_order` still declares `priceSource: { kind: "user" }`; a
  future percent-placement path that prices from a quote must carry the
  quote's provenance instead.
- Alpaca requires `time_in_force: "day"` for bracket orders; a `gtc`
  bracket is refused by the broker, not by this client. The refusal is
  recorded, but a preflight could name it earlier.
