# Holistic Screening Consolidation — Survey of Current Main

**Repo state surveyed:** OpenAIMP/cfagent @ `73cc521876e9e074f07aced61f0ee4b93f1c4706` (2026-10-22T04:12Z), fresh tarball extracted to `~/workspace/wscreen/ctrl` (872 files, verified).
**User directive (2026-10-22):** "the system has multiple UIs for stock and options screeners and multiple scheduling and generation capabilities. The system must have one holistic implementation for screening for stocks, for options, and their scheduling and unified generation/store/serve/delivery capabilities."
**Method:** code read only. Route inventory is from `path.endsWith(...)` handler greps on the screening-relevant route modules, not the full ~200-route surface (the repo's `tests/thin_router_inventory.test.ts` pins the full set).

---

## 1. Screening UIs (client)

Navigation (`src/client/components/NavigationMenu.tsx:436-471`) exposes screening through **two separate top-level entries** — `scanner` ("Strategy/Symbol Scanner") and `screeners` ("Multi-Asset Screeners") — plus separate **Reports** and **Schedules** entries, and the options-research surface buried inside the E*TRADE Trading Hub.

| # | Surface | File | Reachable via | Calls | Shows / downloads |
|---|---------|------|---------------|-------|-------------------|
| U1 | Multi-Asset Screeners (stocks) | `src/client/ScreenersHub.tsx` (896 lines) | Nav "Screeners" | Provider adapters (`src/client/screeningAdapters.ts`): E*TRADE → `POST /api/etrade/screen`; Yahoo FOSS → `POST /api/foss/screen`. Also `GET /api/screener/latest` (autonomous-runs feed) | Manual run results + scheduled-run feed, both via `ScreenerResultsView`; per-run PDF/XLSX + CSV exports. **Options tab is a redirect notice** ("Options Capabilities Moved to Auto Options Research", ScreenersHub.tsx:872-886); forex/futures/commodities/bonds tabs are PLANNED stubs (`screeningAdapters.ts:42-47`) |
| U2 | Strategy/Symbol Scanner | `src/client/ScannerPanel.tsx` (1,761) + `src/client/scannerApi.ts` | Nav "Scanner" | `POST /api/trading/options/unified`; `GET /api/etrade/options/profiles`, `GET /api/etrade/options/scans` (+diff); PDF via `/api/options/report.pdf` | Two modes (#23): best-strategy-per-name and names-fit-my-strategy (`strategy_fit`); Strategy Profile manager; saved-run history with provenance; exports via `src/client/scannerExport.ts` |
| U3 | Auto Options Research (hub) | `src/client/options/OptionsResearchPanel.tsx` (1,646), mounted in `src/client/ETradeTradingHub.tsx:1587-1614` under its "options" subtab | Trading Hub → Options | Six modes (`ResearchMode`, OptionsResearchPanel.tsx:731): **discovery** (`StrategyDiscoveryPanel.tsx`, 3,708 + `DiscoveryRunsPanel.tsx`, 677), **contracts** (`RawContractsScreener.tsx`, 683 → `POST /api/trading/options/screen`), **custom** (Custom Thesis Universe → `/trading/options/recommend`, `/compare`, `/strategies`), **nlq** (`POST /api/nlq`), **llm-ideas** (`LlmOptionsIdeasPanel.tsx` → `/trading/options/llm-ideas`), **schedules** (`ScheduledOptionsManager.tsx`, 2,728 + `AutonomousOptionsRuns.tsx`, 108) | Server discovery via `src/client/options/serverDiscovery.ts` → `POST /api/trading/options/strategies`; run history via `src/client/discoveryApi.ts` → `GET /api/etrade/options/discovery-runs`; downloads via `options/optionsDataExporter.tsx` + `options/optionsIdeasExport.ts` + `discoveryExport.ts` |
| U4 | Schedules (generic) | `src/client/SchedulesPanel.tsx` (517) | Nav "Schedules" | `GET/POST /api/schedules`, `/api/schedules/create`, `/:id/trigger`, `/:id/pause|resume`, DELETE | CRUD for all schedule kinds over the one store |
| U5 | Scheduled Options Manager | `src/client/options/ScheduledOptionsManager.tsx` (2,728) | U3 "schedules" mode | **Same** `/api/schedules` API + `/api/schedules/trigger-screen`, `trigger-options-analysis`, `trigger-discovery`, `/api/options/latest`, `/api/audit` | A second, options-flavoured schedule-management UI over the same store, with run-now triggers and latest-run views the generic panel lacks |
| U6 | Reports | `src/client/ReportsPanel.tsx` (229) | Nav "Reports" ("persisted screener reports from scheduled and manual runs") | `GET /api/reports`, `GET /api/reports/semantic-search` | Browses the canonical `mas_reports` store across kinds |
| U7 | Discovery Runs | `src/client/options/DiscoveryRunsPanel.tsx` (677) | Inside U3 discovery mode | `GET /api/etrade/options/discovery-runs` via `discoveryApi.ts` | Scheduled-discovery run history + CSV/JSON export (`discoveryExport.ts`) |
| U8 | Chat / NLQ | `src/client/Chat.tsx`; NLQ tab inside U3 | Chat + U3 | `POST /api/nlq` | Conversational screening + schedule creation (server: `src/agents/nlq/`) |
| U9 | Research Runs (adjacent) | `src/client/options/ResearchRunsPanel.tsx` (447) | U3 | `/api/research/run|latest|history|evaluate|settings` | Research-pipeline runs — not screening, but another run-history UI pattern in the same hub |

Notes: `src/client/OptionsResearchPanel.tsx` (root) is a 1-line re-export shim for `options/OptionsResearchPanel.tsx`. `src/client/options/strategyDiscoveryEngine.ts` (942) + `blackScholes.ts` remain client-side **as the Builder's modeling layer only** (settled by #29; the panel ranks via the server pipeline) — not a screening path. `FossResearchHub.tsx` is a research surface, not a screener.

## 2. Screening engines (server)

### Stocks — two engines, one of them wired twice

| Engine | File | Inputs | Data source | Outputs | Wired at |
|--------|------|--------|-------------|---------|----------|
| **ScreenerAgent** (the #261 "one backend") | `src/agents/screener-agent.ts` (808); helpers `src/trading/screenerPipeline.ts` (831, `acquireUniverse`/`screenUniverse`/`selectStandouts`), `src/trading/screener.ts` (645, `DynamicMarketScreener` listings), `src/trading/liveScreener.ts` (E*TRADE-primary quotes), config `src/trading/screenerConfig.ts`, universes `src/trading/universes.ts` | `StockScreenerFilter` (`src/types.ts:357`) + `universe` (TECH / NASDAQ100 default / ALL→sharded) + sector/minScore | Nasdaq all-exchange listings for universe + **live E*TRADE quotes**; fails honestly when E*TRADE is unavailable | `ScreenerRunResult`: opportunities (momentumScore, factor grades, technicals), allStocks, scan ledger, per-run PDF/XLSX | `POST /api/etrade/screen` (`src/agents/routes/etradeBroker.ts:302`) → `runScreen`/`runSharded`; scheduled via orchestrator → ScheduledTasksService |
| **YFinanceMarketScreener** | `src/trading/yfinanceScreener.ts` (326) — its **own** `evaluateUniverse`, RSI-14/MACD semantics | `StockScreenerFilter` via `screenMarkets(filters)` | Yahoo Finance FOSS API only | `stocks[]` with price/RSI/volume shape (different row shape) | `POST /api/foss/screen` (`src/agents/routes/fossResearch.ts:183`) — **user-reachable from U1's provider switch** — and `POST /premium/stock-signals` (`src/agents/routes/premium.ts:236`) |

`DynamicMarketScreener` is additionally instantiated inside `ETradeService` (`src/services/etrade.ts:51`) for downstream universe discovery (options flow). `screenerPipeline.ts`'s header claims it is the "single entry point for ALL stock screening" (#259) — in code it is a helper library imported by `screener.ts`/`screener-agent.ts`; the actual entry points are the routes above.

### Options — three engines, four-plus entry points each

| Engine | File | Job | Entry points |
|--------|------|-----|--------------|
| **DynamicOptionsScreener** | `src/trading/optionsScreener.ts` (841) | Raw contract screen: `OptionScreenerFilter` (IV, Greeks, volume, OI, DTE, premium, moneyness…), unusual-activity detection, live E*TRADE chains | `POST /api/trading/options/screen` (`src/agents/routes/etradeOptions.ts:1031`); `POST /premium/options-scan` (`premium.ts:82`); NLQ (`src/agents/nlq/execution.ts:1575,1717`) |
| **OpportunityScanner** | `src/trading/options/opportunityScanner.ts` (class :746) | Strategy-fit scan over the strategy catalog: profiles + fit gate, POP/EV scoring, coverage accounting | Wrapped by **UnifiedOptionsService** (`src/trading/options/unifiedOptionsService.ts`, 1,089) at `POST /api/trading/options/unified` (etradeOptions.ts:1189), scheduled `autonomousOptionsAnalysis` (scheduledTasks.ts:691), and the MCP scanner surface (`src/server.ts:638` forwards `/mcp/scanner` into the orchestrator). **But NLQ constructs it directly** (`src/agents/nlqOptionsStrategy.ts:682`), bypassing the service |
| **OptionsAgentPipeline** | `src/trading/options/index.ts:43` | Per-symbol strategy evaluation / discovery (74-strategy registry) | `POST /api/trading/options/strategies` + `/best-trade` (etradeOptions.ts:986; client `serverDiscovery.ts`); NLQ constructs it directly (nlqOptionsStrategy.ts:537) |

Discovery in the epic-#13 sense (Detect → Infer → Express) does **not** exist as an engine (prior survey stands); "discovery" in code = the pipeline above + scheduled variants (§3).

## 3. Scheduling

**One core store, several creation paths, two schedule UIs, one parallel scheduler.**

- **Store & CRUD:** Agents-SDK schedules inside OrchestratorAgent, managed via `src/services/scheduleManagement.ts` + `src/agents/routes/schedules.ts` (list/create/cancel/pause/resume/trigger/update). User-creatable callbacks are exactly three (`src/agents/orchestrator.ts:130-134`): `autonomousMarketScreen`, `autonomousOptionsAnalysis`, `autonomousStrategyDiscovery`. Execution wrappers (orchestrator.ts:900/1053/1200) delegate to `ScheduledTasksService` (`src/services/scheduledTasks.ts`: `autonomousMarketScreen` :293, `autonomousOptionsAnalysis` :641, `autonomousStrategyDiscovery` :1143 + profile-derived :1441 + no-view :1762 — the #126/#533/#534 input models: saved request / `deriveDiscoveryRequest` in `src/trading/options/discoveryDerivation.ts` / constraints-only).
- **System baselines** (armed in-agent, not user-created): hourly Strategy/Symbol Scanner run `STRATEGY_SCAN_CRON = "35 * * * *"` → `autonomousOptionsAnalysis` (orchestrator.ts:838-872, #275); the 5-minute autonomous market screen (legacy-baseline migration v3, orchestrator.ts:147,200); `collectIvHistory`; `autoRenewETradeTokens`; stale-ledger sweep.
- **Run-now triggers:** `POST /api/schedules/trigger-screen | trigger-options-analysis | trigger-discovery | trigger-retention` (routes/schedules.ts:633/662/732/682) — a second, route-shaped invocation path for the same callbacks, used by U5 and by `server.ts`'s queue handler (options_analysis → trigger-options-analysis).
- **NLQ creation port:** `src/agents/nlq/execution.ts:1142-1200` arms schedules through its own port with its own type model (delayed/scheduled/cron/interval) and arbitrary callbacks (default `sendScheduledReminder`). For `autonomousMarketScreen` it **hardcodes payload `{sector: "Technology", maxItems: 5}`** — a legacy payload contract vs the REST route's universe-based payload (routes/schedules.ts:469).
- **Parallel scheduler:** `ScheduledAgent` DO (`src/agents/scheduled-agent.ts` + `src/schedule.ts`) — goal evaluations with budget checks on the `*/30` worker cron; not screening-specific (QA sweep, opportunity hunt) but a second "run X on a cadence" implementation in the same product.
- **Worker crons** (`wrangler.jsonc`): `0 3`, `*/30`, `0 4` only; everything else rides DO alarms or the */30 tick (`src/server.ts` `scheduled()`).

## 4. Generation / store / serve / delivery

**Canonical store (shared):** `mas_reports`, written via `orm.storeCanonicalReport` (`src/orm/index.ts:980`) with `source` ∈ {`screener` (orchestrator.ts:984,2241), `options_scanner` (orchestrator.ts:1115; scheduledTasks.ts:819; etradeOptions.ts:1251), options-screen route (etradeOptions.ts:1145), premium routes (premium.ts:134,194), `research_report`, `options_research`, `iv_collection`}. Served by `GET /api/reports` (+ semantic search) → U6. Retention decided in #786.

**Per-kind run stores (fragmented):**

| Store | Written by | Served via | Read by |
|-------|-----------|------------|---------|
| ScreenerAgent DO storage: `LATEST_KEY`/`HISTORY_KEY` result cache + PDF/XLSX blobs (`persistRun`, screener-agent.ts:723-808 — explicitly a *delivery cache* since #783) | ScreenerAgent (stock runs, manual + scheduled) | `GET /api/screener/latest` (`src/agents/routes/screenerResearch.ts:89`); `GET /api/screener/report.pdf` / `report.xlsx?key=` | U1 autonomous feed |
| `mas_opportunity_scans` (`SqlScanRunStore`, `src/trading/options/scanRunStore.ts`; 365 d / 1,000-row retention at save) | UnifiedOptionsService paths that pass a store (unified route, scheduled analysis) | `GET /api/etrade/options/scans`, `/scans/diff` | U2 history + exports |
| `mas_discovery_runs` (`SqlDiscoveryRunStore`, `src/trading/options/discoveryRunStore.ts`) | **Only** the three scheduled discovery variants (`scheduledTasks.ts:1263,1660,1927`) — interactive panel runs do not write it | `GET /api/etrade/options/discovery-runs` (etradeOptions.ts:350) | U7 |
| Strategy profiles (`SqlStrategyProfileStore`) | Scanner profile CRUD | `GET/POST /api/etrade/options/profiles` | U2 |

**Blobs:** `src/services/reportBlobStore.ts` — R2 when `REPORTS_BUCKET` is bound, else base64 in DO storage (#605 model; binding removal remains #606, owner's bucket decision).

**PDF generation — two paths despite #914:** `src/services/unifiedReportPipeline.ts` (#914) delegates to ReportAssetAgent (#680, single owner) and is used by `ScreenerAgent.persistRun` and scheduled options analysis (scheduledTasks.ts:771). But the **manual** options routes generate PDFs by direct `generateOptionsPdf` calls + `ScreenerAgent.storeOptionsPdf` (etradeOptions.ts screen block ~:1064-1090 and unified block ~:1217-1240), and `persistRun` itself keeps a direct-generator fallback (screener-agent.ts:766-784).

**Delivery:** stock + scheduled flows publish through `src/events/screenerPublishers.ts` (Slack via cfpay A2A + local fallbacks, email, webhook; #210). The manual options screen route instead calls `deliverScreenerToSlackA2A` directly (etradeOptions.ts, two call sites in the screen block). NLQ/MCP answers are conversational only.

**Client downloads — five exporter modules**, each with its own CSV/JSON builders, filename scheme and download helper: `client/screenerExport.ts` (184), `client/scannerExport.ts` (307), `client/discoveryExport.ts` (358), `client/options/optionsDataExporter.tsx` (254), `client/options/optionsIdeasExport.ts` (337) — plus two server artifact route families (`/api/screener/report.pdf|xlsx` vs `/api/options/report.pdf`).

## 5. Prior consolidation state

Already unified (code-cited):
- **#125/#126** — screening + scanner + discovery are schedulable (the three callbacks), results surfaced in UI, result sets downloadable (e.g. `ScreenerResultsView` per-run CSV exports, ScreenerResultsView.tsx:348-398).
- **#533/#534** — discovery scheduling input models 2 and 3 (profile-derived, no-view) beside saved requests.
- **#783** — ScreenerAgent's dead second `mas_reports` write removed; the canonical copy is stored **once** by the orchestrator at generation time (screener-agent.ts:795-808 comment states the end-state in code).
- **#259/#261** — stock screening converged into ScreenerAgent + pipeline helpers for the E*TRADE path.
- **#914/#680** — unified report pipeline + single PDF owner (ReportAssetAgent) — adopted by scheduled flows and stock persistence, **not** by the manual options routes.
- **#605** — report blob store R2/DO split.

In-flight / adjacent (checked 2026-10-22): open PRs are **dependabot only** — no lane is building this consolidation. Adjacent open issues: **#940** "[UX] Define custom criteria for stock and options screener through UX" (interacts with criteria-schema unification), **#944** (TECH screen bug — separate defect), **#704** (ReportsPanel merge-review, another lane — coordinate any Reports rework), **#581** (autonomous options research pipeline epic — adjacent), **#930** (advertised-surface cleanup — adjacent to UI convergence), #13-#18 (Discovery epic — direction still the user's open decision).

## 6. Duplication / divergence list

| ID | Divergence | Evidence | Severity |
|----|-----------|----------|----------|
| D1 | **Two stock-screen engines behind one UI provider switch**, different criteria support (Yahoo adapter exposes only `search`+`trend` filters, screeningAdapters.ts:28-34), different scoring (momentum/factor grades vs RSI/MACD), different provenance; **FOSS runs store no canonical report** (fossResearch.ts:183-205 audits only) → invisible in Reports/history, unschedulable | screeningAdapters.ts; yfinanceScreener.ts; fossResearch.ts:183 | **User-visible** |
| D2 | **Two schedule-management UIs over one store** with different payload builders and feature sets | SchedulesPanel.tsx vs options/ScheduledOptionsManager.tsx (both `/api/schedules`) | **User-visible** |
| D3 | **Options screening split across three surfaces** (nav Scanner; Trading-Hub hub with 6 modes; ScreenersHub options tab = redirect stub) with different presentations/exports for the same underlying service | NavigationMenu.tsx:436-454; OptionsResearchPanel.tsx:731,1010-1063; ScreenersHub.tsx:872 | **User-visible** |
| D4 | **Five client exporters + two server artifact route families**; CSV semantics differ per panel (standouts vs all-stocks vs scan rows vs discovery) | §4 lists | **User-visible** |
| D5 | **PDF generation dual path**: unified pipeline/ReportAssetAgent vs direct generator calls in manual options routes + persistRun fallback | unifiedReportPipeline.ts; etradeOptions.ts screen/unified blocks; screener-agent.ts:766-784 | Internal (divergent failure behaviour can surface) |
| D6 | **NLQ bypasses UnifiedOptionsService** — constructs OpportunityScanner / OptionsAgentPipeline / DynamicOptionsScreener directly; NLQ scans get no scan-run persistence or profile-store wiring (scanRunStore.ts header: store-less contexts "behave exactly as before") → invisible in Scanner history | nlqOptionsStrategy.ts:537,682; nlq/execution.ts:1575,1717 | Internal → user-visible (missing history) |
| D7 | **Two payload contracts for the same schedule callback**: NLQ hardcodes `{sector:"Technology", maxItems:5}`; REST route uses universe-based payloads | nlq/execution.ts:1156-1162; routes/schedules.ts:469 | Internal |
| D8 | **Premium (x402) endpoints re-implement screen entries** outside the unified surfaces (`/premium/options-scan` → DynamicOptionsScreener; `/premium/stock-signals` → YFinanceMarketScreener, incl. a hard-coded `confidence: 0.88` constant at premium.ts:~243) — they do store canonical reports | premium.ts:82,167,236 | Internal (+ honesty flag on the constant) |
| D9 | **"Run history" is four different stores/queries/shapes** (mas_reports, ScreenerAgent latest/history, mas_opportunity_scans, mas_discovery_runs) with four serve routes | §4 table | Internal → user-visible |
| D10 | **Parallel scheduler** (ScheduledAgent goals) beside the orchestrator schedule store | schedule.ts; scheduled-agent.ts; server.ts */30 tick | Internal (not screening-specific) |
| D11 | ScreenersHub advertises options as "PLANNED" while options screening fully exists elsewhere — IA contradicts the product | screeningAdapters.ts:43; ScreenersHub.tsx:872-886 | **User-visible** (minor) |
| D12 | `screenerPipeline.ts` claims "#259 single entry point for ALL stock screening" but is a helper library; real entries are ScreenerAgent + FOSS route + premium routes | screenerPipeline.ts:1-20 vs §2 | Internal (documentation drift) |

## 7. Target-state sketch

- **Stocks — one implementation:** ScreenerAgent + screenerPipeline is the stock screening engine. One criteria schema (`StockScreenerFilter` + universe model), validated identically at every entry (REST, NLQ, MCP, schedule payload, premium). YFinance becomes a **data-source adapter feeding the same pipeline** (its quotes/indicators as a provider implementation behind `acquireUniverse`), so a "provider" changes data provenance, never semantics, scoring, result shape, or persistence — every run stores a canonical report. (Alternative if the user prefers: retire YFinance from screening; see Open Questions.)
- **Options — one service:** UnifiedOptionsService is the options screening service, exposing three operations — *screen contracts* (DynamicOptionsScreener), *scan strategies* (OpportunityScanner), *discover* (OptionsAgentPipeline) — as internal components. NLQ, MCP and premium call the service, never the components. RawContractsScreener / ScannerPanel / hub modes become views over the service.
- **Scheduling — one path:** the `/api/schedules` store + three callbacks survive; typed payload schemas per callback are the *same schemas* the interactive runs use; the NLQ port delegates to the same creation service (kills D7); trigger-* routes remain as the run-now spelling of the same dispatch. ScheduledOptionsManager folds into SchedulesPanel (one schedule UI with kind-specific sections). ScheduledAgent goals stay, explicitly scoped to non-screening goal evaluations.
- **Generation/store/serve/delivery — one pipeline:** `runReportPipeline` (ReportAssetAgent) is the only PDF path (direct generator calls in routes and the persistRun fallback are deleted or routed through it). `mas_reports` stays the canonical store for every screening kind; the per-kind run stores either fold into it (kind discriminator + detail payload) or remain as detail stores behind **one Runs serve API** (`GET /api/runs?kind=`) that U6/U1/U2/U7 all read. One client exporter module with per-kind column maps replaces the five. Delivery goes through `screenerPublishers` only — the manual options route's direct Slack A2A call is routed through the same publisher.
- **Nothing useful discarded** (standing rule): the Builder's local modeling engine stays (presentation/modeling only, per #29); YFinance's indicator code survives as adapter internals if the provider is kept; all five exporters' column sets survive as column maps in the one exporter; ScheduledOptionsManager's trigger/latest/audit features survive as sections of the one schedule UI.

## 8. Implementation slicing (gitops: one issue → one branch → one PR → merge → post-merge verify, in order)

| Slice | Scope | User-visible value / UI harvest |
|-------|-------|---------------------------------|
| S1 | **Criteria & payload schemas**: single validated schemas for stock filter, options screen/scan/discovery requests, and the three schedule payloads; REST/NLQ/schedule entries all validate through them (no behaviour change beyond rejecting what was silently mis-shaped). Kills D7's contract class | Same criteria produce the same run from panel, chat, and schedule — visible as consistent results across U1/U2/U3/U8 |
| S2 | **NLQ/MCP/premium through the services**: NLQ calls UnifiedOptionsService + ScreenerAgent seams instead of constructing engines; NLQ scans persist scan runs. Kills D6, most of D8 | NLQ-run scans appear in Scanner history (U2) and Reports (U6) |
| S3 | **FOSS convergence**: YFinance as a pipeline data-source adapter (or provider-switch removal, per user decision); FOSS runs persist canonical reports either way. Kills D1 | Every stock screen — any provider — shows in Reports/history and is schedulable |
| S4 | **Single PDF path**: manual options routes + persistRun fallback routed through `runReportPipeline`; direct generator calls deleted. Kills D5 | Consistent report artifacts and failure behaviour across manual/scheduled runs |
| S5 | **One Runs serve API + one history surface**: `GET /api/runs?kind=` over mas_reports + detail stores; ReportsPanel becomes the single run-history UI; `screener/latest`, `scans`, `discovery-runs` become adapters over it (coordinate with #704's owner) | One place to find any run, any kind |
| S6 | **One client exporter**: merge the five exporters into one module with per-kind column maps; all panels import it. Kills D4 | Identical download behaviour (CSV/JSON/PDF) on every surface |
| S7 | **Schedule UI merge**: ScheduledOptionsManager's capabilities (triggers, latest runs, audit) folded into SchedulesPanel; hub schedules mode embeds/links the one panel. Kills D2 | One place to manage every schedule |
| S8 | **Screening UI convergence**: one Screening hub — ScreenersHub hosts stocks + options (scanner + discovery as modes); nav collapses `scanner`+`screeners` into one entry; PLANNED-stub IA removed. Kills D3, D11. Depends on S5/S6 uniformity | One screening home; no dead-end tabs |

Suggested filing shape: one epic issue (the §5 the parent files from this survey) + one issue per slice, each with its own acceptance + test plan, executed merge-first in S1→S8 order (S4 is independent and may move earlier if a small win is wanted).

## 9. Open questions vs already settled

**Genuinely the user's decision:**
1. **YFinance**: keep as a data source inside the one pipeline (S3a) or retire it from screening (S3b)? It is also the premium stock-signals engine and the only non-E*TRADE quote source; retiring changes the FOSS positioning.
2. **Surviving options home**: standalone nav "Scanner" vs Trading-Hub "Auto Options Research" — which surface does S8 keep as the primary? (IA preference, not derivable from directives.)
3. **Discovery epic #13/#14 scope**: is the (still direction-contested) Detect→Infer loop inside this consolidation, or does this work unify only what exists? Recommendation: outside — the run-store/serve unification (S5) already gives #14 its home if it is later built.
4. **Premium x402 endpoints**: fold into the unified service with identical criteria (changes paid-product behaviour) or keep as a separate paid API over the same engines?

**Already settled by standing directives (no decision needed):** one implementation per capability; every capability has a reachable UI; everything schedulable with results in UI and downloadable as a result set; live data only in the product; nothing useful discarded — only true duplicates deleted; per-slice PRs stating value + UX harvest, merged and post-merge verified one at a time.

## 10. Caveats

- Route claims rest on handler greps of the screening-relevant modules (etradeBroker, etradeOptions, fossResearch, premium, schedules, reports, screenerResearch) plus client fetch greps; I did not re-derive the repo's full pinned route inventory.
- "Interactive discovery runs are not persisted" rests on the grep finding exactly three `discoveryRunStore.save` sites, all in `scheduledTasks.ts`.
- NLQ plan→execution mapping was verified at the engine-construction sites, not by tracing every NLQ action name.
- Whether `REPORTS_BUCKET` is bound in production (R2 vs DO blob reality) cannot be established from code — it is the owner's #605/#606 decision state.
