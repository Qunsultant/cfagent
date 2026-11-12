### Fixed

- Trading-boundary pin now scans `.tsx` files as well as `.ts` (#4270): nineteen client files imported trading-internal paths (broker catalog/presentation/panels, strategy engine, legs, flows) without the pin seeing them; all 28 imports now go through the public surface `src/trading/index.ts`, which gains a named `toLeg` export (a star export would have made `contractKey` ambiguous).
