### Added

- Volatility framework completed for #1769 (parent #1717): exported `computeHistoricalVolatility` (HV 20/60, sqrt(252) × population sigma of log returns, trailing window only), `computeSkew25` (put IV minus call IV at 25 delta), and `evaluateVolDecisionMatrix` (IVR > 50 and IV > HV → SELL_PREMIUM; IVR < 25 → STAND_DOWN; otherwise NO_READ, strict boundaries). Invalid inputs return null — a gate that cannot be evaluated, never zero.
