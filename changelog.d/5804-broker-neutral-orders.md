### Added
- feat(mcp,copilot): add broker-neutral `broker_orders_list`, `broker_order_cancel_ticker`, and `broker_order_cancel_all` MCP tools backed by shared `brokerOrderCancel` services, and update Copilot prompt steering to resolve any catalog broker (including Tastytrade) to neutral `broker_order_*` tools (#5804, #5806, #5807)
