### One normal CDF for research economics (#6526)

- **Duplicate removed:** `src/services/researchEconomics.ts` no longer carries its own Abramowitz–Stegun normal CDF; `normCdf` is now the shared `normalCdf` from `src/shared/riskMath.ts`. Callers keep the same name and values.
- **Pinned:** the exported function is the shared function itself, both tails and the centre agree across a value grid, and the research module carries no local CDF constants.
- No behaviour, performance, or API change. `blackScholesPrice` itself stays local for now: the shared Greeks function clamps vol and treats near-zero expiry differently, so unifying the price needs its own decision.
