### Added
- **TOS-style Multi-Bracket Ladder & Grid Orders (#3673)**: Added `src/services/bracketLadder.ts` and MCP tools `alpaca_place_bracket_ladder` and `alpaca_cancel_bracket_ladder` supporting multi-tier limit bracket orders with configurable step increments (dollar or percentage), paired take-profit and stop-loss exits per tier, pattern-range bounding, and batch cancellation.
