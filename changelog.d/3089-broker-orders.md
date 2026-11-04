### Added

- Broker-routed order endpoints (`/api/broker/order/preview`, `/api/broker/order/execute`, `/api/broker/orders`) that resolve the trading platform from the registry instead of hardwiring E*TRADE (#3089).
- Broker stamp on stored order drafts (`mas_trades.broker`, guarded ALTER for pre-existing tables) with execution deriving the broker from the draft — a draft previewed on one broker can never execute on another.
- Broker indicator next to the Ctrl+K search control and broker names on every approval surface: approvals queue rows, approve dialog, and result notice.
