### Synchronous trading tools & clickable links (#3785, #3781, #3821)

- **Synchronous Execution for Trading & Market Data Tools**:
  - Expanded `SYNCHRONOUS_MCP_TOOLS` in `src/config/asyncJobModes.ts` to include all trading, quote, preview, and account tools (`alpaca_place_order`, `alpaca_preview_order`, `alpaca_get_quote`, `alpaca_orders`, `alpaca_positions`, `alpaca_account`, `alpaca_snapshot`, `alpaca_place_bracket_ladder`, `alpaca_cancel_bracket_ladder`, `market_data_get_quote`, `market_data_company_fundamentals`, `market_data_historical_bars`, `market_data_research`, `agentdb.chain.status`, `agentdb.jobs.history`, `agentdb.audit.history`, `agentdb.reports.list`, `agentic_wallet_status`, `get_payments_overview`).
  - Added prefix-based synchronous dispatch for legacy broker tools (`LEGACY_BROKER_TOOL_PREFIX`), preventing interactive trading tools from being trapped in `mas_async_jobs` background queues.
  - Interactive orders now execute in-line with immediate broker responses, eliminating stuck "0/1 completed" background jobs and false execution reports.

- **Safe Relative Links & Clickable Run IDs**:
  - Fixed `isSafeUrl` in `src/client/chat/renderInlineFormatted.tsx` to permit `?tab=` and `#` URLs, rendering markdown links like `[View Live Workflow Runs](?tab=workflow-runs)` as clickable in-app links instead of plain text.
  - Updated `src/client/WorkflowRunsPanel.tsx` to render the run ID in the Workflow column using `Button` primitive from `src/client/components/ui/` (`variant="ghost"`, `size="sm"`), conforming to UX gates and opening the details drawer directly.

- **Truthful Order Placement Guardrail**:
  - Added strict invariant to `STOCK_COPILOT_MCP_STEERING` in `src/agents/chatPrompt.ts` prohibiting the assistant from reporting an order as placed or submitted if an async `jobId` was returned instead of a verified broker order ID.

- **Think Webhook Channel Secret Deployment Sync (#3821, #3474)**:
  - Wired `S_THINK_WEBHOOK_SECRET: ${{ secrets.THINK_WEBHOOK_SECRET }}` in `.github/workflows/deploy.yml` core secrets step.
  - Pushed `optional_secret THINK_WEBHOOK_SECRET "$S_THINK_WEBHOOK_SECRET"`, enabling the PortThink webhook channel to transition from 503 unconfigured to active once the operator sets the secret. Pinned in `tests/deploy_workflow_secret_retry.test.ts`.
