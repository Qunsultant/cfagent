export * from "./types";
export * from "./flowService";
// #3932 — the batched LLM news-sentiment classifier (#132, with
// the #881 instruction/data separation) joins the boundary
// surface by name, so the sentiment feed job (services/) can
// classify fetched headlines through the trading barrel
// (src/trading/index.ts) instead of importing this trading-
// internal module directly (the #290 boundary rule).
export * from "./newsSentiment";
