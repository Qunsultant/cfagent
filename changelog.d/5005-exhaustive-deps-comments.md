### Changed
- Removed stale `// eslint-disable-next-line react-hooks/exhaustive-deps` comments across 10 client files (`MarketTickerTape.tsx`, `useMarketQuotes.ts`, and 8 search tab components; `ProfileSection.tsx` already clean) since `react-hooks/exhaustive-deps` is not configured in `eslint.config.mjs` (#5005).
