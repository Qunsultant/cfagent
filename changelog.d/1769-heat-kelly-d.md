### Added

- Portfolio heat cap and fractional Kelly completed for #1769 (parent #1717): `checkPortfolioHeatCap` (total open max loss <= 35% of account equity, inclusive) enforced as an additional constraint in `sizeCandidateAgainstPortfolio` alongside — never instead of — the existing tighter 10% total-max-loss budget, so no existing sizing changes; and `fractionalKellySize` (f* = ((p x b - (1 - p)) / b) x Fraction), locked (null) below 30 historical verified trades and zero on a negative edge.
