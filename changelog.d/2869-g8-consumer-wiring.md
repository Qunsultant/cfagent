### Changed

- **Stage consumer is the production PDF leg, G8 (#2869, under #2764) #clo-arsi:**
  `ScreenerAgent.generateRunPdf` now delegates PDF generation to
  `src/workflows/stageReportProduction.ts` (`generateRunPdfViaStageConsumer`):
  the run's analysis is persisted to a per-run key
  (`screener:analysis:<timestamp>`), a real analysis-done message is built
  referencing that key, and `consumeAnalysisDone` consumes it — the PDF leg
  (one generation module → `runReportPipeline`) runs from persisted data only,
  never a live run. Sync, workflow-child, and #1278 regeneration paths all go
  through it via `generateRunPdf`.
- Durable stage claims in `src/data/stageClaimsStore.ts` (`mas_stage_claims`,
  census-safe data-layer placement, same pattern as G6 delivery claims):
  a claim survives instance eviction, so a redelivered stage message is
  suppressed across instances. Release-on-failure added to the consumer
  contract: a throwing generate releases its claim, so a failed attempt never
  blocks #1278 regeneration; a successful generation never releases.
- Suppressed-redelivery guard in the helper: the claim is pre-checked before
  persisting, so a redelivery never clobbers the persisted analysis, and the
  previous generation's pdf fields are copy-backed onto the fresh result.
- Capability inventory `report-generation` entry now names the consumer as
  the production PDF leg (audit F2 closed for the monolithic path).
- NOT in this slice, stated plainly (filed on #2869): queue transport for
  the analysis-done message (Queues/mas_async_jobs pub/sub + queue executor),
  per-boundary stage messages inside `runScreenInner`, and the chain generate
  leg (`generateTabular`) — the consumer is PDF-only by contract and cannot
  replace tabular generation. The chain's serve step already feeds the same
  delivery bridge.
