### Fixed

- **Every orchestrator reply is complete and consistent (#5899):** one shared `FINAL_REPLY_CONTRACT` (`src/agents/chatPrompt.ts`) is appended to every agent's system prompt — after any tool call the reply must report every call's result, stated counts must equal calls made, and a turn may not end on an announcement. A shared detector (`src/agents/orchestrator/replyCompleteness.ts`) checks each finished turn and audits `chat.reply_incomplete` when it ends without a closing answer.
