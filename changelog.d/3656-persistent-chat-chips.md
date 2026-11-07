### Added

- **Persistent collapsible prompt chips bar above composer (#3656):**
  - Added persistent copilot quick prompt chips bar in `src/client/chat/AgentChatTabContent.tsx` during active conversations (`messages.length > 0`).
  - Added collapse/expand toggle button (`▼ Prompts` / `▶ Prompts (N)`) with token-only Griffel styles.
  - Added unit and interaction test coverage in `tests/chat_copilots_subtabs_3449.test.tsx`.
