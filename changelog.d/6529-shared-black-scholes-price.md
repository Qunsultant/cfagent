### One Black-Scholes price for research economics and shared/riskMath (#6529)

- **One formula.** `src/shared/riskMath.ts` now exports a price-only `blackScholesPrice` and a private `blackScholesTerms` helper (d1/d2/discount factors) used by both the price and the Greeks.
- **Research delegates.** `src/services/researchEconomics.ts` keeps its `BsInputs` signature and delegates to the shared price; its local d1/d2 formula is gone.
- **Contract made explicit:** the shared price returns `NaN` for non-positive/non-finite spot, strike, years, or sigma (or non-finite rate/dividend), uses sigma as given, and has no near-zero-expiry shortcut — exactly the research behaviour. `blackScholesGreeks` keeps its own vol clamp and short-expiry behaviour and delegates only its `price` value, so client/server risk numbers are unchanged.
- **Pinned:** research and shared prices agree across 648 combinations of moneyness, expiry, vol, rate, dividend, and call/put; degenerate inputs stay `NaN`; the textbook ATM Greeks price is unchanged.
- No performance regression: the research PMCC loop uses the price-only function, not the Greeks.
