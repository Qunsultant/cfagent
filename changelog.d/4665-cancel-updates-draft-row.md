### Fixed
- `#4665`: Updated both `/broker/order/cancel` (`src/agents/routes/brokerOrders.ts`) and legacy `/etrade/orders/cancel` (`src/agents/routes/etradeBroker.ts`) to mark the `mas_trades` draft row `status: "cancelled"` via `orm.trades.update(orderId, { status: "cancelled" })` when the broker confirms cancellation.
