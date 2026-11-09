### Added

- **`alpaca_cancel_order` — cancelling one order is an agent capability (#3883):** the tool runs the same engine the neutral `POST /api/broker/order/cancel` route now runs for Alpaca, so a transcript, the route and the order-history button cannot give three answers about one order. #rsi
- **Bracket/OCO/OTO cascade, counted (#3883):** cancelling a parent cancels its held legs at the broker and the receipt reports how many legs were declared, how many are now cancelled and how many the broker still holds; cancelling a single leg is allowed and names the parent that survived. #rsi
- **Coded, factual refusals (#3883):** an already-filled order answers `cancel_not_possible` naming its status and sends nothing; an unreadable order is reported as unread (`order_not_found` / `cancel_read_failed`), never as “0 orders cancelled”. #rsi
- **Every cancel lands in Workflow Runs (#3883):** one `order:<orderId>` row per attempt, carrying `cancelled` / `cancel_failed` and the broker’s own status alongside the platform’s `completed` / `failed`. #rsi
