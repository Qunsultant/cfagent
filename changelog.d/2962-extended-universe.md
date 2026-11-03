### Added

- **Extended index universe (#2962):** `IndexMembershipPort` now serves `sp400` (S&P MidCap 400 Wikipedia table), `russell3000` (IWB + IWM holdings union at the older leg's as-of date, IWV cross-check), and the 11 GICS sector universes (S&P 500 table filtered by its GICS Sector column, SPDR tickers as cross-check keys); the new keys get the #1980 stored-snapshot + scheduled-refresh treatment (Wikipedia weekly goal live; holdings daily goal still ships DISABLED pending a holdings fetcher binding, so `russell3000`'s stored refresh is a carried item).
