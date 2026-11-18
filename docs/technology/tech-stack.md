# Technology stack

The one record of what this platform is built on. Three sections, kept
strictly separate: **in use now** (verified from `package.json`,
`package-lock.json`, `wrangler.jsonc`, and the ADRs on current main),
**decided, landing via slices** (ADR 0034), and **proposed replacements —
not yet adopted** (the owner's survey, kept verbatim). Nothing proposed is
presented as in use, and nothing decided is presented as proposed.
Versions are the verified baseline of 2026-11-18; each slice re-verifies
the latest at build time.

## Must-use rule (binding)

FOSS-first (ADR 0034 D4): best-fit FOSS first for every layer and
component; custom code only where no best-fit FOSS piece exists, with
the gap documented. An existing working repo capability always wins
over both FOSS-new and custom-new — a FOSS piece that duplicates an
existing repo capability is out. No auth framework, no sidecar
gateway, no new ORM, no new logging or audit mechanism. One of
everything: no parallel, multiple, similar, or duplicate
capabilities or solutions (repo AGENTS.md). This is the rule that
keeps custom code from being written where a listed technology
already covers the need.

## In use now

| Technology | Version | Where / what for |
|---|---|---|
| TypeScript | ^5.7.0 | The whole codebase (`src/`, `src/client/`) |
| Node.js | 22 | CI Test & Build (Node 22); local toolchain |
| Cloudflare Workers + workerd | wrangler 4.156.0, compat 2026-10-31 | Runtime (`src/server.ts` entry, Worker `ai-search-agent`); workerd for dockerized dev/CI (#5277) |
| React + React DOM | ^19.0.0 | Frontend (`src/client/`, 370 `.tsx` panels) |
| Vite + @vitejs/plugin-react | ^6.0.0 / ^4.3.0 | Frontend build (`vite build`, `vite.config.ts`) |
| Fluent UI React | ^9.75.1 | Client component library; panels build only from `src/client/components/ui/` primitives with token-only styling |
| Zod | ^4.1.8 | Validation everywhere (request shapes, schedule payloads, `src/trading/screeningSchemas.ts`) |
| Drizzle ORM | ^0.45.4 | Data access, D1 standard (ADR 0032); behind CDO ports/adapters |
| mini-ORM (in-repo) | — | Data access, Durable Object standard (ADR 0032); kept by owner decision |
| MCP TypeScript SDK | 1.32.2 + server 2.4.0 | MCP layer (`src/mcps/`, 30 command modules) |
| Agents SDK | 0.32.0 | Agent runtime (Durable Object agents) |
| Cloudflare Think / AI Chat / Voice | 0.23.0 / 0.12.0 / ^0.5.0 | Agentic runtime (ThinkAgents, voice) |
| Vercel AI SDK | ai 7.0.123, @ai-sdk/react 4.0.126, workers-ai-provider 4.0.0 | AI chat / model calls on Workers AI |
| x402 + viem | @x402/core, @x402/evm ^2.28.0; viem ^2.57.2 | Paid scanner route ($0.05 USDC), agentic payments |
| OpenTelemetry | api ^1.10.0; sdk-trace/metrics/logs ^3.1.1; otlp-transformer ^0.301.2 | Observability; module logger seam; outcome catalog |
| D1 | agentdb (`AGENT_DB`) | Relational store (migrations in `src/data/schemaComponent/d1Catalogue.ts`) |
| Durable Objects | 13 classes | OrchestratorAgent, ScheduledAgent, ScreenerAgent, ResearchAgent, TradingAgent, BrowserAgent, SlackAgent, TickerAgent, AiSearchAgent, PaymentsAgent, OptionsScannerMCP, SessionStore, ReportAssetAgent |
| R2 | screener (`REPORTS_BUCKET`) | Report + corpus object storage |
| Queues | 6 bindings | job-pipeline-events (+DLQ), screener-events (+DLQ), screener-events-delivery (+DLQ) |
| Workflows | 5 | trading-trade, screener-screen, payment, saga, job-pipeline |
| Analytics Engine | observability dataset | Observability events |
| Workers AI | `AI` binding | Model inference on the edge |
| Browser Rendering | `BROWSER` binding | Headless browser (fetch/search legs) |
| Email | `EMAIL` binding | Outbound mail |
| Cloudflare AI Search | screener-search, namespace `default` | Corpus search (FINRA 4210, OCC ODD, order-types reference — #1169) |
| Cron triggers + DO alarms | — | Scheduler substrate (feed jobs, chains) |
| Data-provider adapters (not dependencies) | — | E*TRADE (live), Alpaca (live), Yahoo (delayed), Nasdaq (universe only), Public.com — behind the DataProvider ports |
| Vitest + @cloudflare/vitest-plugin | ^5.0.3 / ^1.4.11 | Tests (incl. `test:pins`, workerd suite); jsdom, @vitest/coverage-v8 |
| ESLint + typescript-eslint | ^9.39.5 / ^8.72.2 | Lint |
| pdf-lib, postal-mime, @e965/xlsx, mppx | ^1.17.1 / ^2.7.5 / ^0.20.3 / ^0.13.1 | PDF, MIME, spreadsheet, and document utilities |

## Decided, landing via slices

ADR 0034 (CBO lane, #5343), D4/D5/D11. Versions are the evaluated
baseline of 2026-11-18; each slice re-verifies the latest at build
time and records the pinned version.

| Technology | Version | Decision |
|---|---|---|
| Hono | 4.13.19 | The single API layer, used fully — routing + middleware + ecosystem, not a shim (D5). Sequenced after #1024 Phase 2 adapter design. |
| chanfana | 3.4.0 | OpenAPI generation (`fromHono` wrapper) over @hono/zod-openapi — the incremental strangler fit wins (D4). |
| jose | 6.2.17 | Token verification, behind a token-verification port — chosen over Hono's built-in JWT middleware (D4). |
| @hono/zod-validator | 0.9.1 | Request validation with Hono, on zod schemas (D4). |

Rejected (ADR 0034): Hono v5 (pre-release, re-evaluate at GA);
@hono/zod-openapi (chanfana wins); @cloudflare/workers-oauth-provider
(OUT for the shared-server role — Workers-only and KV-bound, against
the portability rule; the portable provider is an open survey
evaluation); Hono's built-in JWT middleware (recorded
algorithm-confusion history, minimal JOSE coverage, Hono-coupled);
sidecar gateways (Kong, Envoy, Tyk, APISIX, KrakenD — the gateway IS
a Worker); auth frameworks, FOSS identity, FOSS logging, FOSS audit,
other ORMs (each duplicates an existing working repo capability).

## Proposed replacements — not yet adopted (owner survey)

The owner's survey, kept verbatim. Each row is a proposal for its own
issue and slice — adopting one is a build decision, not a doc edit.

Note: the jose row in Tier 1 below is decided — ADR 0034 D4 adopts
jose 6.2.17 behind the token-verification port; it is listed under
Decided above and is not a proposal.

Tier 1 — highest leverage, lowest risk
Replace	With (FOSS)	Why here
Hand-written jsonSchema + zodSchema pairs in 24 MCP tools (src/mcps/openaimp/*, e.g. RunOptionsStrategyScreenCommand)	zod v4's built-in z.toJSONSchema() — you're already on zod ^4.1.8	Two schemas per tool drift; I hit it this week when adding broker/mode/accountId. One definition, generated JSON Schema, no new dependency at all. zod-to-json-schema is already in your lockfile as a transitive dep, but v4 makes it unnecessary.
Custom cron parsing / next-run math (src/client/options/cronTime.ts + consolidatedCronEntries.ts)	croner (MIT, ~5 KB, zero deps, edge-safe)	Cron math and DST are exactly the code people get wrong; yours carries Eastern-time comments defending edge cases. Keep your scheduler (Cloudflare Cron + DO alarms is the right substrate), replace the parser.
src/services/resilience.ts + src/breakers/* (348 lines)	cockatiel (MIT, retry / circuit-breaker / timeout / bulkhead policies)	You already think in policies (breakerPorts, breakerDecorator, inMemoryBreakerAdapter); cockatiel is the same model with the hysteresis and half-open transitions tested. Keep your port interfaces; put cockatiel behind them.
Money as floats (price, totalValue, estimatedTotal throughout orders)	big.js or decimal.js-light (MIT, ~3 KB)	toFixed on binary floats is a rounding bug waiting for the auditor. Use decimal at the order/draft boundary only — not in the screener's hot loops.
JWT/JWS/HMAC helpers + signed links	jose (MIT, WebCrypto-native, already in your tree transitively)	You hand-roll signed approval links and Slack signatures; jose is the audited path for JWS/JWE and works on Workers without polyfills.
Tier 2 — worth it, but scoped to new code
Router: hono is already in your lockfile (transitive). Don't big-bang src/server.ts + the route modules; adopt it for new route groups and let the hand-written dispatch shrink. That's how the size-budget gate stops being a fight.
Tables & charts (client): @tanstack/react-table (headless — fits your ui/ primitives and token styling) and lightweight-charts (Apache-2, TradingView) or uPlot (MIT, tiny) for price/IV series. Your current panels hand-roll both.
Time zones / session boundaries: date-fns + date-fns-tz for the ET midnight token cliff and pre/post-market windows. Temporal is the long-term answer; the polyfill is still heavy for Workers.
Property-based tests for the parsers you keep: fast-check (MIT). Cron expressions, order-type mapping, and the trigger vocabulary are ideal property targets and would have caught the copilot-into-manual|scheduled break I fixed tonight.
CSV: csv-stringify for report output, papaparse for inbound. You write both by hand today.
Schema pins / fixture hashes / census — bespoke by design; they're the guard rails that caught three real defects this week.
Schedule watchdog, saga/workflow orchestration — Cloudflare Workflows + DO alarms are the right substrate; adding a workflow library on top would fight the platform.
Structured logging + OTel pipeline — consolidated (#5082/#5083) on the module logger seam; no new logging library adopted (FOSS logging duplicates the existing capability — ADR 0034 D4).

## Bespoke by design

Some custom code has no FOSS replacement and stays custom by
design: the neutrality census and pin suites (the guard rails that
caught real defects), the audit chain and per-statement audit
events, and the schema pins / fixture hashes. Bespoke-by-design
pieces are named here so no future survey mistakes them for
replaceable custom code.
