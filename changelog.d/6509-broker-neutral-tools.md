### Neutral MCP tools for generic broker capabilities (#6509)

- **One capability map.** `src/shared/brokerToolNames.ts` names the neutral tool for each generic capability — quote, positions, accounts, preview, orders, cancel, cancel-ticker, cancel-all — and maps every broker-named generic tool to it. Broker-named tools stay registered for existing clients.
- **Prompts resolve by capability, not broker.** `resolvePromptBrokerTools` reads the broker catalog and steers generic capabilities at the neutral tools for every broker (E*TRADE, Alpaca, Public, Tastytrade); only direct execution keeps the broker's own tool. The `isEtrade`/`isPublic` branches are gone.
- **Stock Copilot steering follows.** The capability block, trading rule, and MCP steering name neutral quote/preview/orders/cancel tools; the default Alpaca/paper constant was neutralized the same way. Direct execution stays `*_place_order` / `etrade_execute_order`.
- **Pinned:** every neutral tool exists and is permissioned; every supported broker resolves the generic capabilities to them; every broker-named generic tool maps to a neutral capability; a new unclassified broker-named generic tool fails the census; the prompt source carries no broker branch.
- **Follow-up:** #6516 owns the neutral option-chain MCP capability (the Alpaca-only chain tool is the remaining broker-named generic read).
