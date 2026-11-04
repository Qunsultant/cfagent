### Changed

- **The catalog now describes the seam that exists, and stops describing one that doesn't (#3072/#3073/#3069 R1/R2/R8):** options, trading, payment and saga flip from "stage seam not wired yet" to wired, because their flows now publish a boundary per stage. The declaration model changed with the truth: `publishes` was a single topic per stage, which under-declared every multi-step stage — stock's own `feed` publishes four (`plan`, `brokerStart`, `acquireUniverse`, `fetchQuotes`), not one. It is now a list, and `assertWorkflowCatalog` enforces the strongest claim the code can support: **a seam-wired stage publishes exactly the runtime steps it executes**, an unwired family publishes nothing.
- Trading's declaration lost the `feed` and `deliver` stages it never had — the flow is the approval wait and the settle, so the catalog says two stages, matching `TradingTradeWorkflow`.
- Goal and strategy keep their named gaps: they execute on another family's seam, and the pins refuse to let them borrow its ids.
- The panel renders the topic list per stage instead of a single name, so an operator reading the catalog sees the same ids the queue carries.
