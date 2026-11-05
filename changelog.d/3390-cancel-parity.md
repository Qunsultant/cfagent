### Added
- Cancel parity (#3390, programme #3292): one neutral `POST /broker/order/cancel` for both brokers. Alpaca cancels with `DELETE /v2/orders/{orderId}` and reports the broker's own answer — 204 is a cancelled order, 404/422 are failures carrying the broker's status, never an invented success. `orderCancel` joins the broker catalogue, so a broker without the capability gets a coded, named refusal instead of a control that does nothing.
- The Alpaca order history now offers **Cancel** on an OPEN order, and refreshes the table when the broker accepts the cancellation.

### Changed
- The E*TRADE account panel cancels through the neutral route (`/api/broker/order/cancel`) instead of `/api/etrade/orders/cancel`. The legacy route stays for compatibility; nothing calls it from the client any more.
