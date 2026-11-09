### Added

- **One declarative registry for every advanced order type (#3892):** `ADVANCED_ORDER_TYPES` declares what each type needs, which broker supports it (`native` / `emulated` / `none`), its TIF constraints and its refusal code. The validator, the tool schema and the copilot enumeration read that one table. #rsi
- **No silent downgrade (#3892):** an unsupported request refuses with `order_type_unsupported (trailing_stop @ etrade; supported: market, limit, …)`, never a simpler order; `qty` XOR `notional` and `trail_price` XOR `trail_percent` are enforced before the broker is contacted. #rsi
- **Trailing stops, notional sizing and GTD reach the wire (#3892):** `trail_price` / `trail_percent`, `notional` and `good_till_date` are carried verbatim by the Alpaca placement path; a basic order’s body is unchanged. #rsi
- **Named option strategies compose their own legs (#3892):** vertical, straddle, strangle, condor, butterfly and calendar build the exact legs (sides, strikes, ratios, expiries) a caller would otherwise hand-assemble. Covered calls refuse without the shares; cash-secured puts refuse below `strike × 100 × contracts`. #rsi
- **Protective exits and scale-outs with position-derived sizes (#3892):** a protective stop sells the position’s own quantity (never opens a short), and a scale-out can never sell more than is held. #rsi
