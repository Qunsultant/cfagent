/**
 * #1734 (parent #1717, slice (n)): cloudflare / browser / misc MCP
 * unpaired + divergent tools — scan appendix (n). Pure module: no
 * Cloudflare imports, no I/O, no network. This port does NOT resolve
 * a switch: it records the (n) pairing decisions, so a future reader
 * cannot mistake a neighbour for a pair or a distinct operation for
 * a divergence to be merged. The one executable unification in this
 * slice CONSUMES an existing switch instead of inventing one:
 * execute_durable_twap honors #1726's ETRADE_PREVIEW_MODE
 * (local | broker) for its per-slice previews — see
 * src/mcps/openaimp/cloudflareAgentCommands.ts (DurableTWAPOrderCommand).
 * The think pair's one input gap is closed by a field, not a switch:
 * think_trade_validation now forwards accountBalanceUSD to the same
 * harness the REST route already used (see the same file).
 *
 * Pairing vocabulary:
 * - "mcp-only": no REST counterpart exists, and the issue justifies
 *   no new REST route (adding one would be new surface with its own
 *   security review — browser rendering / outbound dispatch / shell
 *   execution are not routes to invent inside a unification slice).
 *   The tool stays MCP-only, explicitly, not by omission.
 * - "confirmed-pair": the scan's candidate IS the same handler on
 *   both surfaces, verified on current main (not assumed).
 * - "distinct-operations": the scan's candidate shares a word
 *   ("backtest") but differs in inputs, engine, data provenance,
 *   and output — routing one to the other would be wrong, so no
 *   switch is built between them.
 * - "divergent-by-design": the two contracts genuinely differ
 *   (different corpus + envelope) and neither is a legacy accident;
 *   pinned with justification per the #1729–#1732 rule, not forced
 *   behind a phantom switch. No endpoint is removed, no code path
 *   is deleted, anywhere in this slice.
 *
 * Resolution order, where a switch IS consumed (TWAP preview):
 *   run > session > user > global env > built-in (local, the TWAP
 *   legacy). Carriers: run = the per-call `mode` input; session /
 *   user = context.scopedEtradeModes (the #1726 carrier, populated by
 *   the execution-context owner); global env = ETRADE_PREVIEW_MODE.
 *   An invalid winning value fails closed to local, logged +
 *   audited as etrade.config_error, with no fall-through to a lower
 *   level (the #1726 resolver's own rule, reused verbatim).
 *
 * What this slice DELIBERATELY does not switch (pins):
 * - N-browser: browser_inspect_page + browser_screenshot stay
 *   MCP-only. POST /api/browser/snapshot is capture + Slack post
 *   (session-gated, #181), and DO transaction-snap is appendix (m)
 *   R06 — both are different operations, not the REST pair of
 *   inspect/screenshot. Do not file snapshot as the pair.
 * - N-webhook: dispatch_trading_webhook stays MCP-only. It is
 *   HMAC-signed OUTBOUND dispatch (fails closed, success:false,
 *   without OUTBOUND_WEBHOOK_SECRET — never signed with a default
 *   secret). POST /trading/reports/webhook is report delivery and
 *   POST /nlq/webhook is INBOUND NLQ — neither is this tool.
 * - N-sandbox: run_sandbox_command stays MCP-only and stays
 *   executed:false under the MCP facade (no container backend
 *   bound). Never present that as executed output, in any envelope.
 * - N-backtest: run_quant_backtest is NOT the pair of POST
 *   /screening/backtest. The MCP tool is a single-symbol strategy
 *   demonstration over a deterministic SYNTHETIC series
 *   (dataSource:"synthetic", sma_crossover / rsi_reversal /
 *   mean_reversion / breakout, startBars); the REST route is a
 *   walk-forward, portfolio-level, options-aware backtest over live
 *   Yahoo daily history (symbols array, folds, holdingBars,
 *   capital, provenance). Different inputs, engine, provenance,
 *   and output — merging them would present synthetic metrics as
 *   live-history results or vice versa.
 * - N-aisearch: ai_search_financial_docs vs knowledge_search
 *   (appendix (c) M01) is divergent-by-design, cross-referenced
 *   here, not double-counted. ai_search searches the SEC-filings /
 *   broker-rules corpus via the AiSearchAgent over the namespace
 *   binding (#3342; formerly the public endpoint), returning
 *   {results, totalMatches, provider} plus a degraded reason when
 *   the instance does not serve; knowledge_search runs the
 *   AI-Search + platform fallback contract returning {count,
 *   chunks, message} (or the platform {count, results, answer}).
 *   #1723's KNOWLEDGE_MODE
 *   governs knowledge_search / query_platform_knowledge ONLY — it
 *   does not govern ai_search, and no switch value routes ai_search
 *   through knowledge_search (that would change corpus + envelope).
 * - N-think: think_trade_validation IS the pair of POST
 *   /etrade/think/evaluate — verified, not assumed: both call
 *   ETradeThinkHarness.evaluateTradeWithThinking with the same
 *   MARKET default. Remaining differences are inherent, not
 *   switchable: the REST route requires the x-user-login header
 *   (401 without it — enforcement, never opt-out), while the MCP
 *   tool's principal is context.sessionId (per #1726, the MCP
 *   sessionId IS the caller's login); symbol casing is not a
 *   difference (the harness uppercases internally). The one input
 *   gap — accountBalanceUSD, accepted by REST but absent from the
 *   MCP schema — is closed by this slice as an optional field.
 * - N-twap: execute_durable_twap stays preview-only in BOTH preview
 *   modes (status "previewed", executed:false, HITL flow required
 *   for real execution). The E04 execute gate
 *   (src/services/etradeExecutionGate.ts) is NOT switchable and is
 *   never routed around: a TWAP preview draft is not an executable
 *   draft bypass — real execution still goes through
 *   etrade_preview_order → etrade_execute_order with an explicit
 *   human decision. The autopilot policy gate, expiry schedule,
 *   and Slack ticket remain REST-preview-only (the #1726 MCP
 *   preview residual, inherited, not re-implemented weaker).
 *   TWAP slices are MARKET equity previews only (the tool takes no
 *   option-leg / stopPrice / assetClass inputs), so the broker
 *   branch has no silent-drop surface to reject loudly.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in resolution
 * order and unit-pinned, but in production today only run
 * (per-call `mode`) and global env are settable — the same boundary
 * as #1721–#1733. Production ETRADE_PREVIEW_MODE values are an
 * owner action; this slice sets none, so unset = local (legacy).
 * Overlap guard: #1763 (separate dedicated builder) owns MCP/A2A
 * invocation-auth verification, tool-attribution audit, prompt-gate
 * wiring, and stable error tokens — none of that is rebuilt here;
 * this slice touches only the (n) pairing decisions above, and its
 * tool-schema additions (TWAP `mode`, think `accountBalanceUSD`)
 * are additive optional fields, not auth/attribution changes.
 */

export type CloudflareBrowserMiscPairing =
  | "mcp-only"
  | "confirmed-pair"
  | "distinct-operations"
  | "divergent-by-design";

export interface CloudflareBrowserMiscPairingDecision {
  tool: string;
  finding: string;
  pairing: CloudflareBrowserMiscPairing;
  /** Nearest REST neighbour, or null when none exists. Never a pair unless pairing says so. */
  restNeighbour: string | null;
  justification: string;
}

/**
 * The (n) pairing decisions. Deliberately NOT a switch table: the
 * only switch this slice consumes (ETRADE_PREVIEW_MODE) already
 * exists under #1726, and inventing a second switch for a pinned
 * pair would be a phantom switch.
 */
export const N_PAIRING_DECISIONS: readonly CloudflareBrowserMiscPairingDecision[] = [
  {
    tool: "browser_inspect_page",
    finding: "N-browser",
    pairing: "mcp-only",
    restNeighbour: null,
    justification:
      "No REST inspect route exists. POST /api/browser/snapshot is capture + Slack post, not inspection; DO transaction-snap is appendix (m) R06. Stays MCP-only.",
  },
  {
    tool: "browser_screenshot",
    finding: "N-browser",
    pairing: "mcp-only",
    restNeighbour: "POST /api/browser/snapshot (different operation — NOT the pair)",
    justification:
      "No REST screenshot route exists. Snapshot captures + posts to Slack (session-gated); the MCP tool returns the capture (or a labelled placeholder, screenshotKind) to the caller. Stays MCP-only.",
  },
  {
    tool: "dispatch_trading_webhook",
    finding: "N-webhook",
    pairing: "mcp-only",
    restNeighbour: "POST /nlq/webhook (inbound NLQ — NOT the pair); POST /trading/reports/webhook (report delivery — NOT the pair)",
    justification:
      "No REST outbound-dispatch route exists. The tool is HMAC-signed OUTBOUND dispatch via ETradeWebhookService, failing closed without OUTBOUND_WEBHOOK_SECRET. Stays MCP-only.",
  },
  {
    tool: "run_sandbox_command",
    finding: "N-sandbox-twap",
    pairing: "mcp-only",
    restNeighbour: null,
    justification:
      "No REST counterpart exists, and the MCP facade binds no container backend, so the tool returns executed:false with exitCode:null. Never present that as executed output. Stays MCP-only.",
  },
  {
    tool: "run_quant_backtest",
    finding: "N-backtest-think-aisearch",
    pairing: "distinct-operations",
    restNeighbour: "POST /screening/backtest (distinct operation — NOT the pair)",
    justification:
      "MCP: single-symbol strategy demo over a deterministic synthetic series (dataSource:\"synthetic\"). REST: walk-forward, portfolio-level, options-aware backtest over live Yahoo daily history. Different inputs, engine, provenance, and output — no switch between them.",
  },
  {
    tool: "think_trade_validation",
    finding: "N-backtest-think-aisearch",
    pairing: "confirmed-pair",
    restNeighbour: "POST /etrade/think/evaluate",
    justification:
      "Verified pair: both surfaces call ETradeThinkHarness.evaluateTradeWithThinking with the same MARKET default. Differences are inherent (REST x-user-login 401 gate vs MCP sessionId principal; harness uppercases internally). accountBalanceUSD gap closed by this slice as an optional MCP field.",
  },
  {
    tool: "ai_search_financial_docs",
    finding: "N-backtest-think-aisearch",
    pairing: "divergent-by-design",
    restNeighbour: null,
    justification:
      "Divergent vs knowledge_search (appendix (c) M01, #1723): different corpus (SEC filings / broker rules vs enterprise knowledge + platform catalog) and different envelope ({results, totalMatches, provider} vs {count, chunks, message}). KNOWLEDGE_MODE governs knowledge_search / query_platform_knowledge only, not ai_search. Cross-referenced, not double-counted.",
  },
  {
    tool: "execute_durable_twap",
    finding: "N-sandbox-twap",
    pairing: "confirmed-pair",
    restNeighbour: "etrade_preview_order preview engine (via ETRADE_PREVIEW_MODE, #1726)",
    justification:
      "No REST TWAP route exists, but the TWAP slices' preview engine IS the #1726 preview pair: local draft vs broker remote preview. This slice adopts it (run > session > user > env > local) instead of hardcoding local. Preview-only in both modes; the E04 execute gate is never switchable.",
  },
];

/**
 * Switches this slice ADDS: none, deliberately. TWAP consumes
 * ETRADE_PREVIEW_MODE (#1726); think closes a field gap; every other
 * (n) item is pinned above. An empty list here is the decision, not
 * an omission — a switch for a pinned pair would be a phantom.
 */
export const N_1734_SWITCHES: readonly string[] = [];
