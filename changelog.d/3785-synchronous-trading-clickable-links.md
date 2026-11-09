### Synchronous trading tools & clickable links (#3785, #3781)

- **Synchronous Execution for Trading & Market Data Tools**:
  - Expanded `SYNCHRONOUS_MCP_TOOLS` in `src/config/asyncJobModes.ts` to include all trading, quote, preview, and account tools (`alpaca_place_order`, `alpaca_preview_order`, `alpaca_get_quote`, `alpaca_orders`, `alpaca_positions`, `alpaca_account`, `alpaca_snapshot`, `alpaca_place_bracket_ladder`, `alpaca_cancel_bracket_ladder`, `market_data_get_quote`, `market_data_company_fundamentals`, `market_data_historical_bars`, `market_data_research`, `propose_stock_trade`, `propose_options_trade`, `get_trading_accounts`, `get_trading_positions`, `get_trading_quote`, `start_trade_approval`, `decide_trade_approval`, `get_trade_approval_status`, `dispatch_trading_webhook`, `think_trade_validation`, `agentdb.chain.status`, `agentdb.jobs.history`, `agentdb.audit.history`, `agentdb.reports.list`, `agentic_wallet_status`, `get_payments_overview`).
  - Added prefix-based synchronous dispatch for legacy broker tools (`LEGACY_BROKER_TOOL_PREFIX`), preventing interactive trading tools from being trapped in `mas_async_jobs` background queues.
  - Interactive orders now execute in-line with immediate broker responses, eliminating stuck "0/1 completed" background jobs and false execution reports.

- **Safe Relative Links & Clickable Run IDs**:
  - Fixed `isSafeUrl` in `src/client/chat/renderInlineFormatted.tsx` to permit `?tab=` and `#` URLs, rendering markdown links like `[View Live Workflow Runs](?tab=workflow-runs)` as clickable in-app links instead of plain text.
  - Updated `src/client/WorkflowRunsPanel.tsx` to render the run ID in the Workflow column as an interactive button that opens the details drawer directly.

- **Truthful Order Placement Guardrail**:
  - Added strict invariant to `STOCK_COPILOT_MCP_STEERING` in `src/agents/chatPrompt.ts` prohibiting the assistant from reporting an order as placed or submitted if an async `jobId` was returned instead of a verified broker order ID.
