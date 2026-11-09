# Stock Copilot broker/mode capability

Issue #3839. The Stock Copilot runs on **every broker/mode declared in the
broker catalog**, not on a hardcoded broker. This page is the operating
contract: what is declared, how the copilot reads it, and what a new broker
must add.

## 1. The declaration

`src/trading/brokerCatalog.ts` carries one `copilot` block per broker:

```ts
copilot: {
  supported: true,              // the copilot may run at all
  autonomousCycle: true,        // the scheduled cycle may place orders
  bracketOrders: "native",      // native | preview | none
  percentBrackets: true,        // preview/place accept +x% / -y%
  barsProvider: "alpaca",       // alpaca | yfinance | hybrid
  tools: {
    quote, preview, place, orders, cancel
  }
}
```

Derived helpers (never a second list):

- `brokerCopilotCapability(broker)` — the block.
- `copilotBrokerIds()` — every broker with `supported: true`.
- `isCopilotBroker(id)` — narrowing guard used by the cycle and the door.

Current matrix:

| Broker | Paper | Live | Bracket orders | Percent exits | Bars |
| --- | --- | --- | --- | --- | --- |
| Alpaca | `TEST` → paper | `PROD` → live | native | yes | Alpaca |
| E*TRADE | `TEST` → paper | `PROD` → live | preview (draft; separate exits) | yes | Yahoo |

## 2. How the copilot reads it

- **Selection** — `resolveCopilotTradingSelection` reads the tenant's stored
  broker (absent → Alpaca) and the stored environment (absent → `TEST`), then
  maps the pair through `tradingTypeFor`.
- **Cycle gate** — `runStockCopilotCycle` refuses only when the catalog says
  `supported: false` or `autonomousCycle: false`
  (`stock_copilot_unsupported_broker`). Every declared broker runs.
- **Mode guard** — Alpaca uses its own base resolver; every other broker uses
  the catalog's `tradingTypeForEnvironment` mapping. The guard never assumes
  Alpaca.
- **Scheduled host** — constructs the selected broker's platform and uses its
  declared `barsProvider`.
- **Door status** — `inactive_broker` only when `isCopilotBroker` is false.
- **Prompt steering** — `buildStockCopilotMcpSteering` names the active
  broker's quote/preview/place/cancel tools, mode, and bracket semantics.
  Alpaca/paper returns the original block byte-for-byte.

## 3. Adding a broker or mode

1. Add the broker to `BROKER_CATALOG` (id, label, credential kind, asset
   classes, operations, `tradingTypeForEnvironment`, status vocabulary,
   `copilot`).
2. Register its `ITradingPlatform` in `src/trading/index.ts`; the registry's
   completeness guard fails if the catalog entry is missing.
3. Implement the tool names declared in `copilot.tools` (or declare
   `supported: false` until they exist).
4. Add one test row to `tests/copilot_any_broker_3839.test.ts` (the matrix
   loop covers every catalog entry).
5. No copilot code change is needed — the gate, host, door, and steering are
   capability-driven.

A new **mode** is an environment token in `TradingEnvironment` plus a
`tradingTypeForEnvironment` entry; the copilot's selection, guard, and status
follow it automatically.

## 4. Bracket semantics

- **native** (Alpaca): preview/place carry `takeProfitPercent` /
  `stopLossPercent`; the broker holds the children. Non-`day` TIF is refused
  before broker contact.
- **preview** (E*TRADE): the preview computes and stores the legs
  (`bracket-draft-v1`), but the client has no conditional placement.
  `executeOrder` refuses the bracket draft rather than placing an unprotected
  parent; the parent and the two exits are separate approved orders.
- **none**: no bracket model; a protective stop is a separate approved order.

## 5. UX

- Broker/mode switch and connection: `?tab=trading`
- Alpaca paper connect: `/api/broker/connect/alpaca?environment=TEST`
- Alpaca live connect: `/api/broker/connect/alpaca?environment=PROD`
- Credits: `?tab=checkout&checkoutTab=topup`
- Run trace: `?tab=workflow-runs`

## 6. Residual RCA items closed here

| Residual | Resolution |
| --- | --- |
| NLQ order fast-path had no percent brackets | `extractOrderParameters` parses `+x% take-profit` / `-y% stop-loss`; the NLQ preview passes them to the E*TRADE adapter |
| `HTTP_DELIVERY_MODE` could queue trading tools | E*TRADE and mesh trade tools added to `SYNCHRONOUS_MCP_TOOLS` |
| Alpaca GTC brackets refused only at the broker | preflight refusal `bracket_requires_day_tif` before broker contact |
| Percent placement provenance implicit | placement still requires a positive user `limit_price`; the receipt records `priceSource: user` |
