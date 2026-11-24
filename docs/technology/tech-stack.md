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

## IROS enablement — FOSS technologies the validated research names (#5520)
Condensed from docs/architecture/enterprise/agentic-IROS.md §9 (full table, maturity, runtime fit, and sources there). License key: [L] license text/header/announcement directly read; [R] reported by a secondary comparison citing the repo (LICENSE file not directly opened — verify before legal reliance); [U] unverified/disputed. No license statement here is legal advice; verify the LICENSE file at the pinned version before distribution or commercial reliance. Research basis: public sources read 2026-11-18, mostly search listings plus 3 pages read in full; no live verification performed.
Capability	Technology	License	Verdict
Durable orchestration	Temporal (server + SDKs)	MIT [R]	ADOPT as durable core (self-host); Temporal Cloud is a proprietary managed service. Server/container, not edge-native.
Durable orchestration	DBOS Transact	MIT [R]	ADOPT if Postgres-centric; Conductor (hosted) is proprietary. Server/container.
Durable orchestration	Restate (server)	BSL 1.1 → Apache-2.0 after 4 yrs [L]	ADAPT with counsel — source-available, not FOSS; SDKs MIT [R]. Server/container.
Durable orchestration	Inngest (server/CLI)	SSPL → Apache-2.0 after 3 yrs [R]; SDKs Apache-2.0 [R]	ADAPT — source-available server; adopt SDKs + hosted, or accept SSPL.
Durable orchestration	Cloudflare Workflows engine	Proprietary hosted service [R]	GAP — no FOSS equivalent of the hosted engine; proprietary edge layer if on Cloudflare.
Durable orchestration	Cloudflare Agents SDK + Think (agents, @cloudflare/think)	MIT [R] for Agents SDK; Think license [U]	ADAPT — MIT code, platform-locked runtime; verify Think license from repo. Edge only.
Durable orchestration	workerd	Apache-2.0 [L]	ADOPT for local/dev/edge-compatible runtime. Not a secure sandbox per Cloudflare.
Durable orchestration	workers-sdk / wrangler / miniflare	MIT OR Apache-2.0 [R]	ADOPT. Dev tooling.
Durable orchestration	AWS Step Functions	Proprietary	GAP — no FOSS equivalent; adopt only if AWS-native.
Streaming/messaging	Apache Kafka	Apache-2.0 [R]	ADOPT for high-throughput streams. Server/container.
Streaming/messaging	Redpanda (core)	BSL 1.1 → Apache-2.0 after 4 yrs [R]	ADAPT with counsel — source-available. Server/container.
Streaming/messaging	NATS	Apache-2.0 [R]	ADOPT for low-latency messaging. Server/container.
Streaming/messaging	Apache Pulsar	Apache-2.0 [R]	ADOPT if multi-tenancy/geo-replication needed. Server/container.
Data layer	PostgreSQL	PostgreSQL License [R]	ADOPT as system of record. Server/container; reachable from Workers via HTTP drivers.
Data layer	SQLite	Public domain [R]	ADOPT for embedded/edge state (D1/Durable Object SQLite).
Data layer	libSQL / Turso	MIT [R]	ADOPT/ADAPT for edge SQLite.
Data layer	DuckDB	MIT [R]	ADOPT for analytics/backtest compute. Server/container (Wasm fit unverified).
Data layer	ClickHouse	Apache-2.0 [R]	ADOPT for tick/columnar analytics. Server/container.
Data layer	Redis	Tri-license RSALv2/SSPLv1/AGPLv3 (8.0+) [R]	ADAPT/AVOID as FOSS — use Valkey instead.
Data layer	Valkey	BSD-3-Clause [R]	ADOPT as Redis-compatible FOSS cache/queue. Server/container.
Data layer	Dragonfly	BSL 1.1 [R]	ADAPT with counsel — source-available. Server/container.
Data layer	pgvector	PostgreSQL License [R]	ADOPT if already on Postgres, up to a few M vectors. Server/container.
Data layer	Qdrant	Apache-2.0 [R]	ADOPT for dedicated vector search. Server/container.
Data layer	Milvus	Apache-2.0 [R]	ADOPT for billion-scale vectors. Server/container.
Data layer	Chroma	Apache-2.0 [R]	ADOPT for dev/small RAG only. Server/container.
Data layer	Weaviate (core)	BSD-3-Clause [R]	ADAPT (open-core). Server/container.
Data layer	Drizzle ORM	Apache-2.0 [R, disputed] — MIT claimed for drizzle-kit / in two 2026 comparisons; verify LICENSE file	ADOPT for TypeScript edge/server data access, pinned version. Edge-native.
Agent frameworks	LangGraph	MIT [R]	ADOPT for graph agents; pair with Temporal/DBOS for durability. Server/container.
Agent frameworks	CrewAI	MIT [R]	ADOPT/ADAPT for role-based crews. Server/container.
Agent frameworks	Mastra	Apache-2.0 except ee/ (Enterprise Edition License 2.0) [R]	ADAPT — open-core; avoid ee/. Server/container.
Agent frameworks	AutoGen	MIT code / CC-BY-4.0 docs [R]; archived by Microsoft	DO NOT ADOPT AutoGen; evaluate Microsoft Agent Framework (MIT [R]).
Agent frameworks	Cloudflare Agents SDK	MIT [R]	ADAPT (platform-locked). Edge only.
Observability	OpenTelemetry (API/SDK/Collector)	Apache-2.0 [L]	ADOPT. SDKs edge-capable; Collector server/container.
Observability	Prometheus	Apache-2.0 [R]	ADOPT. Server/container.
Observability	Grafana / Loki / Tempo / Mimir / Pyroscope	AGPL-3.0 since Apr 2021 [R]	ADAPT with counsel — AGPL; Alloy (agent) Apache-2.0 [R]. Server/container.
Auth/identity/secrets	Keycloak	Apache-2.0 [R]	ADOPT for IdP. Server/container.
Auth/identity/secrets	Ory (Hydra/Kratos etc.)	Apache-2.0 [R]	ADOPT for cloud-native identity. Server/container.
Auth/identity/secrets	OpenBao (Vault fork)	MPL-2.0 [R]	ADOPT for secrets. Server/container.
Auth/identity/secrets	HashiCorp Vault	BSL 1.1 since 2023 [R]	ADAPT/AVOID as FOSS — prefer OpenBao.
Flags/config	OpenFeature (+ flagd)	Apache-2.0 [R]	ADOPT as the vendor-neutral flag standard.
Flags/config	Flagship (Cloudflare)	Proprietary hosted service	GAP: no FOSS Flagship — use OpenFeature/flagd elsewhere. ADOPT if on Cloudflare.
Flags/config	Unleash	AGPLv3 from v8.0.0 [L]; official Docker images Apache-2.0	ADAPT — run unmodified Docker image (Apache-2.0) or accept AGPLv3. Server/container.
Quant/backtesting	vectorbt	Apache-2.0 + Commons Clause [R]	ADAPT with counsel — not FOSS under OSI definition. Server/container.
Quant/backtesting	Backtrader	GPL-3.0 [R]; stale upstream	AVOID for new work (GPL + stale); migrate.
Quant/backtesting	Zipline-reloaded	Apache-2.0 [R]	ADOPT for Quantopian-style equities/futures backtests. Server/container.
Quant/backtesting	QuantLib	BSD-3-Clause [R]	ADOPT for pricing/Greeks. Server/container.
Quant/backtesting	LEAN (QuantConnect)	Apache-2.0 [R]	ADOPT as research→live engine. Server/container.
Quant/backtesting	NautilusTrader	LGPL-3.0 [R]	ADAPT (LGPL obligations). Server/container.
Quant/backtesting	TA-Lib	BSD-2 [R]	ADOPT for indicators. Server/container.
Broker/market-data clients	alpaca-py (official)	Apache-2.0 [L]	ADOPT. Server/container (also JS/Go/.NET/Java official SDKs, Apache-2.0 [R]).
Broker/market-data clients	ib_async (community)	BSD-2-Clause [R]	ADOPT for IBKR socket API; requires TWS/Gateway; not official/affiliated. Server/container.
Broker/market-data clients	IBKR official ibapi	[U] — license not verified	VERIFY license from IBKR distribution before use. Server/container + TWS/Gateway.
Broker/market-data clients	ibind (IBKR Client Portal REST/WS)	Apache-2.0 [R]	ADOPT/ADAPT for REST-style IBKR access. Server/container.
Broker/market-data clients	schwab-py (community)	MIT [R]	ADOPT/ADAPT; verify against current Schwab Trader API. Server/container.
Broker/market-data clients	E*TRADE clients	Mixed/community wrappers; pyetrade license [U]	GAP: no verified official FOSS E*TRADE client — build/adapt wrapper, verify license.
Broker/market-data clients	ccxt (crypto exchanges)	MIT [R]	ADOPT for crypto venues; does not cover equities/options. Server/container.
Broker/market-data clients	yfinance (unofficial Yahoo)	Apache-2.0 [R]	ADAPT with caution — no SLA, rate-limited, delayed; Yahoo has no official public API since 2017.
Q8-driven extras	Feature store / experiment tracking	[U] — Feast/MLflow commonly cited, not verified	GAP/VERIFY — research before adopting.
Q8-driven extras	Eval harness (LLM agents)	[U] — none verified	GAP/VERIFY — FinLake-Bench/FINSABER are benchmarks, not a shipped harness.
Q8-driven extras	FIX engine	[U] — QuickFIX/J etc. commonly cited, not verified	GAP/VERIFY.
Explicit NO-FOSS gaps: (1) consolidated real-time market data (SIP/OPRA feeds + exchange entitlements); (2) exchange/venue connectivity and matching; (3) broker custody, accounts, and execution itself; (4) index membership + GICS licensing (S&P DJI / MSCI / FTSE Russell / Nasdaq); (5) Cloudflare Workflows engine, Temporal Cloud, AWS Step Functions hosted control planes; (6) Flagship hosted flag service; (7) official E*TRADE FOSS client; (8) licensed fundamentals/sentiment datasets as such (the clients may be FOSS; the data is not).

## Data-platform enablement — FOSS libraries the 2026-11-24 survey names (#6458)
Condensed from docs/research/foss-data-platform-libraries.md (full tables, fit verdicts, and sources there). License key: [L] license text/header/announcement directly read; [R] reported by a secondary comparison citing the repo (LICENSE file not directly opened — verify before legal reliance); [U] unverified/disputed. No license statement here is legal advice; verify the LICENSE file at the pinned version before distribution or commercial reliance. Research basis: public sources read 2026-11-24; two sources read live (Marquez README, Data Contract CLI site), the rest search listings plus Nov 2026 round-ups citing project docs/repos; no tool run live against D1.
Headline: no full FOSS catalog fits this stack as-is — the established catalogs need their own Java server plus a Postgres/MySQL store plus a search cluster, and none talks to D1. The tools that fit are small and composable. Metadata of record stays in D1 tables (Drizzle + Zod); heavy tools run outside, on exported snapshots — D1 has no wire protocol, so no SQL-engine tool attaches to live D1. Adoption is per-issue, sequenced per the report §7; nothing here is in use. DuckDB is already named in the IROS section above as ADOPT for analytics/backtest compute — the survey confirms the same tool for the catalog/discovery role; one tool, one adoption, not two.
Capability	Technology	License	Verdict
Analytical query over R2 Parquet	DuckDB	MIT [R]	Fits as-is (library) / dockerized sidecar — replaces DataStudio's analytical half.
Data contracts	Data Contract CLI (ODCS v3)	MIT [L]	Fits as-is (CLI in CI) — replaces hand-written validators and the in-code product registry.
Lineage	OpenLineage, client-only (JSON events → D1)	Apache-2.0 [R]	Fits as-is — zero new infrastructure; Marquez optional later as viewer.
Lineage viewer (later)	Marquez	Apache-2.0 [L]	Fits dockerized as sidecar (Java + Postgres); no auth by default — put behind auth. Release cadence watch (no release since Oct 2024 per a secondary source).
Data quality	GX Core	Apache-2.0 [R]	Fits dockerized / CI sidecar — Expectation suites on exported snapshots. GX Cloud discontinued 1 Jun 2026.
Read-only viewer	Datasette	Apache-2.0 [R]	Fits dockerized as sidecar on exported snapshots — most direct DataStudio-viewer replacement.
Full catalog (deferred)	ODD Platform	Apache-2.0 [R]	Fits dockerized as sidecar (Java + Postgres only) — the only full catalog that fits; adopt last, when the D1-table catalog is outgrown.
Schema drift/lint (CI complement)	Ariga Atlas Community	Apache-2.0 [R]	Fits as-is (CI tool) — declarative diff + drift/lint alongside Drizzle Kit. Default binary is proprietary (MSA); use the community build.
Lakehouse format (via DuckDB)	Apache Iceberg / Delta Lake	Apache-2.0 [R]	Fits as format via DuckDB — adopt only when multi-engine sharing or time travel is needed.
Lakehouse format	DuckLake	MIT [R]	Watch maturity — metadata in SQL tables + Parquet in R2; 1.0 Apr 2026.
Data catalog	DataHub	Apache-2.0 [R]	Does not fit — Kafka + Elasticsearch/OpenSearch + MySQL/Postgres + 7+ containers; no SQLite/D1.
Data catalog	OpenMetadata	Apache-2.0 at root; ingestion/UI under Collate Community License 1.0 [R]	Does not fit — Java server + MySQL/Postgres + Elasticsearch/OpenSearch cluster + Airflow; no SQLite/D1.
Data catalog	Apache Atlas	Apache-2.0 [R]	Does not fit — HBase/JanusGraph + Solr + Kafka + ZooKeeper; Hadoop-centric.
Data catalog	Amundsen	Apache-2.0 [R]	DO NOT ADOPT — archived Sept 2026.
Data quality	Soda Core	Elastic License 2.0 since Jan 2026 [R]	Excluded on license grounds — source-available, not OSI FOSS.
Schema migrations	Liquibase Community	FSL-1.1-ALv2 since 5.0 [R]	Excluded on license grounds — not OSI FOSS.
Distributed query	Trino / Presto	Apache-2.0 [R]	Does not fit — JVM coordinator+worker cluster by design.
Recommended sequencing (report §7): formalise the catalogue as Drizzle tables in D1; ODCS contracts + Data Contract CLI in CI; OpenLineage events from Workers into D1; DuckDB sidecar over R2 Parquet exports (Datasette alongside); GX Core suites on the same snapshots; ODD Platform only if the D1 catalog proves insufficient. Skip DataHub/OpenMetadata/Atlas/Amundsen entirely at this scale.
