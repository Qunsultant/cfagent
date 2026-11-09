### Fixed

- **`alpaca_place_order` accepts `quantity` as well as `qty` (#3873):** the tool advertised `quantity`, `orderAction`, `orderType` and `limitPrice` while the MCP path copied the input verbatim, so a caller using any of them lost the field — `quantity: 1` surfaced as “qty is unrecognized”. `qty` is no longer a required schema field, aliases resolve in every mode, and a missing size is refused with a message naming both spellings. #rsi
