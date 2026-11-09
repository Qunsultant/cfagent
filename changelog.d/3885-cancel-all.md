### Added

- **`alpaca_cancel_all` / `POST /broker/orders/cancel-all` — “cancel everything”, in two steps (#3885):** a bare call never cancels. It returns a preview (count, symbols, classes, oldest/newest) and a single-use, short-lived token; only a second call presenting that token acts, and only on the ids the preview showed — an order placed after the preview is never swept up. #rsi
- **Caps that cannot be argued with (#3885/#3888):** above the configured `cancelMaxCount` the call refuses and reports the real count and the cap (`cancel_all_too_many`); with no cap configured it refuses too (`limit_not_configured`), because “cancel everything” must never run unbounded. #rsi
- **Refusal vocabulary (#3885):** `cancel_all_needs_preview`, `cancel_all_too_many`, `cancel_all_preview_expired` (a replayed or aged token refuses instead of cancelling twice). A receipt lists every order with its terminal status and itemises partial failures. #rsi
- **A Portfolio confirmation dialog (#3885):** “Cancel all open orders” asks for the preview, shows what would be cancelled and when the confirmation expires, and refreshes the order table only after the server reports a completed cancel. #rsi
