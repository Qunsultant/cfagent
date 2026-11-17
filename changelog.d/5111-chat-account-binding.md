### Issue #5111 — Chat & Copilot account binding tool (Sub-issue 2 of #5094)

- Added `BrokerAccountBindingCommand` (`broker_account_binding`) in `src/mcps/openaimp/accountBindingCommands.ts` supporting `list`, `get`, `set`, and `clear` over `{ broker, mode, accountType, scope, accountId }`.
- Registered `broker_account_binding` in `src/mcps/openaimp/commands.ts` and `src/mcps/openaimp/mcpPermissionPorts.ts` (`mcp:write`).
- Added `tool_openaimp_broker_account_binding` steering in `src/agents/chatPrompt.ts`.
- Added `tests/account_binding_chat_5111.test.ts`.
