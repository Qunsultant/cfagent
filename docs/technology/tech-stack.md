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
Structured logging + OTel pipeline — you just consolidated it (#5082/#5083); pino/fastify
