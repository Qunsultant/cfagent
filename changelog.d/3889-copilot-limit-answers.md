### Added

- **The copilot answers limits and refusals from configuration (#3889):** `answerTradingLimitQuestion` builds “what are my limits”, “how much budget is left”, “why was that refused” and “what did you stop” from the `trading_limits` and cancel receipts — every value carries its source (ticker override / setting / env / unset), an unset limit reads “not configured”, and a failed read is reported as a failed read naming `trading:limits`. #rsi
- **A refusal answer quotes the facts (#3889):** the code plus the limit, its value, the usage and the requested amount, in the same `budget_exhausted (maxNotionalPerTicker @ $5,000; used $4,980; requested $1,200)` shape the validator produces. #rsi
- **Prompt rules that match the builder (#3889):** the Stock Copilot prompt now forbids stating a limit the tool did not return, forbids inventing a default, and points at `tool_openaimp_trading_limits`, so the model is asked to do exactly what the deterministic answer does. #rsi
