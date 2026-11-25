### One options-economics layer for OODA and the screen engine (#6506)

- **One pure calculation module.** `src/trading/options/economics.ts` now owns mid pricing, net open cost, intrinsic/expiry payoff, expected move, grid extremes, and the breakeven root search. OODA's `researchEconomics` and the screen `strategyEngine` both call it; the duplicate copies are gone.
- **Engines stay separate.** Research keeps its expiry-only payoff and report gates; the screen engine keeps its fee convention and Black-Scholes value for later-dated legs. Only the calculation primitives are shared, never the ranking or orchestration.
- **Pinned parity:** a fee-free call spread, put spread, and iron condor produce identical max loss, max gain, and breakevens through both callers; the engine's fee treatment is pinned as an explicit additive divergence (P05).
- No UX, scoring, selection, or report-shape change: existing research and strategy suites stay green.
