### Fixed

- **Brokerage (#4951, sub of #4665):** Lifted `markDraftRowCancelledIfPresent` and `markScopedDraftsCancelledIfPresent` into `src/services/orderCancellation.ts` and wired `mas_trades` `cancelled` status updates into MCP cancel commands (`alpaca_cancel_order`, `alpaca_cancel_ticker`, `alpaca_cancel_all`, `public_cancel_order`), reusing the same helper from `brokerOrders.ts`.
