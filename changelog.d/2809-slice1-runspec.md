### Added

- **Stock screener Phase 2 Slice 1 (#2809, under #2764):** one normalized StockScreenRunSpec built once from the shared stock-screen schema plus mode admission and delivery fields, used by both REST screen routes (/etrade/screen and /market-data/screen), with the delivery divergence pinned as data (E*TRADE deliver: true, market-data deliver: false). No behaviour change, no screening semantics change.
