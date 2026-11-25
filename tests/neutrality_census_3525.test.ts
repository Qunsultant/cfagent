// @vitest-environment node
/**
 * #3525 S6 — the shrink-only provider-brand census pin (the
 * neutrality programme's final slice).
 *
 * The 2026-11-06 census (issue #3525, comment 6683077178)
 * counted provider-brand mentions over src/, docs/,
 * wrangler.jsonc and README.md with the exact grep patterns
 * reproduced below, and dispositioned every file x term row:
 * PLATFORM (neutralize), INTEGRATION (the provider's own
 * adapters/registries/routes — naming the provider is their
 * job), HISTORICAL (dated records), NOT-PROVIDER (Nasdaq the
 * exchange/index, listed-company names) and FALSE-POSITIVE
 * (the English word "fidelity", SVG <polygon>, "pre-trade").
 * Slices S1-S5 then neutralized the PLATFORM framing rows and
 * pinned the rest as accounted deferrals (provenance naming
 * the actual serving source/route, provider-subject surfaces,
 * data-bearing identifiers, dated records, and landing.ts,
 * which is reserved for the owner's accuracy decision).
 *
 * This pin re-runs that measurement over the same trees and
 * holds the result SHRINK-ONLY against the baseline recorded
 * below, seeded from main at 89f6df7 (2026-11-07, post-S1-S5;
 * reconciliation vs the original census is in the slice's
 * design record):
 *
 *  - a file x term row that is NOT in the baseline fails;
 *  - a row whose matching-line count EXCEEDS its baseline
 *    count fails;
 *  - decreases and vanished rows pass — that is the shrink
 *    the programme wants, and retiring a mention means
 *    lowering or removing its baseline entry in the same PR.
 *
 * Adding or raising a baseline entry is a deliberate,
 * reviewed act: it requires the new row's census disposition
 * and reason, stated in the PR that does it. Integration
 * growth (a new adapter, a new provider route) updates the
 * INTEGRATION section that way; a new PLATFORM row should
 * normally be neutralized instead of baselined.
 *
 * Hermeticity: the pin reads FILES only — never env, never
 * the network, never git — so CI's injected ET_* variables
 * cannot move it. Files with a NUL byte in their first
 * 8,000 bytes are treated as binary and skipped, mirroring
 * git grep (the two .docx files in docs/ count no rows).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Census section 1 patterns, verbatim semantics. */
const TERM_PATTERNS: Array<[string, RegExp]> = [
  ["etrade", /etrade|e-trade|e\*trade/i],
  ["public.com", /public\.com|publiccom/i],
  ["alpaca", /\balpaca\b/i],
  ["schwab", /\bschwab\b/i],
  ["fidelity", /\bfidelity\b/i],
  ["robinhood", /\brobinhood\b/i],
  ["webull", /\bwebull\b/i],
  ["thinkorswim", /\bthinkorswim\b/i],
  ["interactive brokers / ibkr", /interactive brokers|ibkr/i],
  ["tradier", /\btradier\b/i],
  ["tastytrade", /tastytrade|tasty/i],
  ["yahoo", /\byahoo\b/i],
  ["nasdaq", /\bnasdaq\b/i],
  ["polygon", /\bpolygon\b/i],
  ["finnhub", /\bfinnhub\b/i],
  ["twelvedata", /twelvedata|twelve ?data/i],
];

const SCOPE_FILES: string[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walk(path); // entry: the directory entry being classified
    else SCOPE_FILES.push(path);
  }
}
walk("src");
walk("docs");
SCOPE_FILES.push("wrangler.jsonc", "README.md");
SCOPE_FILES.sort();

/** Measured rows: "file<TAB>term" -> matching-line count. */
function measure(): Map<string, number> {
  const rows = new Map<string, number>();
  for (const file of SCOPE_FILES) {
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary, as git grep
    const lines = buf.toString("utf8").split("\n");
    for (const [term, pattern] of TERM_PATTERNS) {
      let n = 0;
      for (const line of lines) if (pattern.test(line)) n++;
      if (n > 0) rows.set(`${file}\t${term}`, n);
    }
  }
  return rows;
}

/**
 * The baseline: [file, term, matching lines at seed time],
 * grouped by census disposition. PLATFORM rows are the
 * S1-S5 slices' accounted deferrals, by territory:
 *  - S2 client copy (src/client/**): provenance naming the
 *    actual serving provider, provider-subject panels,
 *    code identifiers/types, the data-bearing storage key,
 *    per-provider workflow/copilot entries, and landing.ts
 *    (owner-reserved accuracy decision);
 *  - S3 defaults/onboarding: the fail-to-legacy tenant
 *    default contract and the order ticket's selected-broker
 *    provenance (incl. the #3669 selected-broker growth);
 *  - S4 services (platformKnowledge.ts, trading-agent.ts,
 *    interfaces.ts): provenance data-source lists, route
 *    paths, per-provider execution entries;
 *  - S5 live docs (docs/**, README.md): provenance
 *    enumerations, integration-subject docs, dated records
 *    in substance, data-bearing names, identifier
 *    inventories, the landing-mirrored disclaimer;
 *  - S1 corpus: the seed manifest's remaining entries.
 * Post-census rows (new files since bd81ecd7) were
 * dispositioned at seed time: the pipeline/job-system
 * provider-id registries and provider wiring are
 * INTEGRATION; docs/plans completion records are
 * HISTORICAL; "Nasdaq-100" in a port comment is
 * NOT-PROVIDER.
 * Baseline repair (#3761, 2026-11-08): the MCP server
 * inventory (docs/architecture/agentic/
 * mcp-server-inventory.md, landed in cd76eba2) names the
 * providers its servers integrate — provenance naming of
 * the serving integration — dispositioned INTEGRATION
 * (3 rows / 11 lines: alpaca 4, etrade 5, yahoo 2). The
 * seed pin totals move 1092/8522 -> 1095/8533 with it.
 * Baseline update (#3782, 2026-11-08): the Stock Copilot fix adds
 * two Alpaca MCP tools (alpaca_get_quote, alpaca_preview_order) and
 * routes the copilot to Alpaca, so provider-brand mentions grow in
 * the provider's own adapters/registries/routes and in the copilot
 * steering — all dispositioned INTEGRATION (naming the provider is
 * their job): 3 new rows (chatPrompt.ts/alpaca 1, marketDataCommands
 * .ts/etrade 3, mcpPermissionPorts.ts/alpaca 3) and 10 raises
 * (chatPrompt.ts/etrade 6->7, mcpEndpointsData.ts/alpaca 11->13,
 * commands.ts/alpaca 1->3, commands.ts/etrade 22->23,
 * etradeCommands.ts/etrade 118->119, marketDataCommands.ts/alpaca
 * 29->43, mcpPermissionPorts.ts/etrade 8->9, etrade.ts/etrade
 * 121->123, marketDataResearch.ts/alpaca 104->106, alpaca/platform
 * .ts/alpaca 109->111). Seed pin totals move 1095/8533 -> 1098/8568.
 * Baseline repair (#3798, 2026-11-08): the code standards set
 * (PR #3793, issue #3791) landed 16 files under
 * docs/architecture/code/ and took main red on this pin: two of
 * the new files carry etrade rows the census had never seen.
 * Both are dispositioned INTEGRATION - standards documents
 * naming the provider their subjects integrate: the MCP file
 * quotes the mcp-security.md S5 gate question verbatim
 * ("inherited gates - E*TRADE, keys, memberships, audit"), and
 * the structure file cites the provider's own file-budget
 * precedent tests/identifiers (etrade_routes_resplit_995,
 * etrade_broker_portfolio_risk_split_2943, etradeOptions.ts).
 * Neutralizing either would falsify a quote or a test name.
 * 2 new rows (10-mcp-standards.md/etrade 1,
 * 13-structure-and-file-organization.md/etrade 6). Seed pin
 * totals move 1098/8568 -> 1100/8575.
 * Baseline update (#3788, 2026-11-09): the schedule watchdog wraps
 * the four internal-only callbacks so their firings leave a per-run
 * record, and the wrapper names the callback it records — the
 * token-renewal callback's own name is the provider brand, so two
 * code rows grow and cannot be neutralized without renaming the
 * callback (out of scope, behavioral): 1 new row
 * (scheduleCallbacks.ts/etrade 1, the RECORDED_SCHEDULE_CALLBACKS
 * list) and 1 raise (orchestrator.ts/etrade 19->20, the new string
 * literal passed to the recorder in the token-renewal wrapper).
 * Three prose mentions were neutralized instead (the wrapper
 * comments, the inventory answer, the durable doc's table). Seed
 * pin totals move 1100/8575 -> 1101/8577.
 * Baseline update (#3812, 2026-11-09): the AAPL bracket RCA makes Alpaca
 * the default broker and adds percent exits, provider connect links, and
 * a trading-run trace. Provider-brand mentions grow only where naming
 * the provider is the job — the Alpaca connect URLs, the trace's broker
 * field, and the RCA document itself — all dispositioned INTEGRATION:
 * 4 new rows (docs/agents/rca-aapl-bracket-order-3812.md alpaca 16 /
 * etrade 7, src/services/providerUxLinks.ts alpaca 11,
 * src/services/tradingRunOutcome.ts alpaca 2). Seed pin totals move
 * 1101/8582 -> 1105/8641.
 * Baseline update (#3787, 2026-11-09): the screener-chain repair's
 * durable doc names the feed jobs by their provider ids
 * (`yahoo/alpaca/etrade/public-nasdaq100-quotes`) — naming the
 * provider is the feed integrations' job, so the doc's 3 provider
 * rows are dispositioned INTEGRATION and its NASDAQ-100 index row
 * NOT-PROVIDER (the index name, per the post-census precedent).
 * The two prose enumerations that named the same providers in code
 * comments were neutralized instead (the `feed` catalog blurb in
 * src/orchestrate.ts and the feed-goal comment in src/schedule.ts:
 * "provider quotes + fundamentals"), so no code rows are added.
 * 4 new rows (docs/architecture/security/
 * screener-chain-stuck-repair-3787.md alpaca 1 / etrade 1 /
 * yahoo 1 / nasdaq 1). Seed pin totals move 1105/8641 -> 1109/8645.
 * Baseline update (#3866, 2026-11-09): the portfolio-read RCA normalizes the
 * Alpaca base URL and makes the status name the URL in use, so the provider's
 * market-data module gains one Alpaca mention — INTEGRATION, the adapter's own
 * name for its own host.
 *
 * Baseline repair (#3866, 2026-11-09): the platform lifecycle document added by
 * the CPO lane (`docs/architecture/agentic/…-lifecycle.md`, #3864/#3868) landed
 * with five provider-brand rows and no disposition, so `main` was red on this
 * pin before this branch existed. They are baselined as INTEGRATION — a
 * lifecycle table that names the brokers it covers — instead of being edited
 * from another lane's branch.
 *
 * Baseline update (#3876, 2026-11-09): the S&P 500 universe joins
 * the feed workflow as a Yahoo quotes feed job - one registry
 * definition in the feed-job registry and one entry in the feed
 * pipeline catalog. Both files are the provider-id registries
 * (INTEGRATION at seed: naming the provider is their job), and
 * the only growth is the new job's own id/label lines: 2 raises
 * (feedJobs.ts/yahoo 10->12, feedPipelineJobs.ts/yahoo 15->19).
 * Recorded-seed totals move 1121/8729 -> 1121/8735.
 * Baseline update (#3838, 2026-11-09): externalize Stock Copilot prompts
 * into src/agents/prompts/stockCopilotPrompt.ts (dispositioned INTEGRATION:
 * names the provider its agent tools integrate — Alpaca Paper trading for
 * Stock Copilot and steers away from E*TRADE tools on copilot turns).
 * 2 new rows (stockCopilotPrompt.ts alpaca 11 / etrade 4). Seed pin
 * totals move 1109/8645 -> 1111/8660.
 * Baseline update (#3905, 2026-11-09): the Dow universe joins
 * the feed workflow as a Yahoo quotes feed job - one registry
 * definition in the feed-job registry and one entry in the feed
 * pipeline catalog. Both files are the provider-id registries
 * (INTEGRATION at seed: naming the provider is their job), and
 * the only growth is the new job's own id/label lines: 2 raises
 * (feedJobs.ts/yahoo 12->14, feedPipelineJobs.ts/yahoo 19->23).
 * Recorded-seed totals move 1121/8735 -> 1121/8741 on this slice's own
 * base; composed with #3883's cancellation-surface update (1124/8745)
 * and #3884's cancel-ticker record (+5 lines, 1124/8750) the merged
 * recorded seed is 1124 rows / 8756 lines.
 * Baseline update (#3796, 2026-11-09): the surface-parameterized
 * voice routes put the trading-desk surface's #3429 broker gate
 * in the voice route family (src/agents/routes/copilotChannels
 * .ts): the gate compares the tenant's selected broker against
 * the desk's broker because refusing BY NAME is the gate's job
 * (the refusal it composes names the selection and the surface
 * to use instead). Dispositioned INTEGRATION — the gate is part
 * of the desk integration's own enforcement, in its route.
 * 1 new row (copilotChannels.ts/etrade 1). Composed on the
 * 1124 rows / 8756 lines seed: totals move 1124/8756 -> 1125/8757.
 * Baseline update (#3911, 2026-11-09): the pipeline stage-order rule names the
 * feed/chain job ids the copilot must invoke verbatim, so the steering gains one
 * Yahoo row in stockCopilotPrompt.ts — dispositioned INTEGRATION (data-bearing
 * identifiers, not framing). The rule's prose comment was neutralized instead
 * (the incident sentence names the fundamentals feed job and the quotes dataset
 * without the provider brand), so the row is the rule line alone. Seed pin
 * totals move 1125/8757 -> 1126/8758.
 * Baseline update (#3931, 2026-11-10): the parameterized Yahoo technicals job
 * joins the feed workflow — one registry definition in the feed-job registry,
 * one entry in the feed pipeline catalog, the persisted-first read in the
 * screener's history deps, the ATR field in the technicals computation, and
 * the ATR column + persisted-source labels in the screener results view.
 * All six files are the provider-id registries / the provider's own
 * history-and-technicals modules (INTEGRATION at seed: naming the provider
 * is their job), and the only growth is the new job's own id/label lines,
 * the persisted-read wiring, and the source labels: 6 raises
 * (feedJobs.ts/yahoo 14->18, feedPipelineJobs.ts/yahoo 23->27,
 * feedPipelineJobs.ts/nasdaq 18->19, platformHistory.ts/yahoo 21->24,
 * technicals.ts/yahoo 9->12, ScreenerResultsView.tsx/yahoo 5->8).
 * Recorded-seed totals move 1131/8832 -> 1131/8850.
 * Baseline update (#3932, 2026-11-10): the parameterized Yahoo sentiment job
 * joins the feed workflow — one registry definition in the feed-job registry,
 * one entry in the feed pipeline catalog, the `news` capability declared on
 * the Yahoo adapter (with the Yahoo News search fetch + conformance probe),
 * the persisted sentiment dataset definition, and the sourced-sentiment
 * column + Day action column + source labels in the screener results view
 * (and the sourced definition in the XLSX field catalog). All ten files are
 * the provider-id registries / the provider's own news-and-sentiment modules
 * (INTEGRATION at seed: naming the provider is their job), and the only
 * growth is the new job's own id/label lines, the news-capability wiring,
 * the dataset definition, and the source labels: 1 new row
 * (feedDatasetPorts.ts/yahoo 3) and 10 raises (feedJobs.ts/yahoo 18->26,
 * feedJobs.ts/nasdaq 9->10, feedPipelineJobs.ts/yahoo 27->31,
 * feedPipelineJobs.ts/nasdaq 19->20, adapters.ts/alpaca 8->10,
 * adapters.ts/yahoo 15->28, contract.ts/yahoo 8->12,
 * screenerPipeline.ts/yahoo 77->79, ScreenerResultsView.tsx/yahoo 8->11,
 * screenerReportXlsx.ts/yahoo 4->7).
 * Recorded-seed totals move 1134/8850 -> 1135/8894.
 * Baseline update (#3751, 2026-11-09): ProviderIdentity — the display-name
 * data of the tenant-provider server module is restructured into the ONE
 * identity map (INTEGRATION: naming the provider is that module's job) and
 * the context module resolves names from it, so the two server modules
 * gain alpaca lines while their stale pre-#3812 default comments retire
 * etrade lines (tenantProviders.ts alpaca 7->10 / etrade 13->11;
 * optionsProviderContext.ts alpaca 3->5 / etrade 16->14). The providers
 * route serves the resolved identity, naming the default broker in its
 * corrected comment (1 new row: routes/reports.ts alpaca 1). On the
 * client, the tenant state module gains the identity-projection prose
 * (tenantProviders.ts alpaca 8->9 / etrade 5->4) and stockCopilotApi.ts
 * DELETES its private broker-name copy for the projection
 * (alpaca 2->1; its etrade row retires outright). Composed onto the
 * post-build main: #3857's correction of the same tenantProviders.ts
 * header comment adds one etrade line back (11->12), and #3885's
 * cancel-all rows landed on main after this slice's base (brokerOrders
 * .ts alpaca 5->6, cancelOrderCommands.ts alpaca 3->5, 1 new row
 * CancelAllControl.tsx alpaca 8 - #3885's own disposition).
 * Net composed vs the ship-time main (1127 rows / 8769 lines on the
 * tip's own baseline): rows 1127 -> 1127, lines 8769 -> 8770.
 * Baseline update (#3050, 2026-11-10): the hub's last four inline
 * sub-tabs move into shell panels (PortfolioPanel, LedgerPanel,
 * OmnichannelPanel, VoicePanel). The moved markup is the Hub's, so its
 * 11 provider-brand lines relocate with it (Hub etrade 114->103, an
 * INTEGRATION shrink) and the panels carry exactly those 11 lines
 * (PortfolioPanel 5, OmnichannelPanel 3, VoicePanel 3; LedgerPanel none)
 * — provider-subject panels and code identifiers, the S2 client-copy
 * PLATFORM deferral territory per the OrderTicketPanel precedent, not
 * framing. The panels' props interfaces were neutralized instead of
 * baselined: the Broker* aliases (BrokerAccount, BrokerPosition,
 * BrokerQuote, BrokerOrderDraft — the ETrade* names are deprecated
 * aliases for them) and onTradeOrder/onNavigateOrder props, so no new
 * identifier rows are added. Net zero on the census population
 * (11 moved, 11 new); the platform slice grows 186 -> 189 rows and its
 * total 1039 -> 1050 lines, the integration total 6526 -> 6515.
 * Baseline update (#3937, 2026-11-10): cancel-ticker / cancel-all serve
 * the selected broker, so the route dispatches the cancel port by broker
 * id — one more comparison (the helper dispatch) while the two retired
 * alpaca-only gates are replaced by the two ledger conditionals, net
 * brokerOrders.ts alpaca 6->7. Dispositioned INTEGRATION (the #3883
 * note above the row): selecting the engine by broker id is the
 * route's job. The surrounding comments were neutralized instead
 * (five prose mentions), and the cancel engine's own rows do not move.
 * Baseline update (#3937, 2026-11-10): the hub's diagnostics fallback is
 * the platform default (alpaca), not the legacy etrade fallback, so
 * TradeHub.tsx alpaca 23->24 while etrade 114->103 shrinks via
 * #3050's move. Dispositioned INTEGRATION — the fallback names the broker
 * the diagnostics run against, which is the hub integration's job. The
 * panel itself shrinks (BrokerPanel.tsx alpaca 38->8, etrade 4->3)
 * and needs no baseline change. The broker panel mount moved to
 * PortfolioPanel.tsx (#3050); the selected broker is passed there.
 * Baseline update (#4002, 2026-11-10): the feed-job monitoring rule
 * names the sentiment job id the copilot must check verbatim, so the
 * steering gains one Yahoo row in stockCopilotPrompt.ts — dispositioned
 * INTEGRATION (a data-bearing identifier, not framing), the #3911
 * precedent: the rule's prose comment was neutralized instead (it names
 * the sentiment job without the provider brand), so the row is the rule
 * line alone. One raise (stockCopilotPrompt.ts/yahoo 1->2).
 * Baseline update (#3990, 2026-11-10): Public.com joins as a live broker
 * and the data-provider/broker taxonomy splits (defaults alpaca/alpaca,
 * Alpaca optionsChains in the data adapter, Public trading platform +
 * five copilot tools, public-mode screening). 17 new rows, all
 * dispositioned INTEGRATION — the provider's own adapters, command
 * modules, registry entries, trading client, platform, outcome code
 * and token card name the provider they serve, which is their job
 * (the copilot commands name their Alpaca/E*TRADE mirrors in their
 * header, the #3782 precedent): BrokerDynamicMenu nasdaq 1,
 * PublicTokenCard public.com 15 / alpaca 1, commercialPorts yahoo 2,
 * commands.ts public.com 2, publicCommands.ts etrade 3 / public.com 12
 * / alpaca 4, publicTradingMcp.ts public.com 1, outcomeCatalog.json
 * public.com 1, publicTrading.ts public.com 4, brokerCatalog.ts
 * public.com 4, brokerPresentation.ts public.com 4, public/platform.ts
 * public.com 11 / alpaca 2, screenerPipeline.ts public.com 3. 21 raises
 * in the same modules (capability-matrix comments, the taxonomy kind
 * map, the Alpaca options extraction, the Public catalog entry):
 * copilotTradingMode alpaca 8->9, brokerConnect alpaca 21->22,
 * screener-agent etrade 69->71 / alpaca 15->18, BrokerDynamicMenu
 * etrade 24->25 / yahoo 6->7, client tenantProviders alpaca 9->10,
 * commercialPorts alpaca 3->8, optionsProviderContext alpaca 5->7 /
 * yahoo 3->4, services tenantProviders public.com 1->2 / alpaca 10->11,
 * optionsData etrade 2->5 / alpaca 14->23, brokerCatalog alpaca 18->19,
 * adapters alpaca 10->20 / yahoo 28->32, contract etrade 19->22 /
 * alpaca 5->9 / yahoo 12->14 / nasdaq 3->5. The MCP inventory doc
 * gains its first public.com row (2 lines: the Public.com tool row
 * and the read-scope mention) and the scope table's Alpaca comments
 * grow it 3->6 — same INTEGRATION disposition (the inventory names
 * the providers its servers integrate; the scope table is the
 * registry). The PLATFORM slice is
 * untouched (still 189 rows / 1050 lines). Totals move 1135/8912 ->
 * 1152/9045.
 * Follow-up in the same PR (mesh family + OASF map + audit doc):
 * registry.ts public.com 1->5 / alpaca new (1), oasfRecords.ts
 * public.com new (1), ADR 0028 new (etrade 10 / public.com 7 /
 * alpaca 24 / yahoo 11 / nasdaq 4), adr README public.com new (1) /
 * alpaca 1->2, data-provider-platform.md etrade 1->8 / public.com
 * 1->3 / alpaca 1->13 / yahoo 1->8 / nasdaq 1->5 (the #3990 section
 * written after the first baseline update). Totals move 1152/9045 ->
 * 1160/9141.
 *
 * Baseline update (#3992 PR-5, 2026-11-11): the feed-run residency
 * decision doc names the #3976 incident job by its exact id
 * (`yahoo-nasdaq100-quotes`) — a data-bearing identifier, the job's
 * registered name, not platform framing; the #3911/#4002 precedent
 * (a job id named verbatim is baselined, its prose neutralized, never
 * the id rewritten). One new row, dispositioned INTEGRATION:
 * feed-run-residency-and-scheduled-silence-3992.md yahoo 1. The rest
 * of the doc and its companion fragment name no provider brand.
 * Baseline update (#4065, 2026-11-11): the options-chains feed
 * jobs land — one options-chains job per optionsChains-serving
 * source (etrade, alpaca, public), each a parameterized
 * definition on the #3930 idiom, with a persisted
 * options-chains dataset. 0 new rows, 7 raises, all
 * dispositioned INTEGRATION — the pipeline/job-system
 * provider-id registries and provider wiring name the provider
 * they serve, which is their job (the seed-time disposition):
 * the growth is the new jobs' own id/label/sourceId/alias
 * lines only (feedJobs.ts alpaca 5->7 / etrade 5->7 / nasdaq
 * 10->11; feedPipelineJobs.ts alpaca 5->9 / etrade 4->8 /
 * nasdaq 20->23 / public.com 2->3). The prose brand mentions
 * were neutralized instead: the registry comment names the
 * three serving sources without brands, the runner's evidence
 * note drops its brand parenthetical, and the dataset
 * definition uses the neutral BrokerOptionChain /
 * BrokerOptionExpireDate aliases (the non-deprecated names) —
 * so no feedDatasetPorts.ts etrade row is created and the
 * feedJobs.ts yahoo row does not move. The PLATFORM slice is
 * untouched (still 189 rows / 1050 lines). Totals move
 * 1161/9142 -> 1161/9159.
 * Baseline update (#4190, 2026-11-12): the screener substrate (#3550 S1)
 * adds six ScreenerAgent stage methods that duplicate runScreenInner's
 * per-stage provider branches (the live path is untouched in S1; the
 * stage methods name the provider their branch serves, exactly as the
 * bodies they mirror do) — dispositioned INTEGRATION, the provider
 * branches' own names: 4 raises (screener-agent.ts etrade 71->85 /
 * alpaca 18->22 / yahoo 58->66 / nasdaq 7->10). The counts fall back
 * when S2 repoints the live path at the engine and the duplicated
 * branches are retired. Totals move 1161/9142 -> 1161/9171.
 * Baseline update (#4193, 2026-11-12): the S&P 400 universe joins
 * the feed workflow as a Yahoo quotes feed job - one registry
 * definition in the feed-job registry and one entry in the feed
 * pipeline catalog. Both files are the provider-id registries
 * (INTEGRATION at seed: naming the provider is their job), and
 * the only growth is the new job's own id/label lines: 2 raises
 * (feedJobs.ts/yahoo 26->28, feedPipelineJobs.ts/yahoo 31->35).
 * Baseline update (#4216, 2026-11-12): the four GICS sector universes join
 * the feed workflow as Yahoo quotes feed jobs (Energy, Materials,
 * Industrials, Consumer Discretionary) - one registry definition per
 * sector in the feed-job registry and one entry each in the feed
 * pipeline catalog. Both files are the provider-id registries
 * (INTEGRATION at seed: naming the provider is their job), and
 * the only growth is the new jobs' own id/label/alias lines: 2 raises
 * (feedJobs.ts/yahoo 28->34, feedPipelineJobs.ts/yahoo 35->52).
 * Totals move 1175/9224 -> 1175/9247.
 * Baseline update (#4066, 2026-11-12): per-stage chat control of
 * options stages lands — the control module, its mesh door, and the
 * extracted canonical-record-builder leaf. 3 new rows + 1 raise, all
 * dispositioned INTEGRATION — the E*TRADE client is the control
 * path's own provider (the stage ports are built over it), and the
 * builder's fail-open provenance names the provider pair it
 * resolves: meshOptionsStageControlDoor.ts etrade 8 /
 * optionsStageControl.ts etrade 5 / manualOptionsRecordBuilder.ts
 * etrade 1 / execution.ts etrade 77->82 (the NLQ dispatch branch
 * naming the E*TRADE client it threads to the control). The prose
 * brand mentions were neutralized instead: the control refusals
 * name the stage + reason with no provider brand, and the leaf
 * extraction keeps the builder's provider naming in the one leaf
 * that owns it. The manualOptionsScreen.ts etrade row shrinks
 * 4->3 (the builder moved out) and is left at its seed count.
 * Baseline update (#4225, 2026-11-12): the next four GICS sector universes join
 * the feed workflow as Yahoo quotes feed jobs (Consumer Staples,
 * Health Care, Financials, Information Technology) - one registry definition per
 * sector in the feed-job registry and one entry each in the feed
 * pipeline catalog. Both files are the provider-id registries
 * (INTEGRATION at seed: naming the provider is their job), and
 * the only growth is the new jobs' own id/label/alias lines: 2 raises
 * (feedJobs.ts/yahoo 34->40, feedPipelineJobs.ts/yahoo 52->71).
 * Totals move 1178/9266 -> 1178/9291.
 * Baseline update (#4250, 2026-11-12): the last three GICS sector universes join
 * the feed workflow as Yahoo quotes feed jobs (Communication Services,
 * Utilities, Real Estate) - one registry definition per
 * sector in the feed-job registry and one entry each in the feed
 * pipeline catalog. Both files are the provider-id registries
 * (INTEGRATION at seed: naming the provider is their job), and
 * the only growth is the new jobs' own id/label/alias lines: 2 raises
 * (feedJobs.ts/yahoo 40->45, feedPipelineJobs.ts/yahoo 71->85).
 * Totals move 1178/9291 -> 1178/9310.
 * Baseline update (#4192, 2026-11-12): the screener cutover
 * (#3550 S2) moves runScreenInner's platform quote/history
 * binding into shared agent methods (bindScreenerQuoteDeps /
 * bindScreenerHistoryDeps) so the stage methods bind the deps
 * themselves when the step handler omits them — the blocks move
 * verbatim, and the only growth is the binding's own names:
 * the method signature + guard + return legs + call sites:
 * 3 raises (screener-agent.ts etrade 85->94 / alpaca 22->24 /
 * yahoo 66->68), dispositioned INTEGRATION — the binding names
 * the provider its leg serves, which is its job (the #4190
 * precedent). Recounted at ship: the etradeService parameter
 * threading at the stage call sites added two more named lines
 * after the first count (92->94). The counts fall back when the
 * duplicated runScreenInner branches are retired.
 * Totals move 1178/9310 -> 1178/9323.
 * Baseline update (#4279, 2026-11-12): the goal stock leg's engine
 * runner (#3550 S4) shares the options-leg deps builder with the
 * direct runGoalScreen — the builder takes the trade client as a
 * parameter, so the threading names the provider at the builder's
 * signature: 1 raise (screener-agent.ts etrade 94->95),
 * dispositioned INTEGRATION — the binding names the provider its
 * leg serves, which is its job (the #4193 precedent: etradeService
 * parameter threading). The two goal runners share ONE trade-client
 * construction (tradeService), so the trading-extraction ledger
 * stays at 3. The Yahoo rows this slice first added were
 * neutralized instead of baselined (the leg's provider literal is
 * reused from the goal command's type, and the engine runner's doc
 * comment no longer names the provider). The counts fall back when
 * the direct runGoalScreen (chain-mode only after S4) is retired
 * by S5 #4280.
 * Totals move 1178/9323 -> 1178/9324.
 * Baseline update (#4289, 2026-11-13): the options workflow host
 * composes the options steps into the workflow residency, binding
 * the chain source to the provider's client in
 * optionsStepDepsForWorkflow — 1 new row
 * (jobPipelineWorkflow.ts etrade 2: the import + construction),
 * dispositioned INTEGRATION — the binding names the provider its
 * leg serves, which is its job (the #4192/#4279 precedent). The
 * prose around it is neutralized (no brand in the comments), the
 * shared rebuild module carries no brand row, and the count falls
 * back when provider selection (#3960) replaces the direct binding.
 * Totals move 1178/9324 -> 1179/9326.
 * Baseline update (#4430, 2026-11-13): the hub's broker-gate 409 offers a
 * user-invoked switch to the workflow-backed variant, so two user-facing
 * labels name the provider they switch to — the switch button in
 * StockHub.tsx and the 409 remediation message in paidScreenSubmit.ts —
 * dispositioned PLATFORM (S2 client copy: the action's label names the
 * provider it switches to, so the user can choose knowingly; the label
 * is the action's subject, not framing). The variant's registry id is
 * named verbatim in its own module (screeningAdapters.ts/yahoo 3->4),
 * dispositioned INTEGRATION — a data-bearing identifier, the #3911
 * precedent (an id named verbatim is baselined, its prose neutralized,
 * never the id rewritten). The surrounding prose was neutralized
 * instead (the switch-action comments, the 409-refusal comments'
 * provider names), and the two E*TRADE comment lines retire outright,
 * leaving StockHub.tsx/etrade and screeningAdapters.ts/etrade at their
 * seed counts. 2 new rows + 1 raise. (The header's last recorded
 * totals were stale: counted 1181 rows / 9333 lines before this change.)
 * Totals move 1181/9333 -> 1183/9334.
 * Baseline update (#2373 S1b, 2026-11-14): the paid seam carries the
 * tenant-resolved provider into the paid flow and the premium
 * fulfilment resolves it instead of hardcoding "yahoo" — 2 raises,
 * both dispositioned INTEGRATION, both data-bearing provider-id
 * literals naming the engine-default provider (the #3911 precedent:
 * an id named verbatim is baselined, its prose neutralized, never
 * the id rewritten): paidStockScreenSeam.ts etrade 7->8 (the
 * route-implied provider default, `spec.provider ?? "etrade"`) and
 * premium.ts etrade 7->8 (the stored-selection comparison
 * `storedProvider !== "etrade"`). The surrounding prose was
 * neutralized instead (the premium fulfilment comment names no
 * brand; the seam's comments name none either), and the premium
 * "yahoo" row does not move (hardcoded literals removed as fast as
 * the resolved-provider comparisons arrive). Totals move
 * 1183/9334 -> 1183/9336.
 * Baseline update (#4282 P3, 2026-11-14): the IvHistory broker
 * DEFAULT 'etrade' ALTER moved to the remainder catalogue — the
 * adapter row drops 2->1 and a new INTEGRATION row
 * `remainderCatalogue.ts / etrade / 1` is added at the end of the
 * baseline. Totals move 1183/9336 -> 1184/9336 (one new row, lines
 * unchanged: -1 on the adapter, +1 on the catalogue).
 * Baseline update (#4532 S1, 2026-11-14): the ledger's per-broker tabs
 * resolve each stored row to its broker id, and rows recorded before
 * the broker stamp carry none — the table module names the legacy
 * broker id verbatim as the fallback, dispositioned INTEGRATION (a
 * data-bearing identifier, the #3911 precedent: an id named verbatim
 * is baselined, its prose neutralized, never the id rewritten). The
 * module's prose names no brand, the panel carries no brand row, and
 * display names come from the one broker presentation helper. 1 new
 * row, added at the end of the baseline. (The header's last recorded
 * totals were stale: counted 1187 rows / 9344 lines before this
 * change.) Totals move 1187/9344 -> 1188/9345.
 * Baseline update (#4452, 2026-11-14): the options steps compose
 * into the ScheduledAgent host-side registry, binding the chain
 * source to the provider's client in
 * optionsStepDepsForScheduledAgent — the scheduledTasksPipeline.ts
 * etrade row moves 1 -> 3 (the pre-existing header line + the
 * import + construction), dispositioned INTEGRATION — the binding
 * names the provider its leg serves, which is its job (the #4289
 * precedent in the workflow residency). The prose around it is
 * neutralized (no brand in the comments), and the count falls
 * back when provider selection (#3960) replaces the direct
 * binding. Totals move 1188/9345 -> 1188/9347.
 * Baseline update (#4450, 2026-11-15): the manual route's gated
 * cutover dispatches symbol-scoped screens through the workflow
 * host. 1 new row + 1 raise, both dispositioned INTEGRATION: the
 * new manualOptionsResidency.ts etrade row (2 — the outbound
 * email service's import + construction, the residency delivery
 * builders' own email leg, mirroring the route's) and the
 * etradeOptionsScreen.ts etrade row 19 -> 20 (the dispatch gate's
 * broker comparison — naming the residency's bound broker is the
 * gate's job). The prose around both is neutralized (no brand in
 * the comments or the gate reasons), and the gate's comparison
 * falls away when provider selection (#3960) replaces the direct
 * binding. Totals move 1188/9347 -> 1189/9350.
 * Baseline update (#3960, 2026-11-15): provider/broker selection
 * travels as a stage input, so the direct chain-source bindings
 * fall back as the #4289/#4452 entries recorded: the
 * jobPipelineWorkflow.ts etrade row retires outright (2 -> 0, row
 * removed) and the scheduledTasksPipeline.ts etrade row falls back
 * 3 -> 1 (only the pre-existing header line remains). 1 new row,
 * dispositioned INTEGRATION: the residency factory's legacy
 * direct-client import + construction
 * (brokerChainSourceResidency.ts etrade 2 — the pair path resolves
 * through the registry and names no provider; the module's prose
 * names none). (The header's last recorded totals were stale:
 * counted 1191 rows / 9358 lines before this change.) Totals move
 * 1191/9358 -> 1191/9356.
 * Baseline update (#3655 F6, 2026-11-15): the scheduled E*TRADE
 * fallbacks retire — the run-time `return "etrade"` and the three
 * inline `: "etrade"` broker fallbacks in scheduledTasks.ts go,
 * with the two stale "etrade" comment lines (the resolver doc and
 * the `provider?` option comment). The retired mentions lower
 * their baseline entries in this PR, per the header rule:
 * scheduledTasks.ts etrade 97 -> 90 and nasdaq 5 -> 4 (the stale
 * "public, nasdaq" comment line). The yahoo row moves 19 -> 17
 * with no yahoo line in this diff — drift since the seed,
 * reconciled to measured here. No new rows; the catalog entry
 * adds no brand line (outcomeCatalog.json is one line, counts
 * unchanged). Totals move 1191/9356 -> 1191/9346.
 * Baseline update (#4468, 2026-11-15): the NLQ panel leg's
 * (broker, mode) derivation names each catalog broker to mirror
 * that platform's own environment resolution — naming the
 * provider is the derivation's job, dispositioned INTEGRATION.
 * 1 new row (discoveryService.ts alpaca 2: the case line and the
 * descriptor line; the side resolver rides the trading barrel,
 * #290) and 1 raise (discoveryService.ts etrade 2 -> 4: the case
 * line and the descriptor line). The derivation's comments name
 * no provider. Totals move 1191/9346 -> 1192/9350.
 * Baseline update (#4653, 2026-11-15): the SecHub PEP tab's gate
 * inventory names the routes the PEP gates, verbatim — the three
 * E*TRADE OAuth routes are data-bearing route literals, not
 * platform framing (the #3911 precedent: an id named verbatim is
 * baselined, its prose neutralized, never the id rewritten) —
 * dispositioned INTEGRATION. 1 raise (pepGateway.ts etrade 1 -> 5:
 * the three route literals plus the two mentions in the inventory
 * comment naming the shared start branch). Totals move 1192/9350
 * -> 1192/9354.
 * Baseline update (#4431 S5/N3, 2026-11-15): the manual stock-screen
 * path stops guessing providers — the planner requires one, the spec
 * carries the tenant-resolved one, the gate refuses unconfigured
 * tenants, and provenance is `?? "unknown"`. The new provider-carry
 * code names the providers it matches/refuses, so its comments and
 * identifiers add brand lines — all dispositioned INTEGRATION (the
 * tenant-provider / screen-path modules naming the provider is their
 * job): 4 new rows (premium.ts/alpaca 1 — the unconfigured-refusal
 * comment names the platform default the premium path no longer
 * leans on; drizzleSchema.ts/alpaca 2 — the corrected "Absent row =
 * alpaca" comments name the code default DEFAULT_TENANT_PROVIDERS;
 * paidStockScreenSeam.ts/alpaca 1 / yahoo 2 — the explicit
 * routeProvider comments name the route's provider and the effective
 * default the command carries for an unconfigured tenant)
 * and 10 raises (screeningAdapters.ts etrade 1->4 / yahoo 4->7 — the
 * variant→registry id map, data-bearing identifiers;
 * commercialPorts.ts alpaca 8->10 — the corrected default comments;
 * tenantProviders.ts alpaca 11->13 / nasdaq 2->4 — the new
 * claim-validation helpers name the providers they match and the
 * non-screen provider they refuse; screenerPipeline.ts alpaca 26->27
 * / yahoo 79->80 / nasdaq 32->33 — the screen-provider guard and the
 * provenance comment; premium.ts etrade 8->9 — the refusal comment;
 * paidStockScreenSeam.ts etrade 8->10 — the routeProvider arg and
 * its comments).
 * The same diff retires 3 rows outright (the "E*TRADE live"
 * provenance guess and the stale etrade-default comments are gone:
 * StockHub.tsx/etrade 1, reports.ts/etrade 1,
 * goalStockScreenSpec.ts/etrade 1), so the PLATFORM slice shrinks
 * 189 -> 188 rows (its header and slice bound are restated; the
 * derived platform total was 990 before this change and is 989
 * after it — the header's 1050 had drifted since #3050). Shrinks
 * needing no baseline change: marketDataResearch.ts yahoo 14->5,
 * stockScreenCapability.ts etrade 9->4 / yahoo 4->2,
 * stockScreenRunSpec.ts yahoo 4->1, stockScreenPlanner.ts etrade
 * 4->2, commercialPorts.ts etrade 4->2, drizzleSchema.ts etrade
 * 5->3, brokerGate.ts etrade 11->10, etradeBroker.ts etrade
 * 166->165. Measured totals move 1191/9359 -> 1192/9355 (re-based onto
 * 155f5121; the totals on 2ac3e995 were 1191/9355 -> 1192/9351, on 7d81cd93
 * 1190/9351 -> 1191/9347, and on cc33837c 1174/9135 -> 1175/9131).
 * Baseline update (#4792, 2026-11-16): four CPO-dhmp surveys are filed
 * into docs/architecture/survey/ as dated records of what was measured
 * on their stated bases. Their provider-brand mentions are route
 * paths, query-param names, and file names that cannot be reworded
 * without falsifying the survey — all dispositioned S5 live docs
 * (dated records / identifier inventories): 4 new rows
 * (2380-survey-draft.md/etrade 6 — the /api/etrade/... route paths
 * in the surface inventory; 2380-survey-draft.md/alpaca 1 — the
 * alpaca.ts route reference; 3238-param-survey.md/etrade 1 — the
 * etrade_auth / etrade_connect_error param names;
 * slice4-label-survey.md/etrade 4 — the TradeHub.tsx file
 * name). ux-framework-survey.md carries no rows. Measured totals move
 * 1192/9360 -> 1196/9372 (re-based onto c334d9ae).
 * Baseline update (#4791, 2026-11-16; re-based onto 38c4115b):
 * the CAIO-lane surveys file under docs/architecture/survey/ as
 * verbatim dated snapshots (2026-10-29/11-01) — the #2225 mesh
 * survey (summary + full text), the three #2494 Think-adoption
 * domain surveys, the #2494 AGNTCY workstream survey, and the
 * assessment-scope audit. The survey texts name the
 * brokers/providers they surveyed; neutralizing those mentions
 * would falsify the evidence record, so all rows are dispositioned
 * HISTORICAL: 10 new rows (2225-agent-mesh-survey-part1.md etrade
 * 11; 2225-agent-mesh-survey-part2.md etrade 10 / public.com 1 /
 * alpaca 1; 2494-agntcy-workstream-survey.md etrade 1 /
 * public.com 1; 2494-think-adoption-trading-survey.md etrade 8 /
 * public.com 3; assessment-scope-audit.md etrade 1 / public.com 1).
 * The summary, payment, and screener surveys carry no
 * provider-brand rows. The HISTORICAL marker is restated
 * 145/732 -> 159/783 (the 732 had drifted by one, and the #4792
 * rows landed without restating the marker; the true pre-change
 * span on this base is 149/745).
 * Baseline update (#3121, 2026-11-16): the two #3121 scheduling surveys
 * file under docs/architecture/survey/ as verbatim dated snapshots
 * (2026-11-11) — the #3122 S0 dedup report and the #3121 Phase 2 survey.
 * The survey texts name the providers they surveyed (the E*TRADE
 * token-renewal identifiers the surveyed code names, a quoted code
 * comment, and the Yahoo-gapfill worktree name); neutralizing those
 * mentions would falsify the evidence record, so all rows are
 * dispositioned HISTORICAL: 3 new rows (3122-s0-dedup-report.md etrade 6;
 * phase2-survey.md etrade 1 / yahoo 1). The HISTORICAL marker is restated
 * 159/783 -> 162/791. Measured totals move 1280/10061 -> 1283/10069
 * (re-based onto 105b9b96).
 * Baseline update (#4660, 2026-11-16): matrix gap 8 gives E*TRADE the order
 * read and the one-order cancel the other brokers already had. Every raised
 * row is the provider's own adapter or the inventory that names it — the
 * E*TRADE command module, the factory registration, the permission map, the
 * tool-family record, the catalog's copilot block, and the two docs that
 * enumerate tools by provider — all dispositioned INTEGRATION (naming the
 * provider is their job): 8 raises (mcp-server-inventory.md/etrade 5->7 — the
 * tool table and the async split's new synchronous arm,
 * tool-attribution-audit-1763.md/etrade 8->10, chatPrompt.ts/etrade 7->8 — the
 * steering now names the E*TRADE order tools instead of leaving an E*TRADE
 * session pointed at another broker's, registry.ts/etrade 27->30,
 * commands.ts/etrade 24->28, etradeCommands.ts/etrade 119->143,
 * mcpPermissionPorts.ts/etrade 9->11, brokerCatalog.ts/etrade 26->29). The
 * prose that named the sibling brokers inside the E*TRADE module was
 * neutralized instead of baselined, so no alpaca or public.com row appears.
 * Measured totals move 1283/10115 -> 1283/10126 (re-based onto 043afa900).
 * Baseline update (#4671, 2026-11-16): gap 17 gives the auction terms a broker.
 * An auction order is market/limit + opg/cls, so the change lands in the two
 * capability records (the order-type registry and the matrix doc), in the
 * E*TRADE seam that now refuses the term by name, and nowhere else. Every row
 * is a provider's own file or the document that inventories it — all
 * dispositioned INTEGRATION (naming the provider is their job): 5 raises
 * (brokerage-data-matrix.md etrade 80->83 / alpaca 60->63, advancedOrders.ts
 * etrade 27->28 / alpaca 28->29, etrade/platform.ts etrade 69->72). The prose
 * that named the sibling broker inside `timeInForce.ts` and the E*TRADE seam
 * was neutralized instead of baselined, so no new row appears.
 * Baseline update (#4469, 2026-11-15; re-based onto 38c4115b):
 * the NLQ scan leg's (broker, mode) derivation defaults to the
 * pre-provenance broker id when the caller stamps none — naming
 * the default is the derivation input's job, dispositioned
 * INTEGRATION. 1 raise (nlqOptionsStrategy.ts etrade 19 -> 20:
 * the default line). The cutover's comments name no provider.
 * Totals move 1196/9372 -> 1196/9373.

 * Baseline update (#4957, 2026-11-16): E*TRADE carries the auction as its own
 * documented PRICE TYPE (MARKET_ON_OPEN / …_ON_CLOSE / LIMIT_ON_OPEN /
 * …_ON_CLOSE), so the mapping and the limit-bearing predicate live in the
 * broker's own adapter — dispositioned INTEGRATION like every other row in
 * those files: 2 raises (etrade/platform.ts etrade 72->83 — the mapping, the
 * refusal and their doc comments; etrade/client.ts etrade 329->330 — the
 * predicate that keeps a LIMIT_ON_* order priced). Measured totals move
 * 1283/10127 -> 1283/10138 (re-based onto 5dbede526).
 * Baseline update (#4935, 2026-11-16): ADR 0033 (cross-store consistency
 * contract) files under docs/architecture/adr/ with its audit ledger. The
 * ledger inventories the existing dual-write/projection paths by module
 * file name, so it names the broker screener-run publication module
 * verbatim (etradeBrokerPublish.ts); rewording the file name would falsify
 * the inventory, so the one row is dispositioned INTEGRATION (naming the
 * provider is the inventory's job — the #4792 survey precedent). The
 * INTEGRATION marker is restated 681/6528 -> 698/7062 (direct recount on
 * current main; the 682/6529 stated by #4966's merge incremented the stale
 * marker instead of recounting; the recount includes the #4958/#4854
 * raises).
 * Baseline update (#4958, 2026-11-16; the Public auction slice): Public's own
 * platform file gains the on-open refusal message, which names the broker — a
 * user-facing string in that broker's adapter, dispositioned INTEGRATION like
 * the rest of the row: 1 raise (public/platform.ts public.com 12->13).
 * Measured totals move 1284/10139 -> 1284/10140 (re-based onto 1930e03e7).
 * Baseline update (#4670, 2026-11-16; the Alpaca replace slice): the provider
 * gains a real PATCH and the command module gains one trade tool, so the two
 * Alpaca-owned files grow and the shared environment-resolver's identifier gets
 * its own row. All dispositioned INTEGRATION: 2 raises (cancelOrderCommands.ts
 * alpaca 5->9 — the replace tool's class, schema and audit; marketDataResearch.ts
 * alpaca 114->120 — the PATCH implementation) and 1 new row
 * (cancelOrderCommands.ts etrade 2 — the shared resolver's name, an identifier).
 * Baseline update (#5001, 2026-11-16; E*TRADE replace): the broker's change
 * flow gains its caller, in that broker's own files — INTEGRATION, like every
 * other row there: 2 raises (advancedOrders.ts etrade 28->29 — the `replace`
 * entry's notes now state both brokers' flows; etrade/platform.ts etrade
 * 83->94 — the change preview/place method and its refusals).
 * Baseline update (#5002, 2026-11-16; Public replace): that broker's adapter
 * gains the replace method and its refusals, whose user-facing strings name the
 * broker — dispositioned INTEGRATION like the rest of the row: 1 raise
 * (public/platform.ts public.com 13->19).

 * Baseline update (#4854, 2026-11-16): the scheduled firer's options
 * screens cut over to the strategy workflow host, gated. 2 raises:
 * the scheduledTasks.ts etrade row 90 -> 91, dispositioned
 * INTEGRATION (the dispatch derivation's broker literal — naming
 * the provider is the derivation's job, the #4853 precedent; the
 * prose around it names no provider), and the nasdaq row 4 -> 5 in
 * the NOT-PROVIDER section, where the term's rows live (the
 * universe descriptor line — naming the provider is the
 * descriptor's job). Measured totals move 1284/10140 -> 1284/10142
 * (re-based onto ca881bc4).
 * Baseline update (#4234, 2026-11-16): the heartbeat slice moves the
 * token-renewal and retention duties onto the one SDK alarm tick (ADR 0030).
 * The alarm tick's due-check adapter reuses the one renewal implementation —
 * it binds the same `renewAllStoredETradeTokens` the Worker dispatcher already
 * binds (baselined in queue.ts), so the duty has one implementation, not two.
 * 1 new row, dispositioned INTEGRATION (a data-bearing identifier, not
 * framing: the name is the stored-token renewal function the adapter binds;
 * the tokens it renews are E*TRADE tokens by definition, and the tenant's
 * broker selection still governs broker behaviour elsewhere):
 * scheduled-agent.ts etrade 2 (the import + the bind). Measured totals move
 * 1285/10168 -> 1286/10170 (re-based onto 16215a13).
 *
 * Baseline update (#4988, 2026-11-16): the service login gains its own
 * E*TRADE token through the 3-legged flow (#945 Q10, option 1) — the new
 * service-user E*TRADE routes, the PEP inventory entries that name them,
 * the client calls and the Service User panel, and the runbook section
 * that documents the flow all name the provider they integrate —
 * dispositioned INTEGRATION (naming the provider is their job): 2 new
 * rows (serviceUserApi.ts etrade 14 — the route literals, the three
 * client functions and their doc comments; ServiceUserSection.tsx etrade
 * 18 — the authorize button, the verifier PIN input, the checklist copy
 * and the call sites) and 5 raises (service-identity.md etrade 10->27 —
 * the new authorization section; serviceUser.ts etrade 2->44 — the three
 * routes, their dispatch and their audit events; iaaaEndpointCatalog.ts
 * etrade 34->44 — the three endpoint entries; etradeOAuth.ts etrade
 * 123->124 — the identity parameter threaded into the exchange;
 * pepGateway.ts etrade 5->8 — the two inventory entries and their
 * comment). Baseline totals move 1303/10407 -> 1305/10512.
 * Baseline update (#4856, 2026-11-17): the evaluate route's panel
 * screen cuts over to the strategy workflow host, gated — the gate
 * and host dispatch name the provider they integrate,
 * dispositioned INTEGRATION (naming the provider is their job): 1
 * new row (etradeOptionsEvaluate.ts nasdaq 1 — the universe
 * descriptor literal) and 1 raise (etradeOptionsEvaluate.ts etrade
 * 25->29 — the broker derivation literal, the gate and derivation
 * comments naming the platform, and the service type reference).
 * Baseline totals move 1308/10537 -> 1309/10542 (re-based onto
 * c26e0d2c).
 * Baseline update (#4896, 2026-11-17): the comparison legs cut
 * over to the comparison workflow host, gated — the gate
 * derivations name the provider they integrate, dispositioned
 * INTEGRATION (naming the provider is their job): 1 new row
 * (comparisonNlqRunner.ts etrade 1 — the NLQ leg's derivation
 * literal) and 1 raise (etradeOptions.ts etrade 65->66 — the
 * panel leg's derivation literal in the delegation call). The
 * shared dispatch module names no provider. Baseline totals move
 * 1314/10672 -> 1315/10674 (re-based onto 67197ab8, preserving
 * the main-side accountBindings row); the INTEGRATION marker is
 * restated 700/7069 -> 707/7306 (direct recount — the marker was
 * stale before this change).
 * Baseline update (#4858, 2026-11-17): the goal options leg cuts
 * over to the goal workflow host, gated — the dispatch site stamps
 * the universe descriptor literal, dispositioned NOT-PROVIDER (the
 * descriptor names the listings feed the leg resolves through, not
 * a serving provider): 1 raise (screener-agent.ts nasdaq 10->11).
 * The shared dispatch module names no provider. Baseline totals
 * move 1330/10827 -> 1330/10828; the NOT-PROVIDER marker is
 * restated 74/291 -> 74/298 (direct recount — the marker was stale
 * before this change).
 * Baseline update (#5344, 2026-11-18): the CBO parity inventory +
 * audit record file under docs/architecture/survey/ as verbatim dated
 * snapshots (2026-11-18) — the inventory report, its three evidence
 * files, and the 28-issue audit record. The evidence files name the
 * broker identifiers they surveyed (the TradeHub.tsx file
 * name, the /etrade/... route paths, the paid-seam identifiers);
 * neutralizing those mentions would falsify the evidence record, so
 * all rows are dispositioned HISTORICAL: 3 new rows (ux-actions.md
 * etrade 24; routes.md etrade 3; compliance.md etrade 2). The
 * inventory report and the audit record carry no provider-brand
 * rows. The HISTORICAL marker is restated 162/791 -> 165/820.
 * Baseline totals move 1332/10848 -> 1335/10877 (direct recount on
 * bc0222ee).
 * Baseline update (#4239, 2026-11-18): the token-renewal record
 * names its callback (autoRenewETradeTokens) in the record builder,
 * the home title branch, and the classifier's exact-match rule —
 * data-bearing identifiers, dispositioned INTEGRATION (not framing):
 * 2 new rows (scheduleKinds.ts etrade 1;
 * unifiedScheduleManagement.ts etrade 1) and 1 raise
 * (scheduleDetail.ts etrade 2 -> 3). No global-total restatement:
 * totals are not pinned (#3917).
 * Baseline update (#3515 S3 batch 8, 2026-11-18): the console
 * migration moves the E*TRADE OAuth adapter's ten warn/info sites to
 * the structured logger, and the new event names (`etradeOAuth.*`)
 * plus the per-function `component: "security/etradeOAuth"` lines
 * name the provider whose adapter this file is — naming the
 * provider is the adapter's job, so the row is dispositioned
 * INTEGRATION: 1 raise (etradeOAuth.ts/etrade 124->131). The
 * verbatim `E*TRADE` messages are unchanged (one message line per
 * site, replacing exactly one such line). Baseline totals move
 * 1335/10877 -> 1335/10884.
 * Baseline update (#5822, 2026-11-19): the quote freshness gate
 * (#4437 slice 1) checks the quote cache in the four screen-run
 * quote binds, so the binds' per-provider cache namespaces and
 * comments name the provider they serve — dispositioned
 * INTEGRATION (naming the provider is the binds' job): 3 raises
 * (screenerPipeline.ts etrade 111->118 / yahoo 80->84 / alpaca
 * 27->32). The doc prose was neutralized instead (the screener
 * doc's freshness-rule paragraph names no provider and lists no
 * namespace), so no docs row moves and no new row is created.
 * Baseline totals move 1359/11049 -> 1359/11065.
 * Baseline update (#5823, 2026-11-19): the screener's feed stage
 * reads through the #3941 capture-wired provider (#4437 slice 2),
 * so the step handler binds the quote/history deps over the
 * provider construction — dispositioned INTEGRATION (naming the
 * provider is the registry's and the wiring's job): 4 new rows
 * (screenerPipelineJobs.ts etrade 4 / alpaca 3 / yahoo 12,
 * jobPipelineWorkflow.ts yahoo 1) and 4 raises
 * (scheduledTasksPipeline.ts yahoo 1->2, screener-agent.ts yahoo
 * 68->71, feedPipelineJobs.ts yahoo 85->86, feedProviderWiring.ts
 * yahoo 3->7). The doc prose was neutralized instead (the j-stack
 * doc's feed-path paragraph names no provider brand), so no docs
 * row moves. The screener-agent etrade row shrinks 95->93 (the
 * stage-time bind fallback is gone) — a decrease, which passes.
 * Baseline totals move 1359/11065 -> 1363/11094.
 * Baseline update (#4436, 2026-11-20): the E*TRADE-named
 * fallback marker is replaced by the explicit broker-neutral data
 * mode (yahooDataMode), so the E*TRADE-named marker lines go and
 * the mode's prose names no provider — every comment that said
 * "Yahoo data mode" now says "the data mode", and the only
 * provider-brand lines the mode adds are the ones that must name
 * the serving source: the planner's two UI/record label strings
 * ("Yahoo full-dataset testing mode (delayed quotes, stocks
 * only)" / "Yahoo gap-fill mode (delayed quotes, stocks only)")
 * and the provider-id literal the full-dataset value resolves
 * to. Dispositioned INTEGRATION — provenance naming the actual
 * serving source, the same reason the adapters' and registries'
 * rows are INTEGRATION: the label is the run's provenance, and
 * neutralizing it would falsify what served the run's quotes.
 * 1 raise (stockScreenPlanner.ts yahoo 2->3) and 13 shrinks
 * (goalScreenDispatch.ts etrade 1->0, screener-agent.ts etrade
 * 95->91 / yahoo 71->70, goalDrivenScreen.ts etrade 3->2 /
 * yahoo 2->1, goalScreenReports.ts etrade 2->0 / yahoo 3->2,
 * scheduledTasks.ts etrade 91->87 / yahoo 17->15,
 * screeningRuntime.ts etrade 5->3 / yahoo 15->13,
 * screenerReportPdf.ts etrade 10->7, screenerCollation.ts
 * etrade 2->0, workflowPorts.ts etrade 5->2). Three rows vanish
 * (goalScreenDispatch etrade, goalScreenReports etrade,
 * screenerCollation etrade). (Rebased onto a8aa5b67 first: #5912
 * added one row / one line, so this update starts at 1364/11095;
 * #5610 touched no census row.)
 * Baseline totals move 1364/11095 -> 1361/11067.
 * Baseline update (#6076, 2026-11-22): nine CFO-lane survey
 * snapshots land in docs/architecture/survey/ as verbatim dated
 * records — the tables rationalization (#6056), run-logging
 * research (#6005), J-stack fit/gap master + stock + options
 * inventories (#3550), broker/provider-neutrality inventory
 * (#3460), options-screening + report-scope inventories (#2528),
 * and the stock-screen gap->issue map. The snapshots name the
 * providers they surveyed; neutralizing those mentions would
 * falsify the dated record, so all rows are dispositioned
 * HISTORICAL: 23 new rows (report-scope etrade 1 / yahoo 1;
 * screening etrade 7 / yahoo 1; neutrality etrade 67 / alpaca 10 /
 * nasdaq 1; fit-gap etrade 21 / alpaca 10 / yahoo 7 / nasdaq 1;
 * options etrade 11 / alpaca 4 / yahoo 1 / nasdaq 1; stock
 * etrade 4 / alpaca 1 / yahoo 8 / nasdaq 1; gap-map etrade 24 /
 * alpaca 4 / yahoo 18 / nasdaq 2). The HISTORICAL marker is
 * restated 165/820 -> 188/1026.
 * Baseline totals move 1367/11080 -> 1390/11286 (direct recount on
 * 7d3c4259; the header's last recorded 1361/11067 was stale).
 * Baseline update (#6072, 2026-11-22): the goal-run composition's
 * options-leg binding builds the goal leg's host-dispatch input, and
 * the universe descriptor names the goal universe's provider id
 * (`{ provider: "nasdaq" }`, the same literal `runGoalScreenOnEngine`
 * already carries for the same input) — naming the provider is the
 * leg dispatch's job, so the one new line is dispositioned
 * INTEGRATION. 1 raise (screener-agent.ts nasdaq 11->12).
 * Baseline totals move 1390/11286 -> 1390/11287.
 * Baseline update (#6171, 2026-11-22): the options chain fetch fix names
 * the provider in the Alpaca adapter's own error messages — the assembly
 * throws "Alpaca option chain for <symbol> <expiry>: no contracts listed"
 * and "no contract had a two-sided quote" instead of returning null
 * silently, so a failed run's message names its cause. Naming the
 * provider is the adapter's job, so the two new lines are dispositioned
 * INTEGRATION. 1 raise (optionsData.ts alpaca 23->25). The screener's
 * new comment mentions were neutralized instead ("broker client",
 * "platform path"), so no screener row is added or raised.
 * Baseline totals move 1390/11287 -> 1390/11289.
 * Baseline update (#6074, 2026-11-22): the goal options leg runs
 * the options-pipeline nodes in-process (6d-c), and its universe
 * resolution stamps the same universe descriptor literal
 * (`{ provider: "nasdaq" }`) onto the leg's request — naming the
 * provider is the leg's job, so the new row is dispositioned
 * INTEGRATION, as the #4856/#6072 rows for the same literal. The
 * row counts 2 lines: the stamp itself plus the resolver's doc
 * comment naming the descriptor. The engine-doc prose was
 * neutralized instead (it names the shared default's provider,
 * not the brand), so no docs row moves.
 * 1 new row (screenerPipelineJobs.ts nasdaq 2).
 * Baseline totals move 1390/11289 -> 1391/11291.
 * Baseline update (#6208, 2026-11-23): the snapshots fetch chunks
 * into ≤100-symbol requests, and a failed chunk logs the upstream
 * body server-side — both new lines name the provider in its own
 * adapter, so they are dispositioned INTEGRATION. 1 raise
 * (optionsData.ts alpaca 25->27): the chunk-limit comment naming
 * the documented limit, plus the server-side error log line.
 * Baseline totals move 1391/11291 -> 1391/11293.
 * Baseline update (#6423, 2026-11-24): the data-layer docs move
 * (docs(6113)) adds eight documents under docs/architecture/data/;
 * six of them name providers — the surveys and research name the
 * providers they survey (E*TRADE, Yahoo, Alpaca, Nasdaq) by
 * definition, so the new rows are dispositioned INTEGRATION, as the
 * data-model.md rows (#4802/#4813): neutralizing the names would
 * make the surveys unusable. 18 new rows (6 files), 58 lines;
 * table-domains.md and data-studio-scope.md carry no
 * provider-brand row. (Counted totals before this update are
 * 1392/11294 — the #6208 note's 1391/11293 is stale by the un-noted
 * #6160 row.)
 * Baseline totals move 1392/11294 -> 1410/11352.
 * Baseline update (#6438, 2026-11-24): the UX client reads the served
 * MCP catalogue (GET /api/mcp/catalog) and the hand-maintained
 * src/client/mcpEndpointsData.ts is retired to
 * mcpEndpointsData.deprecated.ts (rename only, gitops §22). The
 * deprecated file's content is unchanged, so its 3 rows move with
 * it at the same counts; the REST entries move verbatim to
 * src/client/restEndpointsData.ts, whose provider mentions are the
 * entries' own paths and descriptions — dispositioned INTEGRATION,
 * as the old file's rows. The 14 retired MCP gap rows shrink
 * iaaaEndpointCatalog.ts/etrade 44->40 (their item/source lines
 * named the provider); the new client modules carry no
 * provider-brand row. 3 rows removed, 6 rows added.
 * Baseline totals move 1410/11352 -> 1413/11394.
 * Baseline update (#6528, 2026-11-25): the Phase 1 Config census lands
 * seven documents under docs/architecture/survey/ — the six universal-
 * context surveys (context RCA + plan, resolvers + issues, copies and
 * overlaps, target-state counts, domain attribution, per-domain end
 * state) plus the #6528 census seed record. The surveys name the
 * providers/brokers they surveyed (the E*TRADE/Alpaca/Yahoo/Tastytrade
 * resolver and context identifiers, the Nasdaq index, the Interactive
 * Brokers name); neutralizing those mentions would falsify the evidence
 * record, so all rows are dispositioned HISTORICAL, as the #4791/#3121/
 * #6076 survey precedents. 18 new rows, 101 lines. The HISTORICAL
 * marker is restated 188/1026 -> 206/1127. (Counted totals before this
 * update are 1415/11409 — the #6438 note's 1413/11394 is stale by 2 rows
 * / 15 lines of un-noted drift, the same class the #6423 note records;
 * the NOT-PROVIDER marker's 298 lines is likewise one line short of the
 * 299 counted, left as-is.)
 * Baseline totals move 1415/11409 -> 1433/11510.
 * Baseline update (#6540, 2026-11-25): Phase 2 defines the one
 * universal env context (`UniversalEnvContext`,
 * `resolveUniversalContext`) in src/config/environment.ts. The new
 * resolver records the resolution source per setting, so it names the
 * provider's own env bindings (`ETRADE_ENVIRONMENT`,
 * `ET_BASE_URL` host-gating via `isETradeHost`) and reads the core
 * broker credentials (`resolved.etrade.apiKey/apiSecret`) — 6 new
 * brand lines, 1 removed (the old cascade comment's "E*TRADE
 * credentials" line is now "broker credentials"): environment.ts/
 * etrade 51 -> 56. Dispositioned INTEGRATION: naming the provider is
 * the config module's job — it resolves the provider's own env
 * bindings, and neutralizing the binding names would falsify the
 * source record. No other row moves.
 * Baseline totals move 1433/11510 -> 1433/11515.
 */
const BASELINE: Array<[string, string, number]> = [
  // ---- PLATFORM (188 rows / 989 lines) ----
  ["README.md", "etrade", 3],
  ["README.md", "yahoo", 1],
  // #4038/#4039 INTEGRATION: the broker parity matrix names the brokers it
  // compares by definition; the table is the artefact, not platform framing.
  ["docs/architecture/broker-parity-matrix.md", "etrade", 2],
  ["docs/architecture/broker-parity-matrix.md", "public.com", 1],
  ["docs/architecture/broker-parity-matrix.md", "alpaca", 2],
  ["docs/architecture/broker-parity-matrix.md", "yahoo", 1],
  ["docs/architecture/broker-parity-matrix.md", "nasdaq", 1],
  ["docs/architecture/broker-parity-matrix.md", "tastytrade", 5],
  // #3992 PR-5 INTEGRATION: the residency decision doc names the incident
  // job by its registered id (a data-bearing identifier), per the note above.
  ["docs/architecture/feed-run-residency-and-scheduled-silence-3992.md", "yahoo", 1],
  ["docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md", "alpaca", 8],
  ["docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md", "etrade", 19],
  ["docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md", "yahoo", 5],
  ["docs/COMPLIANCE.md", "alpaca", 9],
  ["docs/COMPLIANCE.md", "etrade", 14],
  ["docs/COMPLIANCE.md", "yahoo", 1],
  ["docs/DISCLAIMER.md", "etrade", 2],
  ["docs/KV_QUOTA_PLAN.md", "etrade", 9],
  ["docs/OBSERVABILITY.md", "etrade", 3],
  ["docs/SYSTEM_CONFIG_TIERS_AND_MODELS.md", "etrade", 10],
  ["docs/SYSTEM_CONFIG_TIERS_AND_MODELS.md", "yahoo", 2],
  ["docs/THREAT_MODEL.md", "etrade", 5],
  ["docs/agentic-org/platforms.md", "etrade", 2],
  ["docs/agents/think-conformance.md", "etrade", 1],
  ["docs/agents/think-roles-decision.md", "etrade", 1],
  ["docs/architecture/UX/consolidated-design-system.md", "etrade", 1],
  ["docs/archive/design-system-01.md", "etrade", 1],
  ["docs/archive/exceptions-01.md", "etrade", 3],
  ["docs/architecture/agentic/agents-sdk-conformance-matrix.md", "etrade", 5],
  ["docs/architecture/agentic/doors-and-layers.md", "alpaca", 1],
  ["docs/architecture/agentic/doors-and-layers.md", "etrade", 2],
  ["docs/architecture/agentic/doors-and-layers.md", "public.com", 1],
  ["docs/architecture/agentic/doors-and-layers.md", "yahoo", 1],
  ["docs/architecture/application/api-mcp.md", "alpaca", 3],
  ["docs/architecture/application/api-mcp.md", "etrade", 18],
  ["docs/architecture/application/api-mcp.md", "public.com", 6],
  ["docs/architecture/application/api-mcp.md", "yahoo", 3],
  ["docs/architecture/application/screener.md", "etrade", 8],
  ["docs/architecture/application/screener.md", "yahoo", 3],
  ["docs/architecture/blueprint/abok-target-blueprint.md", "etrade", 7],
  ["docs/architecture/blueprint/abok-target-blueprint.md", "yahoo", 5],
  ["docs/architecture/blueprint/blueprint-01.md", "etrade", 4],
  ["docs/architecture/business/current-state-rules.md", "etrade", 1],
  ["docs/architecture/business/fit-gap-with-amuse.md", "alpaca", 1],
  ["docs/architecture/business/fit-gap-with-amuse.md", "etrade", 2],
  ["docs/architecture/business/fit-gap-with-amuse.md", "yahoo", 1],
  ["docs/architecture/business/platform-capabilities.md", "alpaca", 5],
  ["docs/architecture/business/platform-capabilities.md", "etrade", 7],
  ["docs/architecture/business/platform-capabilities.md", "yahoo", 3],
  ["docs/architecture/business/platform-entity-capability-map.md", "etrade", 7],
  ["docs/architecture/business/screener-rules.md", "etrade", 1],
  ["docs/architecture/business/screener-rules.md", "yahoo", 1],
  ["docs/architecture/business/screener-workflow.md", "etrade", 21],
  ["docs/architecture/business/screener-workflow.md", "yahoo", 15],
  ["docs/architecture/business/system-overview.md", "etrade", 5],
  ["docs/architecture/business/system-overview.md", "yahoo", 2],
  ["docs/architecture/code/aop-fit-gap-analysis.md", "alpaca", 2],
  ["docs/architecture/code/aop-fit-gap-analysis.md", "etrade", 7],
  ["docs/architecture/code/aop-fit-gap-analysis.md", "yahoo", 3],
  ["docs/architecture/code/component-taxonomy-01.md", "alpaca", 6],
  ["docs/architecture/code/component-taxonomy-01.md", "etrade", 26],
  ["docs/architecture/code/component-taxonomy-01.md", "yahoo", 1],
  ["docs/architecture/code/overall-01.md", "alpaca", 7],
  ["docs/architecture/code/overall-01.md", "etrade", 30],
  ["docs/architecture/code/screener-01.md", "alpaca", 9],
  ["docs/architecture/code/screener-01.md", "etrade", 15],
  ["docs/architecture/code/screener-01.md", "yahoo", 1],
  ["docs/architecture/design-analysis.md", "alpaca", 1],
  ["docs/architecture/design-analysis.md", "etrade", 5],
  ["docs/architecture/design-analysis.md", "yahoo", 1],
  ["docs/architecture/enterprise/iros-system-analysis.md", "alpaca", 2],
  ["docs/architecture/enterprise/iros-system-analysis.md", "etrade", 6],
  ["docs/architecture/enterprise/iros-system-analysis.md", "yahoo", 3],
  ["docs/architecture/infrastructure/infrastructure.md", "alpaca", 1],
  ["docs/architecture/infrastructure/infrastructure.md", "etrade", 4],
  ["docs/architecture/infrastructure/infrastructure.md", "yahoo", 1],
  ["docs/architecture/iros.md", "etrade", 1],
  ["docs/architecture/plan/plan-01.md", "etrade", 2],
  ["docs/architecture/privacy/privacy-dsar-1765.md", "etrade", 1],
  ["docs/architecture/recommendation-engine-rationalization.md", "etrade", 5],
  ["docs/architecture/reference/cfpay.md", "public.com", 3],
  ["docs/architecture/reference/tabbed-browsing.md", "etrade", 1],
  ["docs/architecture/security-analysis.md", "etrade", 1],
  ["docs/architecture/security/api-security.md", "etrade", 3],
  ["docs/architecture/security/audit-store-bounded-backend-1760.md", "etrade", 1],
  ["docs/architecture/security/authn.md", "etrade", 2],
  ["docs/architecture/security/authz.md", "etrade", 5],
  ["docs/architecture/security/design.md", "etrade", 3],
  ["docs/architecture/security/do-rows-read-rca-2280.md", "etrade", 1],
  ["docs/architecture/security/iaaa-admin-bootstrap-genesis.md", "etrade", 8],
  ["docs/architecture/security/iaaa-github-end-to-end-defaults.md", "etrade", 3],
  ["docs/architecture/security/iaaa-google-defaults.md", "etrade", 1],
  ["docs/architecture/security/iaaa-lifecycle-wiring-1758.md", "etrade", 6],
  ["docs/architecture/security/iaaa-login-key-cutover-1759.md", "etrade", 5],
  ["docs/architecture/security/iaaa-pdp-architecture-1755.md", "etrade", 1],
  ["docs/architecture/security/iaaa-provider-onboarding.md", "etrade", 1],
  ["docs/architecture/security/identity-lifecycle.md", "etrade", 4],
  ["docs/architecture/security/mcp-security.md", "etrade", 2],
  ["docs/architecture/security/per-user-email-destination-488.md", "etrade", 1],
  ["docs/architecture/security/rsi-infosec-764-p0-verification.md", "alpaca", 1],
  ["docs/architecture/security/rsi-infosec-764-p0-verification.md", "etrade", 1],
  ["docs/architecture/security/security-workflow.md", "etrade", 7],
  ["docs/architecture/security/service-tokens-2681.md", "etrade", 1],
  ["docs/architecture/security/sessionstore-resource-measurement-1819.md", "etrade", 6],
  ["docs/architecture/security/step-up-windows-3102.md", "etrade", 1],
  ["docs/architecture/security/tool-attribution-audit-1763.md", "etrade", 10],
  ["docs/architecture/security/unenabled-orchestrations-1771.md", "alpaca", 1],
  ["docs/architecture/security/unenabled-orchestrations-1771.md", "etrade", 1],
  ["docs/architecture/security/user-request-quota-2842.md", "etrade", 5],
  ["docs/architecture/security/workflow-security.md", "etrade", 3],
  ["docs/architecture/security/zero-trust.md", "etrade", 1],
  ["docs/architecture/server-refactor-contract.md", "etrade", 9],
  ["docs/architecture/standards/options-gof-grasp-solid-3186.md", "etrade", 3],
  ["docs/architecture/standards/standards.md", "etrade", 1],
  ["docs/architecture/standards/stock-15-factor-reaudit.md", "etrade", 1],
  ["docs/architecture/standards/stock-15-factor-reaudit.md", "yahoo", 1],
  ["docs/architecture/strategy/strategy-01.md", "etrade", 2],
  ["docs/architecture/technical/cloudflare-01.md", "alpaca", 1],
  ["docs/architecture/technical/cloudflare-01.md", "etrade", 16],
  ["docs/architecture/technical/cloudflare-01.md", "yahoo", 1],
  ["docs/async-capabilities.md", "etrade", 1],
  ["docs/autopilot-policy-enforcement.md", "etrade", 4],
  ["docs/business/valueprop/goal-screener-01.md", "etrade", 3],
  ["docs/business/valueprop/goal-screener-01.md", "yahoo", 5],
  ["docs/knowledge-corpus-seed-manifest.json", "etrade", 1],
  ["docs/operations/runbook/alerting.md", "etrade", 2],
  ["docs/operations/runbook/alerting.md", "yahoo", 6],
  ["docs/operations/runbook/screening-system-runbook.md", "etrade", 1],
  ["docs/operations/runbook/screening-system-runbook.md", "yahoo", 1],
  ["docs/operations/runbook/service-identity.md", "etrade", 27],
  ["src/agents/trading-agent.ts", "etrade", 11],
  ["src/client/AccountPanels.tsx", "etrade", 17],
  ["src/client/Chat.tsx", "etrade", 9],
  ["src/client/DataProvidersPanel.tsx", "alpaca", 1],
  ["src/client/DataProvidersPanel.tsx", "etrade", 17],
  ["src/client/DataProvidersPanel.tsx", "nasdaq", 2],
  ["src/client/DataProvidersPanel.tsx", "yahoo", 1],
  ["src/client/EnrichmentDashboard.tsx", "alpaca", 2],
  ["src/client/EnrichmentDashboard.tsx", "yahoo", 3],
  ["src/client/FirstRunScreen.tsx", "alpaca", 3],
  ["src/client/FirstRunScreen.tsx", "etrade", 32],
  ["src/client/IvHistoryPanel.tsx", "etrade", 3],
  ["src/client/ServiceUserSection.tsx", "etrade", 18],
  ["src/client/MarketDataResearchHub.tsx", "alpaca", 55],
  ["src/client/MarketDataResearchHub.tsx", "etrade", 8],
  ["src/client/OmnichannelPanel.tsx", "etrade", 3],
  ["src/client/MarketDataResearchHub.tsx", "yahoo", 30],
  ["src/client/OptionsScreenerPage.tsx", "etrade", 1],
  ["src/client/OrderTicketPanel.tsx", "alpaca", 7],
  ["src/client/OrderTicketPanel.tsx", "etrade", 21],
  ["src/client/PlatformAdminPanel.tsx", "etrade", 18],
  ["src/client/PortfolioPanel.tsx", "etrade", 5],
  ["src/client/PortfolioRiskPanel.tsx", "alpaca", 1],
  ["src/client/PortfolioRiskPanel.tsx", "etrade", 14],
  ["src/client/SchedulesHome.tsx", "etrade", 1],
  ["src/client/ScreenerResultsView.tsx", "yahoo", 11],
  ["src/client/SettingsMenu.tsx", "etrade", 1],
  ["src/client/StockCopilotPanel.tsx", "alpaca", 3],
  ["src/client/StockCriteriaPanel.tsx", "etrade", 1],
  // #4430 PLATFORM (S2 client copy): the switch-action button label names
  // the provider it switches to — the user must know the target.
  ["src/client/StockHub.tsx", "yahoo", 1],
  ["src/client/VoicePanel.tsx", "etrade", 3],
  ["src/client/WorkflowsHub.tsx", "alpaca", 14],
  ["src/client/WorkflowsHub.tsx", "etrade", 21],
  ["src/client/WorkflowsHub.tsx", "nasdaq", 15],
  ["src/client/WorkflowsHub.tsx", "yahoo", 19],
  ["src/client/autoRefresh.ts", "etrade", 1],
  ["src/client/chat/ToolResultView.tsx", "alpaca", 6],
  ["src/client/chat/ToolResultView.tsx", "etrade", 6],
  ["src/client/chat/ToolResultView.tsx", "yahoo", 4],
  ["src/client/chat/types.ts", "etrade", 1],
  ["src/client/components/MarketTickerTape.tsx", "alpaca", 3],
  ["src/client/components/MarketTickerTape.tsx", "yahoo", 3],
  ["src/client/firstRunBrokerStep.ts", "alpaca", 2],
  ["src/client/firstRunBrokerStep.ts", "etrade", 7],
  ["src/client/landing.ts", "alpaca", 2],
  ["src/client/landing.ts", "etrade", 8],
  ["src/client/landing.ts", "fidelity", 1],
  ["src/client/landing.ts", "interactive brokers / ibkr", 3],
  ["src/client/landing.ts", "schwab", 3],
  ["src/client/landing.ts", "tradier", 1],
  ["src/client/nav-config.json", "etrade", 2],
  ["src/client/options/LlmOptionsIdeasPanel.tsx", "etrade", 2],
  ["src/client/options/LlmStrategyEvalModal.tsx", "etrade", 4],
  ["src/client/options/OptionsDataDownloadDropdown.tsx", "etrade", 3],
  ["src/client/options/OptionsResearchHost.tsx", "etrade", 1],
  ["src/client/options/OptionsResearchPanel.tsx", "etrade", 2],
  ["src/client/options/RawContractsScreener.tsx", "etrade", 2],
  ["src/client/options/StrategyDiscoveryPanel.tsx", "etrade", 19],
  ["src/client/options/flows/OptionsFlowsHub.tsx", "etrade", 3],
  // #5520 HISTORICAL (placed AFTER the first 188 rows: the PLATFORM
  // population above must stay fixed): the agentic IROS architecture
  // record + the moved 2026-10-26 record name the providers/brokers
  // they survey. They are dated records — neutralizing the names
  // would falsify the record. Same disposition as the survey rows
  // (#4802): the providers are the documents' subject, not platform
  // framing. The old docs/architecture/iros.md row is deliberately
  // RETAINED: it now measures 0 (a shrink, which passes).
  ["docs/architecture/enterprise/agentic-IROS.md", "etrade", 19],
  ["docs/architecture/enterprise/agentic-IROS.md", "public.com", 5],
  ["docs/architecture/enterprise/agentic-IROS.md", "alpaca", 34],
  ["docs/architecture/enterprise/agentic-IROS.md", "schwab", 15],
  ["docs/architecture/enterprise/agentic-IROS.md", "fidelity", 4],
  ["docs/architecture/enterprise/agentic-IROS.md", "robinhood", 4],
  ["docs/architecture/enterprise/agentic-IROS.md", "interactive brokers / ibkr", 22],
  ["docs/architecture/enterprise/agentic-IROS.md", "tradier", 1],
  ["docs/architecture/enterprise/agentic-IROS.md", "tastytrade", 11],
  ["docs/architecture/enterprise/agentic-IROS.md", "yahoo", 13],
  ["docs/architecture/enterprise/agentic-IROS.md", "nasdaq", 18],
  ["docs/architecture/enterprise/agentic-IROS.md", "polygon", 16],
  ["docs/architecture/enterprise/agentic-IROS.md", "finnhub", 10],
  ["docs/architecture/enterprise/iros.md", "etrade", 1],
  ["src/client/options/serverDiscovery.ts", "etrade", 1],
  // #4430 PLATFORM (S2 client copy): the 409 remediation message names the
  // provider it tells the user to switch to — the message is the action.
  ["src/client/paidScreenSubmit.ts", "yahoo", 1],
  ["src/client/scheduledOptionsManager/systemJobs.ts", "etrade", 3],
  ["src/client/workflowsFaqData.ts", "etrade", 1],
  ["src/client/workflowsFaqData.ts", "yahoo", 1],
  ["src/services/bracketLadder.ts", "thinkorswim", 1],
  ["src/services/platformKnowledge.ts", "alpaca", 5],
  ["src/services/platformKnowledge.ts", "etrade", 51],
  ["src/services/platformKnowledge.ts", "yahoo", 12],
  ["src/trading/interfaces.ts", "etrade", 2],
  // ---- INTEGRATION (711 rows / 7521 lines) ----
  ["docs/CLOUDFLARE_SCHEDULING_AND_ETAPI_TUNING.md", "etrade", 12],
  ["docs/CLOUDFLARE_SCHEDULING_AND_ETAPI_TUNING.md", "yahoo", 1],
  ["docs/EXTERNAL_APIS_AND_ENDPOINTS_DIRECTORY.md", "alpaca", 3],
  ["docs/EXTERNAL_APIS_AND_ENDPOINTS_DIRECTORY.md", "etrade", 10],
  ["docs/EXTERNAL_APIS_AND_ENDPOINTS_DIRECTORY.md", "yahoo", 5],
  ["docs/architecture/adr/0019-enrichment-yahoo-alpaca.md", "alpaca", 17],
  ["docs/architecture/adr/0019-enrichment-yahoo-alpaca.md", "yahoo", 18],
  // #4935: ADR 0033's audit ledger names the broker publication module
  // it inventories (INTEGRATION — naming the provider is the
  // inventory's job).
  ["docs/architecture/adr/data/0033-cross-store-consistency-contract.md", "etrade", 1],
  ["docs/architecture/agentic/agent-capabilities.md", "alpaca", 1],
  ["docs/architecture/agentic/job-system.md", "alpaca", 6],
  ["docs/architecture/agentic/job-system.md", "nasdaq", 2],
  ["docs/architecture/agentic/job-system.md", "yahoo", 2],
  ["docs/architecture/agentic/mcp-server-inventory.md", "alpaca", 4],
  ["docs/architecture/agentic/mcp-server-inventory.md", "etrade", 7],
  ["docs/architecture/agentic/mcp-server-inventory.md", "yahoo", 2],
  ["docs/architecture/code/10-mcp-standards.md", "etrade", 1],
  ["docs/architecture/code/13-structure-and-file-organization.md", "etrade", 6],
  ["docs/architecture/security/etrade.md", "etrade", 38],
  ["docs/architecture/security/screener-chain-stuck-repair-3787.md", "alpaca", 1],
  ["docs/architecture/security/screener-chain-stuck-repair-3787.md", "etrade", 1],
  ["docs/architecture/security/screener-chain-stuck-repair-3787.md", "yahoo", 1],
  ["docs/architecture/security/vendor-risk-1774.md", "alpaca", 1],
  ["docs/architecture/security/vendor-risk-1774.md", "etrade", 1],
  ["docs/architecture/security/vendor-risk-1774.md", "public.com", 1],
  // #3135 INTEGRATION: the token-mapping doc names the layout file
  // TradeHub.tsx by its registered name (a data-bearing
  // identifier) in the scope list and Used-by columns; neutralizing
  // the file name would break traceability to the file.
  ["docs/architecture/UX/token-mapping-order-options-autopilot.md", "etrade", 7],
  ["docs/operations/data/data-provider-platform.md", "alpaca", 13],
  ["docs/operations/data/data-provider-platform.md", "etrade", 8],
  ["docs/operations/data/data-provider-platform.md", "nasdaq", 5],
  ["docs/operations/data/data-provider-platform.md", "public.com", 3],
  ["docs/operations/data/data-provider-platform.md", "yahoo", 8],
  ["docs/operations/data/feed-jobs.md", "alpaca", 2],
  ["docs/operations/data/feed-jobs.md", "etrade", 2],
  ["docs/operations/data/feed-jobs.md", "nasdaq", 2],
  ["docs/operations/data/feed-jobs.md", "public.com", 1],
  ["docs/operations/data/feed-jobs.md", "yahoo", 3],
  ["src/a2a/agent-cards.ts", "etrade", 3],
  ["src/agentic/chainExecutor.ts", "etrade", 6],
  ["src/agentic/chainExecutor.ts", "yahoo", 2],
  ["src/agents/browserAgent.ts", "etrade", 4],
  ["src/agents/chatPrompt.ts", "alpaca", 2],
  ["src/agents/chatPrompt.ts", "etrade", 8],
  ["src/agents/copilotTradingMode.ts", "alpaca", 9],
  ["src/agents/copilotTradingMode.ts", "etrade", 5],
  ["src/agents/judge.ts", "alpaca", 1],
  ["src/agents/judge.ts", "etrade", 1],
  ["src/agents/judge.ts", "yahoo", 1],
  ["src/agents/nlq/execution.ts", "alpaca", 1],
  ["src/agents/nlq/execution.ts", "etrade", 78],
  ["src/agents/nlq/execution.ts", "yahoo", 1],
  ["src/agents/nlq/formatting.ts", "etrade", 4],
  ["src/agents/nlq/llmPlanning.ts", "alpaca", 1],
  ["src/agents/nlq/llmPlanning.ts", "yahoo", 1],
  ["src/agents/nlq/orderParams.ts", "etrade", 1],
  ["src/agents/nlq/planning.ts", "alpaca", 5],
  ["src/agents/nlq/planning.ts", "etrade", 4],
  ["src/agents/nlq/planning.ts", "yahoo", 3],
  ["src/agents/nlq/schema.ts", "alpaca", 1],
  ["src/agents/nlq/schema.ts", "etrade", 10],
  ["src/agents/nlq/types.ts", "etrade", 1],
  ["src/agents/nlqOptionsStrategy.ts", "alpaca", 2],
  ["src/agents/nlqOptionsStrategy.ts", "etrade", 21],
  ["src/agents/orchestrator.ts", "etrade", 20],
  ["src/agents/orchestrator/asyncJobs.ts", "etrade", 12],
  ["src/agents/orchestrator/autopilot.ts", "etrade", 4],
  ["src/agents/orchestrator/goalScreenDispatch.ts", "yahoo", 1],
  ["src/agents/orchestrator/meshDoors.ts", "alpaca", 12],
  ["src/agents/orchestrator/meshDoors.ts", "etrade", 30],
  ["src/agents/orchestrator/meshDoors.ts", "nasdaq", 1],
  ["src/agents/orchestrator/meshDoors.ts", "yahoo", 12],
  ["src/agents/orchestrator/meshOptionsStageControlDoor.ts", "etrade", 8],
  // Issue #5190 INTEGRATION (raise + one new row): the run's broker became a
  // tool argument and a resolved context, so the door and the engine name the
  // brokers they can serve — data-bearing enums and refusal text, not copy.
  // nlqOptionsStrategy etrade 20->21 / alpaca 1->2, the door 15->28 plus its
  // first alpaca row, meshDoorCommands etrade 15->17.
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "alpaca", 2],
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "etrade", 28],
  ["src/agents/orchestrator/nlqPorts.ts", "etrade", 1],
  ["src/agents/orchestrator/reportDispatch.ts", "etrade", 7],
  ["src/agents/orchestrator/reportDispatch.ts", "yahoo", 1],
  ["src/agents/orchestrator/researchPublish.ts", "etrade", 5],
  ["src/agents/orchestrator/routeRequest.ts", "alpaca", 4],
  ["src/agents/orchestrator/routeRequest.ts", "etrade", 39],
  ["src/agents/orchestrator/scheduleCallbacks.ts", "etrade", 1],
  ["src/agents/orchestrator/scheduleMaintenance.ts", "etrade", 2],
  ["src/agents/orchestrator/scheduledCallbacks.ts", "etrade", 16],
  ["src/agents/orchestrator/scheduledTasksCopilot.ts", "alpaca", 3],
  ["src/agents/orchestrator/settingsWebhook.ts", "alpaca", 1],
  ["src/agents/orchestrator/skillPacks.ts", "etrade", 1],
  ["src/agents/orchestrator/skills/chat-screening-doors/SKILL.md", "etrade", 1],
  ["src/agents/prompts/stockCopilotPrompt.ts", "alpaca", 17],
  ["src/agents/prompts/stockCopilotPrompt.ts", "etrade", 5],
  // #3911 INTEGRATION: the pipeline stage-order rule names the feed/chain job ids
  // the copilot must invoke verbatim (the quotes job, the fundamentals join, the
  // chain id) — data-bearing identifiers, not framing. The rule's prose comment
  // was neutralized instead (no provider name), so the row is the rule line alone.
  // #4002 INTEGRATION: the feed-job monitoring rule names the sentiment job id
  // the copilot must check verbatim — same disposition; its prose comment was
  // neutralized instead, so the row is the rule line alone.
  ["src/agents/prompts/stockCopilotPrompt.ts", "yahoo", 2],
  ["src/agents/registry.ts", "etrade", 30],
  ["src/agents/registry.ts", "public.com", 5],
  ["src/agents/research-agent.ts", "etrade", 6],
  ["src/agents/routes/agenticPayments.ts", "etrade", 4],
  ["src/agents/routes/alpaca.ts", "alpaca", 41],
  ["src/agents/routes/autopilot.ts", "etrade", 1],
  ["src/agents/routes/brokerCodedError.ts", "etrade", 20],
  ["src/agents/routes/brokerConnect.ts", "alpaca", 22],
  ["src/agents/routes/brokerConnect.ts", "etrade", 4],
  ["src/agents/routes/brokerEnvironment.ts", "etrade", 9],
  ["src/agents/routes/brokerGate.ts", "etrade", 11],
  ["src/agents/routes/brokerOptions.ts", "etrade", 3],
  // #3883 INTEGRATION: the cancel route selects the engine by broker id, so
  // one comparison names it (the surrounding wording stays neutral).
  // #3937: the per-broker port selection adds one more comparison (the
  // helper dispatch); the two retired alpaca-only gates are replaced by
  // the two ledger conditionals, so the net is 6 -> 7.
  ["src/agents/routes/brokerOrders.ts", "alpaca", 7],
  ["src/agents/routes/brokerOrders.ts", "etrade", 31],
  ["src/agents/routes/brokerReads.ts", "alpaca", 1],
  ["src/agents/routes/brokerReads.ts", "etrade", 1],
  ["src/agents/routes/brokerRisk.ts", "alpaca", 1],
  ["src/agents/routes/brokerRisk.ts", "etrade", 3],
  ["src/agents/routes/brokerScreen.ts", "etrade", 4],
  // #4433 NOT-PROVIDER: the explicit-symbols listing rows carry the
  // listings-feed exchange enum's default member — a type-required
  // placeholder, inert on the screening path (the live quote's data
  // wins downstream); it names no provider integration.
  ["src/agents/routes/brokerScreen.ts", "nasdaq", 1],
  // #3796 INTEGRATION: the surface voice routes host the desk
  // surface's broker gate, whose comparison names the desk broker.
  ["src/agents/routes/copilotChannels.ts", "etrade", 1],
  ["src/agents/routes/dataLifecycle.ts", "etrade", 8],
  ["src/agents/routes/dataProviders.ts", "alpaca", 3],
  ["src/agents/routes/dataProviders.ts", "etrade", 12],
  ["src/agents/routes/dataProviders.ts", "yahoo", 6],
  ["src/agents/routes/enrichment.ts", "alpaca", 9],
  ["src/agents/routes/enrichment.ts", "yahoo", 7],
  ["src/agents/routes/etradeBroker.ts", "etrade", 171],
  ["src/agents/routes/etradeBrokerAutopilot.ts", "etrade", 10],
  ["src/agents/routes/etradeBrokerBundle.ts", "etrade", 10],
  ["src/agents/routes/etradeBrokerDiagnostics.ts", "etrade", 16],
  ["src/agents/routes/etradeBrokerLearning.ts", "etrade", 10],
  ["src/agents/routes/etradeBrokerModes.ts", "etrade", 19],
  ["src/agents/routes/etradeBrokerOrders.ts", "etrade", 33],
  ["src/agents/routes/etradeBrokerPortfolioRisk.ts", "etrade", 28],
  ["src/agents/routes/etradeBrokerPublish.ts", "etrade", 6],
  ["src/agents/routes/etradeBrokerScreen.ts", "etrade", 28],
  ["src/agents/routes/etradeOptions.ts", "etrade", 66],
  ["src/agents/routes/etradeOptionsDiscoveryReport.ts", "etrade", 4],
  ["src/agents/routes/etradeOptionsEvaluate.ts", "etrade", 29],
  ["src/agents/routes/etradeOptionsEvaluate.ts", "nasdaq", 1],
  ["src/agents/routes/etradeOptionsNoView.ts", "etrade", 7],
  ["src/agents/routes/etradeOptionsProfiles.ts", "etrade", 7],
  ["src/agents/routes/etradeOptionsRuns.ts", "alpaca", 2],
  ["src/agents/routes/etradeOptionsRuns.ts", "etrade", 14],
  ["src/agents/routes/etradeOptionsScreen.ts", "etrade", 20],
  ["src/agents/routes/kvWipe.ts", "etrade", 11],
  ["src/agents/routes/marketDataResearch.ts", "alpaca", 8],
  ["src/agents/routes/marketDataResearch.ts", "etrade", 7],
  ["src/agents/routes/marketDataResearch.ts", "yahoo", 14],
  ["src/agents/routes/optionsProviderGate.ts", "alpaca", 1],
  ["src/agents/routes/optionsProviderGate.ts", "etrade", 11],
  ["src/agents/routes/optionsProviderGate.ts", "yahoo", 2],
  ["src/agents/routes/optionsRegenerate.ts", "etrade", 5],
  ["src/agents/routes/paidStockScreenSeam.ts", "etrade", 10],
  // #4431 INTEGRATION: the explicit routeProvider arg and its
  // comments name the route's provider and the effective default.
  ["src/agents/routes/paidStockScreenSeam.ts", "alpaca", 1],
  ["src/agents/routes/paidStockScreenSeam.ts", "yahoo", 2],
  ["src/agents/routes/platformTenants.ts", "etrade", 1],
  ["src/agents/routes/premium.ts", "etrade", 9],
  // #4431 INTEGRATION: the unconfigured-refusal comment names the
  // platform default the premium path no longer leans on.
  ["src/agents/routes/premium.ts", "alpaca", 1],
  ["src/agents/routes/premium.ts", "yahoo", 7],
  ["src/agents/routes/reports.ts", "alpaca", 1],
  ["src/agents/routes/routeIdentity.ts", "etrade", 1],
  ["src/agents/routes/schedules.ts", "etrade", 21],
  ["src/agents/routes/screenerResearch.ts", "yahoo", 1],
  ["src/agents/routes/serviceUser.ts", "etrade", 44],
  ["src/agents/routes/tradingIntegrations.ts", "etrade", 24],
  ["src/agents/routes/watchlists.ts", "alpaca", 1],
  ["src/agents/routes/watchlists.ts", "etrade", 29],
  ["src/agents/sandbox-agent.ts", "etrade", 7],
  ["src/agents/sandboxA2aDispatch.ts", "etrade", 1],
  ["src/agents/scheduled-agent.ts", "etrade", 2],
  ["src/agents/scheduledTasksPipeline.ts", "alpaca", 1],
  // #4452 INTEGRATION, fallen back in #3960: the host-side
  // options-step wiring no longer binds the chain source to the
  // provider's client directly (the shared residency factory
  // does) — only the pre-existing header line remains.
  ["src/agents/scheduledTasksPipeline.ts", "etrade", 1],
  ["src/agents/scheduledTasksPipeline.ts", "yahoo", 2],
  ["src/agents/screener-agent.ts", "alpaca", 24],
  ["src/agents/screener-agent.ts", "etrade", 91],
  ["src/agents/screener-agent.ts", "yahoo", 70],
  ["src/agents/screenerA2aDispatch.ts", "etrade", 2],
  ["src/agents/screenerA2aDispatch.ts", "yahoo", 5],
  ["src/agents/slackA2aDispatch.ts", "etrade", 11],
  ["src/agents/slackAgent.ts", "etrade", 13],
  ["src/agents/social/README.md", "etrade", 1],
  ["src/agents/social/briefStore.ts", "etrade", 1],
  ["src/agents/social/durableStores.ts", "etrade", 1],
  ["src/agents/trading-trade-workflow.ts", "etrade", 6],
  ["src/aspects/errorCodes.ts", "alpaca", 1],
  ["src/aspects/errorCodes.ts", "etrade", 72],
  ["src/aspects/errorCodes.ts", "yahoo", 2],
  ["src/aspects/loggingAspect.ts", "etrade", 14],
  ["src/breakers/breakerDecorator.ts", "etrade", 1],
  ["src/breakers/breakerDecorator.ts", "yahoo", 1],
  ["src/breakers/breakerPorts.ts", "alpaca", 1],
  ["src/breakers/breakerPorts.ts", "etrade", 1],
  ["src/breakers/breakerPorts.ts", "yahoo", 1],
  ["src/breakers/createBreakerPorts.ts", "etrade", 1],
  ["src/breakers/marketDataBreakerWrapper.ts", "alpaca", 1],
  ["src/breakers/marketDataBreakerWrapper.ts", "yahoo", 6],
  ["src/client/AdminQueueWipePanel.tsx", "etrade", 2],
  ["src/client/BrokerPanel.tsx", "alpaca", 38],
  ["src/client/BrokerPanel.tsx", "etrade", 4],
  ["src/client/AlpacaSignInCard.tsx", "alpaca", 32],
  ["src/client/ETradeDynamicMenu.tsx", "etrade", 1],
  // #3937 INTEGRATION: the diagnostics fallback names the platform default
  // broker (the legacy etrade fallback is gone); the comment was neutralized.
  ["src/client/TradeHub.tsx", "alpaca", 24],
  ["src/client/TradeHub.tsx", "etrade", 103],
  ["src/client/ProviderConnectivityDashboard.tsx", "etrade", 20],
  ["src/client/SchedulesPanel.tsx", "etrade", 7],
  ["src/client/TradingApprovalsQueue.tsx", "etrade", 7],
  ["src/client/accountApi.ts", "etrade", 30],
  ["src/client/agenticWalletApi.ts", "etrade", 1],
  ["src/client/brokerEndpoints.ts", "alpaca", 4],
  ["src/client/brokerEndpoints.ts", "etrade", 22],
  ["src/client/brokerEnvironment.ts", "etrade", 10],
  ["src/client/brokerPortfolio.ts", "alpaca", 1],
  ["src/client/brokerPortfolio.ts", "etrade", 3],
  ["src/client/brokerSectionNav.ts", "alpaca", 4],
  ["src/client/brokerSectionNav.ts", "etrade", 7],
  ["src/client/chat/copilotRegistry.ts", "alpaca", 2],
  ["src/client/components/AutopilotControlCenter.tsx", "alpaca", 3],
  ["src/client/components/AutopilotControlCenter.tsx", "etrade", 11],
  ["src/client/components/ui/primitives.css", "etrade", 2],
  ["src/client/discoveryApi.ts", "etrade", 3],
  ["src/client/executionCard.ts", "etrade", 3],
  ["src/client/firstRunApi.ts", "etrade", 11],
  ["src/client/iaaaAdminApi.ts", "etrade", 1],
  ["src/client/iaaaEndpointCatalog.ts", "etrade", 44],
  ["src/client/orderPreviewCard.ts", "etrade", 1],
  ["src/client/pollingConfig.ts", "etrade", 1],
  ["src/client/portfolioRiskApi.ts", "alpaca", 1],
  ["src/client/portfolioRiskApi.ts", "etrade", 14],
  ["src/client/router.ts", "etrade", 2],
  ["src/client/runExport.ts", "etrade", 9],
  ["src/client/scannerApi.ts", "etrade", 7],
  ["src/client/serviceUserApi.ts", "etrade", 14],
  ["src/client/screeningAdapters.ts", "alpaca", 1],
  ["src/client/screeningAdapters.ts", "etrade", 4],
  ["src/client/screeningAdapters.ts", "nasdaq", 1],
  // #4430 INTEGRATION: the workflow-backed variant's registry id
  // ("yahoo-finance") named verbatim — a data-bearing identifier.
  ["src/client/screeningAdapters.ts", "yahoo", 7],
  ["src/client/stockCopilotApi.ts", "alpaca", 1],
  ["src/client/styles.deprecated.css", "alpaca", 8],
  ["src/client/styles.deprecated.css", "etrade", 79],
  ["src/client/styles.deprecated.css", "yahoo", 4],
  ["src/client/tenantProviders.ts", "alpaca", 10],
  ["src/client/tenantProviders.ts", "etrade", 4],
  ["src/client/tenantProviders.ts", "nasdaq", 1],
  ["src/client/tenantProviders.ts", "public.com", 1],
  ["src/client/tenantProviders.ts", "yahoo", 1],
  ["src/client/tokens.css", "etrade", 5],
  ["src/client/tradeExecutionPreviewModel.ts", "etrade", 5],
  ["src/config/agenticPaymentsModes.ts", "etrade", 1],
  ["src/config/asyncJobModes.ts", "etrade", 5],
  ["src/config/cloudflareBrowserMiscModes.ts", "etrade", 15],
  ["src/config/cloudflareBrowserMiscModes.ts", "yahoo", 2],
  ["src/config/curatedStockUniverse.ts", "yahoo", 1],
  ["src/config/discoveryRankingModes.ts", "etrade", 1],
  ["src/config/environment.ts", "etrade", 56],
  ["src/config/etapiConfig.ts", "etrade", 1],
  ["src/config/etapiConfig.ts", "nasdaq", 2],
  ["src/config/etradeModes.ts", "etrade", 84],
  ["src/config/featureFlags.ts", "etrade", 8],
  ["src/config/marketDataModes.ts", "alpaca", 16],
  ["src/config/marketDataModes.ts", "etrade", 2],
  ["src/config/portfolioRepairModes.ts", "etrade", 4],
  ["src/config/quoteModes.ts", "alpaca", 12],
  ["src/config/quoteModes.ts", "etrade", 14],
  ["src/config/quoteModes.ts", "yahoo", 15],
  // Issue #5912 — census disposition: the research run's default venue id is
  // now one externalized config value (DEFAULT_RESEARCH_BROKER_ID) instead of
  // the hardcoded platform name inside the provider. This is the value that
  // replaces a hardcode, so the row is a replacement, not a new brand use.
  ["src/config/researchJobConfig.ts", "etrade", 1],
  ["src/config/reportGeneratorModes.ts", "etrade", 1],
  ["src/config/reportGeneratorModes.ts", "yahoo", 3],
  ["src/config/restTwinsModes.ts", "alpaca", 1],
  ["src/config/restTwinsModes.ts", "etrade", 3],
  ["src/config/tradingAgentConfig.ts", "alpaca", 5],
  ["src/config/tradingAgentConfig.ts", "etrade", 4],
  ["src/data/bucketPorts.ts", "etrade", 4],
  ["src/data/commercialPorts.ts", "alpaca", 10],
  ["src/data/commercialPorts.ts", "etrade", 7],
  ["src/data/createBucketPorts.ts", "etrade", 1],
  ["src/data/createTokenPorts.ts", "etrade", 6],
  ["src/data/d1IvHistoryAdapter.ts", "etrade", 1],
  ["src/data/d1ProviderConfigAdapter.ts", "etrade", 6],
  ["src/data/dataProviderPortsProvider.ts", "etrade", 1],
  ["src/data/discoveryRunPorts.ts", "alpaca", 2],
  ["src/data/discoveryRunPorts.ts", "etrade", 7],
  // #4282 P2b: the IvHistory etrade count drops 3 -> 2 — the
  // CREATE TABLE line (broker DEFAULT 'etrade') moved to the DO
  // catalogue (row below); the 2 remaining lines are the ALTER
  // const that stays inline until P3 and the pre-#3326 comment.
  // #4282 P3: the count drops 2 -> 1 — the ALTER const (broker
  // DEFAULT 'etrade') moved to the remainder catalogue (row at the
  // end of this baseline); the 1 remaining line is the pre-#3326
  // comment (E*TRADE chains).
  ["src/data/doSqliteIvHistoryAdapter.ts", "etrade", 1],
  ["src/data/doSqliteProviderConfigAdapter.ts", "etrade", 9],
  ["src/data/doTokenFamilyAdapter.ts", "etrade", 5],
  ["src/data/drizzleSchema.ts", "etrade", 5],
  // #4431 INTEGRATION: the corrected "Absent row = alpaca" comments
  // name the code default DEFAULT_TENANT_PROVIDERS.
  ["src/data/drizzleSchema.ts", "alpaca", 2],
  ["src/data/durableKv.ts", "etrade", 1],
  // #3932 INTEGRATION: the persisted sentiment dataset definition
  // names its feed ("yahoo-news") — provenance data, not framing.
  ["src/data/feedDatasetPorts.ts", "yahoo", 3],
  ["src/data/inMemoryProviderConfigAdapter.ts", "etrade", 6],
  ["src/data/inMemoryTokenFamilyAdapter.ts", "etrade", 6],
  ["src/data/ivHistoryPorts.ts", "alpaca", 3],
  ["src/data/ivHistoryPorts.ts", "etrade", 6],
  ["src/data/jobPipelinePorts.ts", "yahoo", 1],
  // #4282 P1: the runner's etrade count drops 7 -> 4 — the 3 SQL lines
  // (v19 agent_tenant_settings data_provider_id/broker_id and v45
  // agent_iv_history broker, all DEFAULT 'etrade') moved to the D1
  // catalogue; the 4 remaining lines are comments. The catalogue row
  // at the end of this baseline carries the moved lines.
  ["src/data/migrationRunner.ts", "alpaca", 1],
  ["src/data/migrationRunner.ts", "etrade", 4],
  ["src/data/ormFacade.ts", "etrade", 5],
  ["src/data/ormSchema.ts", "etrade", 1],
  ["src/data/providerConfigPorts.ts", "alpaca", 3],
  ["src/data/providerConfigPorts.ts", "etrade", 10],
  ["src/data/providerConfigPorts.ts", "yahoo", 4],
  ["src/data/quoteSourcePorts.ts", "alpaca", 2],
  ["src/data/quoteSourcePorts.ts", "yahoo", 2],
  ["src/data/scanRunPorts.ts", "alpaca", 2],
  ["src/data/scanRunPorts.ts", "etrade", 5],
  ["src/data/tokenFamilyKvImpl.ts", "etrade", 48],
  ["src/data/tokenPorts.ts", "etrade", 49],
  ["src/enrichment/enrichmentPorts.ts", "alpaca", 19],
  ["src/enrichment/enrichmentPorts.ts", "yahoo", 19],
  ["src/enrichment/enrichmentService.ts", "alpaca", 11],
  ["src/enrichment/enrichmentService.ts", "yahoo", 13],
  ["src/errors/errorCatalog.deprecated.json", "etrade", 10],
  ["src/errors/errorCatalog.deprecated.json", "yahoo", 1],
  ["src/events/screenerEvents.ts", "etrade", 1],
  ["src/events/screenerPublishers.ts", "etrade", 12],
  ["src/features/featureFlagPorts.ts", "alpaca", 2],
  ["src/features/featureFlagPorts.ts", "yahoo", 2],
  ["src/judge-routing.ts", "alpaca", 2],
  ["src/judge-routing.ts", "etrade", 2],
  ["src/judge-routing.ts", "yahoo", 2],
  ["src/mcps/openaimp/agenticPaymentCommands.ts", "etrade", 4],
  ["src/mcps/openaimp/analyzeJobCommands.ts", "alpaca", 3],
  ["src/mcps/openaimp/analyzeJobCommands.ts", "etrade", 3],
  ["src/mcps/openaimp/analyzeJobCommands.ts", "nasdaq", 2],
  ["src/mcps/openaimp/analyzeJobCommands.ts", "yahoo", 3],
  ["src/mcps/openaimp/chainJobCommands.ts", "alpaca", 3],
  ["src/mcps/openaimp/chainJobCommands.ts", "etrade", 3],
  ["src/mcps/openaimp/chainJobCommands.ts", "nasdaq", 2],
  ["src/mcps/openaimp/chainJobCommands.ts", "yahoo", 3],
  ["src/mcps/openaimp/cloudflareAgentCommands.ts", "etrade", 32],
  ["src/mcps/openaimp/commands.ts", "alpaca", 3],
  ["src/mcps/openaimp/commands.ts", "etrade", 28],
  ["src/mcps/openaimp/deliverJobCommands.ts", "alpaca", 3],
  ["src/mcps/openaimp/deliverJobCommands.ts", "etrade", 3],
  ["src/mcps/openaimp/deliverJobCommands.ts", "nasdaq", 2],
  ["src/mcps/openaimp/deliverJobCommands.ts", "yahoo", 3],
  ["src/mcps/openaimp/enrichJobCommands.ts", "alpaca", 3],
  ["src/mcps/openaimp/enrichJobCommands.ts", "etrade", 3],
  ["src/mcps/openaimp/enrichJobCommands.ts", "nasdaq", 2],
  ["src/mcps/openaimp/enrichJobCommands.ts", "yahoo", 3],
  ["src/mcps/openaimp/etradeCommands.ts", "etrade", 143],
  ["src/mcps/openaimp/feedJobCommands.ts", "alpaca", 4],
  ["src/mcps/openaimp/feedJobCommands.ts", "etrade", 4],
  ["src/mcps/openaimp/feedJobCommands.ts", "nasdaq", 3],
  ["src/mcps/openaimp/feedJobCommands.ts", "yahoo", 4],
  ["src/mcps/openaimp/generateJobCommands.ts", "alpaca", 3],
  ["src/mcps/openaimp/generateJobCommands.ts", "etrade", 3],
  ["src/mcps/openaimp/generateJobCommands.ts", "nasdaq", 2],
  ["src/mcps/openaimp/generateJobCommands.ts", "yahoo", 3],
  ["src/mcps/openaimp/index.ts", "alpaca", 4],
  ["src/mcps/openaimp/index.ts", "etrade", 7],
  ["src/mcps/openaimp/index.ts", "yahoo", 5],
  // #3887 INTEGRATION: the ladder tool speaks the provider's own order vocabulary (classes, bracket legs), so its placement path names it.
  // #4014 INTEGRATION growth: alpaca_get_option_chain is this file's first
  // provider-specific options-chain tool. The tenant data-provider chain gate
  // refuses an alpaca data provider, so the broker's own chain needed a tool;
  // naming the provider in its schema, audit event and error text is the job.
  ["src/mcps/openaimp/marketDataCommands.ts", "alpaca", 75],
  ["src/mcps/openaimp/marketDataCommands.ts", "etrade", 5],
  ["src/mcps/openaimp/marketDataCommands.ts", "yahoo", 4],
  ["src/mcps/openaimp/mcpPermissionPorts.ts", "alpaca", 6],
  ["src/mcps/openaimp/mcpPermissionPorts.ts", "etrade", 11],
  ["src/mcps/openaimp/meshDoorCommands.ts", "alpaca", 6],
  ["src/mcps/openaimp/meshDoorCommands.ts", "etrade", 17],
  ["src/mcps/public/publicMcp.ts", "public.com", 6],
  ["src/observability/alertingList.ts", "yahoo", 3],
  ["src/observability/resourceEventGuard.ts", "etrade", 1],
  ["src/orchestrations/orchestrationStatus.ts", "alpaca", 1],
  ["src/orchestrations/orchestrationStatus.ts", "etrade", 2],
  ["src/outcomes/outcomeAspects.ts", "etrade", 1],
  ["src/outcomes/outcomeCatalog.json", "alpaca", 1],
  ["src/outcomes/outcomeCatalog.json", "etrade", 1],
  ["src/outcomes/outcomeCatalog.json", "yahoo", 1],
  ["src/patterns/interfaces.ts", "alpaca", 1],
  ["src/patterns/interfaces.ts", "etrade", 3],
  ["src/security/apiKeys.ts", "etrade", 2],
  ["src/security/brokerTokenRejection.ts", "etrade", 9],
  // #3515 S3 batch 8 INTEGRATION: the E*TRADE OAuth adapter's own
  // structured event names (`etradeOAuth.*`) + `component:` lines
  // (124->131) — naming the provider is the adapter's job.
  ["src/security/etradeOAuth.ts", "etrade", 131],
  ["src/security/etradeTokenCache.ts", "etrade", 3],
  ["src/security/githubOAuth.ts", "etrade", 1],
  ["src/security/grantProposals.ts", "etrade", 1],
  ["src/security/iaaaAccessRequests.ts", "etrade", 1],
  ["src/security/iaaaLifecycleWiring.ts", "etrade", 26],
  ["src/security/iaaaMigration.ts", "etrade", 16],
  ["src/security/index.ts", "etrade", 2],
  ["src/security/oauth2Core.ts", "etrade", 2],
  ["src/security/openapiSpec.ts", "nasdaq", 1],
  ["src/security/openapiSpec.ts", "yahoo", 4],
  ["src/security/outboundRateLimiter.ts", "alpaca", 7],
  ["src/security/outboundRateLimiter.ts", "etrade", 8],
  ["src/security/pepGateway.ts", "etrade", 8],
  ["src/security/publicOAuth.ts", "etrade", 3],
  ["src/security/publicOAuth.ts", "public.com", 3],
  ["src/security/serviceIdentity.ts", "etrade", 4],
  ["src/security/serviceTokens.ts", "etrade", 1],
  ["src/security/sessionStore.ts", "etrade", 5],
  ["src/security/storeMetrics.ts", "etrade", 1],
  ["src/security/webhookReplay.ts", "etrade", 5],
  ["src/security/webhookSecurity.ts", "etrade", 1],
  ["src/server.ts", "etrade", 1],
  ["src/server/routes/auth.ts", "etrade", 36],
  ["src/server/routes/auth.ts", "public.com", 3],
  ["src/server/routes/core.ts", "etrade", 3],
  ["src/server/routes/core.ts", "public.com", 1],
  ["src/server/routes/messaging.ts", "etrade", 7],
  ["src/server/routes/platform.ts", "etrade", 3],
  ["src/server/routes/queue.ts", "etrade", 2],
  ["src/server/routes/trading.ts", "alpaca", 2],
  ["src/server/routes/trading.ts", "etrade", 4],
  ["src/server/routes/trading.ts", "yahoo", 4],
  ["src/services/agenticPayments.ts", "etrade", 6],
  ["src/services/analyzePipelineJobs.ts", "alpaca", 1],
  ["src/services/analyzePipelineJobs.ts", "yahoo", 4],
  ["src/services/betaService.ts", "yahoo", 4],
  ["src/services/browserAgent.ts", "etrade", 5],
  ["src/services/cfpayA2A.ts", "etrade", 1],
  ["src/services/chainPipelineJobs.ts", "alpaca", 1],
  ["src/services/chainPipelineJobs.ts", "yahoo", 1],
  ["src/services/checkoutPorts.ts", "etrade", 1],
  ["src/services/cloudflareEmailSender.ts", "etrade", 2],
  ["src/services/comparisonNlqRunner.ts", "etrade", 1],
  ["src/services/consolidatedCronEntries.ts", "etrade", 3],
  ["src/services/correlationService.ts", "yahoo", 1],
  ["src/services/cryptoUtils.ts", "etrade", 1],
  ["src/services/deliverJobs.ts", "etrade", 3],
  ["src/services/deliverPipelineJobs.ts", "alpaca", 2],
  ["src/services/deliverPipelineJobs.ts", "yahoo", 2],
  ["src/services/discoveryService.ts", "alpaca", 2],
  ["src/services/discoveryService.ts", "etrade", 4],
  ["src/services/discoveryService.ts", "yahoo", 1],
  ["src/services/durableFibers.ts", "etrade", 2],
  ["src/services/enrichJobs.ts", "yahoo", 4],
  ["src/services/enrichPipelineJobs.ts", "alpaca", 2],
  ["src/services/enrichPipelineJobs.ts", "nasdaq", 1],
  ["src/services/enrichPipelineJobs.ts", "yahoo", 2],
  ["src/services/etrade.ts", "etrade", 123],
  ["src/services/etrade/types.ts", "etrade", 16],
  ["src/services/etradeAuthPreflight.ts", "etrade", 37],
  ["src/services/etradeExecutionGate.ts", "etrade", 21],
  ["src/services/etradeOAuth.ts", "etrade", 3],
  ["src/services/eventCalendar.ts", "etrade", 1],
  ["src/services/eventCalendar.ts", "yahoo", 5],
  ["src/services/feedJobs.ts", "alpaca", 7],
  ["src/services/feedJobs.ts", "etrade", 7],
  ["src/services/feedJobs.ts", "nasdaq", 11],
  ["src/services/feedJobs.ts", "yahoo", 45],
  ["src/services/feedPipelineJobs.ts", "alpaca", 9],
  ["src/services/feedPipelineJobs.ts", "etrade", 8],
  ["src/services/feedPipelineJobs.ts", "nasdaq", 23],
  ["src/services/feedPipelineJobs.ts", "public.com", 3],
  ["src/services/feedPipelineJobs.ts", "yahoo", 86],
  ["src/services/feedProviderWiring.ts", "alpaca", 2],
  ["src/services/feedProviderWiring.ts", "etrade", 4],
  ["src/services/feedProviderWiring.ts", "nasdaq", 1],
  ["src/services/feedProviderWiring.ts", "yahoo", 7],
  ["src/services/feedSnapshotJob.ts", "etrade", 4],
  ["src/services/fitDiscoveryRunner.ts", "etrade", 4],
  ["src/services/gatedSlackDelivery.ts", "etrade", 1],
  ["src/services/generatePipelineJobs.ts", "alpaca", 2],
  ["src/services/generatePipelineJobs.ts", "yahoo", 3],
  ["src/services/goalDrivenScreen.ts", "etrade", 2],
  ["src/services/goalDrivenScreen.ts", "yahoo", 1],
  ["src/services/goalGather.ts", "etrade", 10],
  ["src/services/goalGather.ts", "yahoo", 19],
  ["src/services/goalScreenReports.ts", "yahoo", 2],
  ["src/services/goalScreenWorkflowSubmission.ts", "etrade", 1],
  ["src/services/goalScreenWorkflowSubmission.ts", "yahoo", 2],
  ["src/services/hedgeProposals.ts", "etrade", 10],
  // #4672 (Gap 18): marketDataResearch.ts/alpaca 120->130 — adds exerciseOptionPosition (`POST /v2/positions/{id}/exercise`) on AlpacaMarketDataProvider.
  ["src/services/marketDataResearch.ts", "alpaca", 130],
  ["src/services/marketDataResearch.ts", "etrade", 2],
  ["src/services/marketDataResearch.ts", "yahoo", 31],
  ["src/services/marketDataService.ts", "alpaca", 3],
  ["src/services/marketDataService.ts", "etrade", 2],
  ["src/services/marketDataService.ts", "yahoo", 4],
  ["src/services/marketStream.ts", "alpaca", 19],
  ["src/services/marketStream.ts", "yahoo", 16],
  ["src/services/meteredPaymentGate.ts", "etrade", 1],
  ["src/services/nasdaqListings.ts", "etrade", 2],
  ["src/services/nasdaqListings.ts", "nasdaq", 13],
  ["src/services/oasfRecords.ts", "etrade", 2],
  ["src/services/optionsAuthFreshness.ts", "etrade", 21],
  ["src/services/optionsAuthFreshness.ts", "yahoo", 1],
  ["src/services/optionsProviderContext.ts", "alpaca", 7],
  // #4014 INTEGRATION growth: optionsChainsServingProvider names the capable
  // provider that actually serves a chain when the tenant's selection cannot.
  // Merged #3990 + #4014 baselines (max of both sides; measured 7/13/4 on the
  // merged file, all under these ceilings).
  ["src/services/optionsProviderContext.ts", "etrade", 16],
  ["src/services/optionsProviderContext.ts", "yahoo", 4],
  ["src/services/optionsServeRecord.ts", "etrade", 5],
  ["src/services/patternSignals.ts", "etrade", 1],
  ["src/services/pipelineChains.ts", "yahoo", 3],
  ["src/services/pipelinePolicy.ts", "etrade", 1],
  ["src/services/pipelinePolicy.ts", "yahoo", 1],
  ["src/services/portfolioRisk.ts", "alpaca", 2],
  ["src/services/portfolioRisk.ts", "etrade", 12],
  ["src/services/providerConnections.ts", "alpaca", 3],
  ["src/services/providerConnections.ts", "etrade", 5],
  ["src/services/publicData.ts", "etrade", 15],
  ["src/services/publicData.ts", "public.com", 2],
  ["src/services/quoteCache.ts", "yahoo", 3],
  ["src/services/rankingCore.ts", "etrade", 1],
  ["src/services/recommendationBundle.ts", "etrade", 5],
  ["src/services/repairProposals.ts", "etrade", 18],
  ["src/services/researchGates.ts", "etrade", 1],
  ["src/services/researchPipeline.ts", "etrade", 1],
  ["src/services/researchProviders.ts", "etrade", 10],
  ["src/services/researchProviders.ts", "yahoo", 2],
  ["src/services/resilience.ts", "etrade", 1],
  ["src/services/resilience.ts", "yahoo", 2],
  ["src/services/riskPolicyEngine.ts", "etrade", 1],
  ["src/services/sandboxAgent.ts", "etrade", 1],
  ["src/services/scheduleSystems.ts", "etrade", 1],
  ["src/services/scheduledTasks.ts", "etrade", 87],
  ["src/services/scheduledTasks.ts", "yahoo", 15],
  ["src/services/screenerFollowupDelivery.ts", "etrade", 6],
  ["src/services/screenerFollowups.ts", "etrade", 1],
  // #5823 INTEGRATION: the screener step registry binds the feed-stage
  // quote/history deps over the #3941 capture-wired provider — naming the
  // provider is the registry's job (the per-provider binds + the refusal
  // names + the factory's doc comment).
  ["src/services/screenerPipelineJobs.ts", "alpaca", 3],
  ["src/services/screenerPipelineJobs.ts", "etrade", 4],
  ["src/services/screenerPipelineJobs.ts", "nasdaq", 2],
  ["src/services/screenerPipelineJobs.ts", "yahoo", 12],
  ["src/services/screeningDelivery.ts", "etrade", 6],
  ["src/services/screeningRuntime.ts", "etrade", 3],
  ["src/services/screeningRuntime.ts", "yahoo", 13],
  ["src/services/shardExecutors.ts", "etrade", 39],
  ["src/services/shardExecutors.ts", "yahoo", 9],
  ["src/services/shardJobs.ts", "etrade", 9],
  ["src/services/shardJobs.ts", "yahoo", 7],
  ["src/services/stockCopilot.ts", "alpaca", 8],
  ["src/services/stockCopilot.ts", "etrade", 1],
  ["src/services/stockCopilotIntrospection.ts", "alpaca", 1],
  ["src/services/stockCopilotIntrospection.ts", "etrade", 1],
  ["src/services/stockCopilotIntrospection.ts", "nasdaq", 1],
  ["src/services/stockCopilotIntrospection.ts", "yahoo", 1],
  ["src/services/stockCopilotSessions.ts", "alpaca", 1],
  ["src/services/tenantProviders.ts", "alpaca", 13],
  ["src/services/tenantProviders.ts", "etrade", 12],
  ["src/services/tenantProviders.ts", "nasdaq", 4],
  ["src/services/tenantProviders.ts", "public.com", 2],
  ["src/services/tenantProviders.ts", "yahoo", 2],
  ["src/services/thinkHarness.ts", "etrade", 12],
  ["src/services/tradingWebhooks.ts", "etrade", 24],
  ["src/services/userEmailDestination.ts", "etrade", 1],
  ["src/services/webFetch.ts", "etrade", 2],
  ["src/services/workflowLifecycle.ts", "etrade", 1],
  ["src/services/workflowRuns.ts", "etrade", 1],
  ["src/services/x402CheckoutAdapter.ts", "etrade", 1],
  ["src/services/x402PaymentPath.ts", "etrade", 1],
  ["src/telemetry/resourceUsagePorts.ts", "etrade", 1],
  ["src/trading/agent.ts", "alpaca", 1],
  ["src/trading/agent.ts", "etrade", 4],
  ["src/trading/alpaca/credentialResolution.ts", "alpaca", 2],
  ["src/trading/alpaca/credentialStore.ts", "alpaca", 8],
  ["src/trading/alpaca/credentialStore.ts", "etrade", 3],
  ["src/trading/alpaca/credentials.ts", "alpaca", 6],
  ["src/trading/alpaca/fillLots.ts", "alpaca", 4],
  ["src/trading/alpaca/occSymbol.ts", "alpaca", 8],
  ["src/trading/alpaca/optionsData.ts", "alpaca", 27],
  ["src/trading/alpaca/optionsData.ts", "etrade", 5],
  ["src/trading/alpaca/platform.ts", "alpaca", 113],
  ["src/trading/alpaca/platform.ts", "etrade", 8],
  // #3515 S3 batch 4 INTEGRATION: the console migration adds the
  // module-logger component line ("trading/alpaca/signIn") plus two
  // `alpacaSignIn.*` structured-log event names; the log messages
  // are preserved verbatim. alpaca 6->9.
  ["src/trading/alpaca/signIn.ts", "alpaca", 9],
  ["src/trading/brokerCatalog.ts", "alpaca", 19],
  ["src/trading/brokerCatalog.ts", "etrade", 29],
  ["src/trading/brokerPanels.ts", "alpaca", 1],
  ["src/trading/brokerPanels.ts", "etrade", 1],
  ["src/trading/brokerPresentation.ts", "alpaca", 12],
  ["src/trading/brokerPresentation.ts", "etrade", 14],
  ["src/trading/channels/approval.ts", "etrade", 3],
  // #4674 (Gap 20): adapters.ts/alpaca 20->28 — adds fetchAlpacaNewsArticles (/v1beta1/news) so Alpaca DataProvider declares news natively.
  ["src/trading/dataProviders/adapters.ts", "alpaca", 28],
  ["src/trading/dataProviders/adapters.ts", "etrade", 103],
  ["src/trading/dataProviders/adapters.ts", "nasdaq", 17],
  ["src/trading/dataProviders/adapters.ts", "public.com", 4],
  ["src/trading/dataProviders/adapters.ts", "yahoo", 32],
  ["src/trading/dataProviders/conformance.ts", "etrade", 1],
  ["src/trading/dataProviders/contract.ts", "alpaca", 9],
  ["src/trading/dataProviders/contract.ts", "etrade", 22],
  ["src/trading/dataProviders/contract.ts", "nasdaq", 5],
  ["src/trading/dataProviders/contract.ts", "yahoo", 14],
  ["src/trading/dataProviders/fetchOutcome.ts", "etrade", 12],
  ["src/trading/dataProviders/lifecycle.ts", "etrade", 3],
  ["src/trading/dataProviders/providerHealth.ts", "etrade", 1],
  ["src/trading/dataProviders/registry.ts", "etrade", 1],
  ["src/trading/dataProviders/registry.ts", "yahoo", 2],
  ["src/trading/dataSources.ts", "etrade", 3],
  ["src/trading/dataSources.ts", "public.com", 1],
  ["src/trading/dataSources.ts", "tastytrade", 3],
  ["src/trading/dataSources.ts", "yahoo", 2],
  ["src/trading/email/agent.ts", "etrade", 42],
  // Issue #4659: the stop-price refusal names the broker in its user-facing
  // message, the same INTEGRATION growth this row already records for the
  // adapter's own vocabulary.
  // #3515 S3 batch 4 INTEGRATION: the console migration adds the
  // module-logger component line ("trading/etrade/client") plus 26
  // `etradeClient.*` structured-log event names; the log messages
  // are preserved verbatim. etrade 330->357.
  ["src/trading/etrade/client.ts", "etrade", 357],
  ["src/trading/etrade/optionOrders.ts", "etrade", 9],
  // Issue #4656: the adapter names its own time-in-force mapper (etradeOrderTerm)
  // — a code identifier in the broker's own adapter, the disposition this section
  // already records for per-broker execution entries.
  // #3515 S3 batch 4 INTEGRATION: the console migration adds the
  // module-logger component line ("trading/etrade/platform") plus two
  // `etradePlatform.*` structured-log event names (baseline 94 was
  // already stale-high vs main's 92; net +3). etrade 94->95.
  ["src/trading/etrade/platform.ts", "etrade", 95],
  ["src/trading/etrade/quoteConfig.ts", "etrade", 2],
  // #3515 S3 batch 4 INTEGRATION: the console migration adds the
  // module-logger component line ("trading/etrade/quoteTrace") and
  // nothing else brand-bearing (the event name is dynamic).
  // etrade 1->2.
  ["src/trading/etrade/quoteTrace.ts", "etrade", 2],
  ["src/trading/factorGrades.ts", "etrade", 5],
  ["src/trading/gather.ts", "alpaca", 4],
  ["src/trading/gather.ts", "etrade", 3],
  ["src/trading/index.ts", "alpaca", 10],
  ["src/trading/index.ts", "etrade", 8],
  ["src/trading/index.ts", "yahoo", 1],
  ["src/trading/indexMembership.ts", "etrade", 3],
  ["src/trading/indexMembership.ts", "yahoo", 3],
  ["src/trading/liveScreener.ts", "etrade", 2],
  ["src/trading/optionChainSource.ts", "alpaca", 1],
  ["src/trading/optionChainSource.ts", "etrade", 3],
  ["src/trading/options/calibratedOptionChains.ts", "etrade", 6],
  ["src/trading/options/flows/flowService.ts", "etrade", 10],
  ["src/trading/options/flows/flowService.ts", "yahoo", 6],
  ["src/trading/options/flows/newsSentiment.ts", "yahoo", 1],
  ["src/trading/options/ivCollector.ts", "etrade", 2],
  ["src/trading/options/llmIdeas.ts", "etrade", 32],
  ["src/trading/options/panelFetchDteBands.ts", "etrade", 1],
  ["src/trading/options/panelFetchDteBands.ts", "yahoo", 1],
  ["src/trading/options/strategyChoice.ts", "etrade", 3],
  ["src/trading/options/strategyEngine.ts", "etrade", 4],
  ["src/trading/options/strategyEngine.ts", "yahoo", 1],
  ["src/trading/options/syntheticChains.ts", "etrade", 7],
  ["src/trading/options/unifiedOptionsService.ts", "etrade", 40],
  ["src/trading/optionsReportPdf.ts", "etrade", 2],
  ["src/trading/optionsReportXlsx.ts", "etrade", 1],
  ["src/trading/optionsScreener.ts", "etrade", 17],
  ["src/trading/platformHistory.ts", "yahoo", 24],
  ["src/trading/quotePolicies.ts", "etrade", 6],
  ["src/trading/registry.ts", "etrade", 2],
  ["src/trading/screener.ts", "etrade", 10],
  ["src/trading/screener.ts", "yahoo", 1],
  ["src/trading/screenerConfig.ts", "etrade", 4],
  ["src/trading/screenerConfig.ts", "yahoo", 4],
  // #3515 S3 batch 4 INTEGRATION: the console migration adds one
  // `screenerPipeline.etrade_quote_failures` structured-log event
  // name; the other three migrated sites carry no brand term.
  // etrade 110->111.
  ["src/trading/screenerPipeline.ts", "etrade", 118],
  ["src/trading/screenerPipeline.ts", "yahoo", 84],
  ["src/trading/screenerReportCsv.ts", "etrade", 1],
  ["src/trading/screenerReportPdf.ts", "alpaca", 3],
  ["src/trading/screenerReportPdf.ts", "etrade", 7],
  ["src/trading/screenerReportPdf.ts", "yahoo", 13],
  ["src/trading/screenerReportTemplate.ts", "etrade", 1],
  ["src/trading/screenerReportXlsx.ts", "etrade", 6],
  ["src/trading/screenerReportXlsx.ts", "yahoo", 7],
  ["src/trading/screeningIndicators.ts", "etrade", 3],
  ["src/trading/screeningProvider.ts", "etrade", 10],
  ["src/trading/screeningProvider.ts", "yahoo", 9],
  ["src/trading/screeningSchemas.ts", "etrade", 4],
  ["src/trading/screeningSchemas.ts", "yahoo", 3],
  ["src/trading/slack/agent.ts", "etrade", 62],
  ["src/trading/slack/agent.ts", "yahoo", 2],
  ["src/trading/stockQuoteSource.ts", "alpaca", 1],
  ["src/trading/stockQuoteSource.ts", "etrade", 2],
  // Issue #4675 INTEGRATION: Tastytrade Slice 1 catalog, config, credentials, and platform adapter.
  ["src/client/portfolioRiskApi.ts", "tastytrade", 1],
  ["src/config/tastytrade.ts", "tastytrade", 7],
  ["src/data/discoveryRunPorts.ts", "tastytrade", 1],
  ["src/data/ivHistoryPorts.ts", "tastytrade", 1],
  ["src/data/scanRunPorts.ts", "tastytrade", 1],
  ["src/services/tenantProviders.ts", "tastytrade", 2],
  ["src/trading/brokerCatalog.ts", "tastytrade", 11],
  ["src/trading/brokerPresentation.ts", "tastytrade", 7],
  ["src/trading/index.ts", "tastytrade", 5],
  ["src/trading/tastytrade/credentials.ts", "tastytrade", 76],
  ["src/trading/tastytrade/platform.ts", "tastytrade", 61],
  ["src/types.ts", "tastytrade", 13],
  ["src/trading/technicals.ts", "alpaca", 2],
  ["src/trading/technicals.ts", "etrade", 1],
  ["src/trading/technicals.ts", "yahoo", 12],
  ["src/trading/universes.ts", "etrade", 4],
  ["src/trading/universes.ts", "yahoo", 1],
  ["src/trading/voice/agent.ts", "etrade", 16],
  ["src/types.ts", "alpaca", 15],
  ["src/types.ts", "etrade", 82],
  ["src/types.ts", "yahoo", 3],
  // Issue #4676 / #3410 INTEGRATION: IBKR Hosted MCP v1 config, OAuth 2.1 + PKCE + DCR seam, and mesh registration.
  ["src/agents/orchestrator/meshMcpClient.ts", "interactive brokers / ibkr", 36],
  ["src/config/ibkr.ts", "interactive brokers / ibkr", 10],
  ["src/security/ibkrOAuth.ts", "interactive brokers / ibkr", 79],
  ["src/trading/accountBindings.ts", "interactive brokers / ibkr", 4],
  ["src/types.ts", "interactive brokers / ibkr", 1],
  // #3960 INTEGRATION: the broker stage input's residency factory
  // resolves the chain source per invocation — the legacy direct
  // client's import + construction for runs carrying no input
  // (the pair path resolves through the registry and names no
  // provider). Naming the provider is the legacy binding's job;
  // the module's prose names none.
  ["src/workflows/brokerChainSourceResidency.ts", "etrade", 2],
  // #5823 INTEGRATION: the workflow residency's feed-deps closure
  // forwards the Yahoo breaker override into the #3941 factory —
  // the doc line naming it is the wiring's job.
  ["src/workflows/jobPipelineWorkflow.ts", "yahoo", 1],
  ["src/workflows/legalApplicability.ts", "alpaca", 1],
  ["src/workflows/legalApplicability.ts", "etrade", 1],
  ["src/workflows/manualOptionsRecordBuilder.ts", "etrade", 1],
  ["src/workflows/manualOptionsResidency.ts", "etrade", 2],
  ["src/workflows/manualOptionsScreen.ts", "etrade", 4],
  ["src/workflows/manualPanelScreen.ts", "etrade", 2],
  ["src/workflows/optionsScreenPorts.ts", "etrade", 3],
  ["src/workflows/optionsStageControl.ts", "etrade", 5],
  // #4473 INTEGRATION: the universe stage input's descriptor names
  // the nasdaq screen-universe provider — the provider literal the
  // route resolution requires (nasdaqUniverseProviderFromRoute
  // refuses any other primary), carried as dispatch data and
  // validated by name. Naming the provider is the descriptor's
  // job; the row falls back if a second universe source ever
  // joins the descriptor.
  ["src/workflows/optionsStepPorts.ts", "nasdaq", 6],
  ["src/workflows/researchSubtabDisposition.ts", "alpaca", 1],
  ["src/workflows/researchSubtabDisposition.ts", "yahoo", 1],
  ["src/workflows/sagaTradeLeg.ts", "etrade", 7],
  ["src/workflows/sagaWorkflow.ts", "etrade", 3],
  ["src/workflows/sagaWorkflowFlow.ts", "etrade", 4],
  ["src/workflows/screenExecutionBroker.ts", "etrade", 5],
  ["src/workflows/screenRunFinalize.ts", "etrade", 3],
  ["src/workflows/screenerCollation.ts", "yahoo", 2],
  ["src/workflows/stageRuntimeIds.ts", "etrade", 4],
  ["src/workflows/stockCleanupRegister.ts", "etrade", 1],
  ["src/workflows/stockScreenCapability.ts", "etrade", 9],
  ["src/workflows/stockScreenCapability.ts", "yahoo", 4],
  ["src/workflows/stockScreenPlanner.ts", "etrade", 4],
  ["src/workflows/stockScreenPlanner.ts", "yahoo", 3],
  ["src/workflows/stockScreenRunSpec.ts", "etrade", 8],
  ["src/workflows/stockScreenRunSpec.ts", "yahoo", 4],
  ["src/workflows/strategyScreenPorts.ts", "alpaca", 1],
  ["src/workflows/strategyScreenPorts.ts", "etrade", 3],
  // #4473 INTEGRATION: the residency factory's refusal text names
  // the nasdaq provider whose route/adapter failed to resolve —
  // the provider is the integration's subject, and the refusal
  // names it so the run record says what could not resolve.
  ["src/workflows/universeDepsResidency.ts", "nasdaq", 2],
  ["src/workflows/workflowCatalog.ts", "etrade", 2],
  ["src/workflows/workflowPorts.ts", "etrade", 2],
  ["src/workflows/workflowPorts.ts", "yahoo", 5],
  ["wrangler.jsonc", "alpaca", 1],
  ["wrangler.jsonc", "etrade", 5],
  ["src/client/BrokerDynamicMenu.tsx", "alpaca", 24],
  ["src/client/BrokerDynamicMenu.tsx", "etrade", 25],
  ["src/client/BrokerDynamicMenu.tsx", "yahoo", 7],
  ["src/trading/voice/stockCopilotVoiceActivation.ts", "etrade", 2],
  ["docs/architecture/client-assets.md", "etrade", 1],
  ["src/agents/orchestrator/asyncJobs.ts", "alpaca", 1],
  ["src/client/AdminQueueWipePanel.tsx", "alpaca", 1],
  ["src/client/ScheduleRunLedgerPanel.tsx", "alpaca", 1],
  ["src/client/ScheduleRunLedgerPanel.tsx", "etrade", 1],
  ["src/client/SchedulesPanel.tsx", "alpaca", 2],
  ["src/client/scheduledOptionsManager/ScheduleCard.tsx", "alpaca", 2],
  ["src/client/scheduledOptionsManager/ScheduleCard.tsx", "etrade", 2],
  ["src/client/scheduledOptionsManager/ScheduleFormModal.tsx", "alpaca", 2],
  ["src/client/scheduledOptionsManager/ScheduleFormModal.tsx", "etrade", 2],
  ["src/client/scheduledOptionsManager/scheduleDetail.ts", "alpaca", 2],
  // Issue #4239: the renewal branch names the callback
  // (autoRenewETradeTokens) — a data-bearing identifier, INTEGRATION.
  ["src/client/scheduledOptionsManager/scheduleDetail.ts", "etrade", 3],
  // Issue #4239: the token-renewal record names its callback and
  // the classifier names it exactly — data-bearing identifiers,
  // dispositioned INTEGRATION (not framing).
  ["src/services/scheduleKinds.ts", "etrade", 1],
  ["src/services/unifiedScheduleManagement.ts", "etrade", 1],
  ["src/services/scheduledBrokerGuard.ts", "alpaca", 3],
  ["src/services/scheduledBrokerGuard.ts", "etrade", 14],
  ["src/services/scheduledEffectiveMode.ts", "alpaca", 7],
  ["src/services/scheduledTasks.ts", "alpaca", 7],
  ["src/services/shardExecutors.ts", "alpaca", 3],
  ["src/trading/screenerPipeline.ts", "alpaca", 32],
  ["src/trading/screeningSchemas.ts", "alpaca", 4],
  ["docs/agents/rca-aapl-bracket-order-3812.md", "alpaca", 20],
  ["docs/agents/rca-aapl-bracket-order-3812.md", "etrade", 11],
  ["src/services/providerUxLinks.ts", "alpaca", 11],
  ["src/services/tradingRunOutcome.ts", "alpaca", 2],
  // Issue #3839: the copilot capability contract and its two wiring
  // files name the providers they integrate; dispositioned INTEGRATION.
  ["docs/agents/copilot-broker-capability.md", "alpaca", 10],
  ["docs/agents/copilot-broker-capability.md", "etrade", 4],
  ["docs/agents/copilot-broker-capability.md", "yahoo", 1],
  ["src/agents/orchestrator.ts", "alpaca", 1],
  ["src/config/asyncJobModes.ts", "alpaca", 1],
  // ---- HISTORICAL (206 rows / 1127 lines) ----
  ["docs/Assessment.md", "etrade", 6],
  ["docs/Assessment.md", "yahoo", 2],
  ["docs/agents/options-report-inventory.md", "etrade", 4],
  ["docs/agents/options-report-inventory.md", "yahoo", 1],
  ["docs/archive/assessment-01.md", "etrade", 3],
  ["docs/architecture/adr/0001-derived-stable-identity.md", "etrade", 2],
  ["docs/architecture/adr/0004-screener-workflows.md", "etrade", 2],
  ["docs/architecture/adr/0008-market-data-circuit-breakers.md", "alpaca", 4],
  ["docs/architecture/adr/0008-market-data-circuit-breakers.md", "etrade", 5],
  ["docs/architecture/adr/0008-market-data-circuit-breakers.md", "yahoo", 7],
  ["docs/architecture/adr/README.md", "alpaca", 2],
  ["docs/architecture/adr/README.md", "yahoo", 1],
  ["docs/architecture/agentic/stockcopilot-evoluation.md", "alpaca", 20],
  ["docs/architecture/agentic/stockcopilot-evoluation.md", "etrade", 3],
  ["docs/architecture/agentic/stockcopilot-evoluation.md", "nasdaq", 3],
  ["docs/architecture/agentic/stockcopilot-evoluation.md", "thinkorswim", 1],
  ["docs/architecture/agentic/stockcopilot-evoluation.md", "yahoo", 3],
  ["docs/architecture/business/assessment/assessment-01.md", "etrade", 2],
  ["docs/architecture/data/assessment/assessment-01.md", "etrade", 11],
  ["docs/architecture/data/assessment/assessment-01.md", "yahoo", 5],
  ["docs/architecture/design/assessment-02.md", "alpaca", 1],
  ["docs/architecture/design/assessment-02.md", "etrade", 5],
  ["docs/architecture/design/assessment-02.md", "yahoo", 1],
  ["docs/architecture/enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md", "etrade", 8],
  ["docs/architecture/enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md", "interactive brokers / ibkr", 1],
  ["docs/architecture/enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md", "polygon", 1],
  ["docs/architecture/enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md", "thinkorswim", 1],
  ["docs/architecture/enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md", "yahoo", 6],
  ["docs/architecture/enterprise/assessment/platform-decoupling-and-native-roadmap.md", "etrade", 2],
  ["docs/architecture/enterprise/assessment/platform-decoupling-and-native-roadmap.md", "yahoo", 2],
  ["docs/architecture/enterprise/assessment/screener.md", "etrade", 15],
  ["docs/architecture/enterprise/assessment/screener.md", "yahoo", 14],
  ["docs/architecture/infrastructure/assessment-01.md", "etrade", 1],
  ["docs/architecture/integration/assessment-01.md", "etrade", 29],
  ["docs/architecture/network/assessment-01.md", "etrade", 5],
  ["docs/architecture/performance/assessment-02.md", "etrade", 1],
  ["docs/architecture/privacy/assessment/assessment-01.md", "etrade", 7],
  ["docs/architecture/privacy/assessment/assessment-01.md", "yahoo", 2],
  ["docs/architecture/product/assessment/assessment-01.md", "etrade", 3],
  ["docs/architecture/scheduling/3121-s0-inventory.md", "etrade", 9],
  ["docs/architecture/security/assessment-02.md", "etrade", 1],
  ["docs/architecture/security/assessment/assessment-01.md", "etrade", 5],
  ["docs/architecture/security/assessment/assessment-01.md", "yahoo", 1],
  ["docs/architecture/security/gate-coverage-inventory-1754.md", "alpaca", 1],
  ["docs/architecture/security/gate-coverage-inventory-1754.md", "etrade", 11],
  ["docs/architecture/security/secrets-inventory-and-rotation-policy.md", "alpaca", 6],
  ["docs/architecture/security/secrets-inventory-and-rotation-policy.md", "etrade", 4],
  ["docs/architecture/standards/assessment/assessment-01.md", "etrade", 2],
  ["docs/architecture/survey/1976-data-foundation-survey.md", "etrade", 1],
  ["docs/architecture/survey/1976-step5-sessionstore-audit.md", "etrade", 30],
  ["docs/architecture/survey/1976-step5-sessionstore-audit.md", "public.com", 1],
  ["docs/architecture/survey/2380-survey-draft.md", "alpaca", 1],
  ["docs/architecture/survey/2380-survey-draft.md", "etrade", 6],
  ["docs/architecture/survey/3238-param-survey.md", "etrade", 1],
  // #4791 HISTORICAL: dated survey snapshots naming the brokers surveyed.
  ["docs/architecture/survey/2225-agent-mesh-survey-part1.md", "etrade", 11],
  ["docs/architecture/survey/2225-agent-mesh-survey-part2.md", "etrade", 10],
  ["docs/architecture/survey/2225-agent-mesh-survey-part2.md", "public.com", 1],
  ["docs/architecture/survey/2225-agent-mesh-survey-part2.md", "alpaca", 1],
  ["docs/architecture/survey/2494-agntcy-workstream-survey.md", "etrade", 1],
  ["docs/architecture/survey/2494-agntcy-workstream-survey.md", "public.com", 1],
  ["docs/architecture/survey/2494-think-adoption-trading-survey.md", "etrade", 8],
  ["docs/architecture/survey/2494-think-adoption-trading-survey.md", "public.com", 3],
  ["docs/architecture/survey/ai-search-activation-survey.md", "etrade", 11],
  // #4791 HISTORICAL: the assessment-scope audit names the providers its inventoried items integrate.
  ["docs/architecture/survey/assessment-scope-audit.md", "etrade", 1],
  ["docs/architecture/survey/assessment-scope-audit.md", "public.com", 1],
  ["docs/architecture/survey/native-payments-survey-design.md", "etrade", 1],
  ["docs/architecture/survey/search-hub-survey-design.md", "etrade", 8],
  ["docs/architecture/survey/slice4-label-survey.md", "etrade", 4],
  // #3121 HISTORICAL: dated survey snapshots naming the providers surveyed.
  ["docs/architecture/survey/3122-s0-dedup-report.md", "etrade", 6],
  ["docs/architecture/survey/phase2-survey.md", "etrade", 1],
  ["docs/architecture/survey/phase2-survey.md", "yahoo", 1],
  // #5344 HISTORICAL: dated CBO survey snapshots (parity inventory + audit record, 2026-11-18) naming the broker identifiers surveyed.
  ["docs/architecture/survey/ux-actions.md", "etrade", 24],
  ["docs/architecture/survey/routes.md", "etrade", 3],
  ["docs/architecture/survey/compliance.md", "etrade", 2],
  ["docs/compliance/facts-n-findings-01.md", "alpaca", 2],
  ["docs/compliance/facts-n-findings-01.md", "etrade", 5],
  ["docs/compliance/facts-n-findings-01.md", "public.com", 1],
  ["docs/compliance/facts-n-findings-01.md", "yahoo", 3],
  ["docs/compliance/multiple-implementations.md", "alpaca", 1],
  ["docs/compliance/multiple-implementations.md", "etrade", 1],
  ["docs/compliance/multiple-implementations.md", "yahoo", 1],
  ["docs/compliance/system-duplicates-scan-1717-appendix-b-nlq.md", "etrade", 1],
  ["docs/compliance/system-duplicates-scan-1717-appendix-d-async-jobs.md", "etrade", 2],
  ["docs/compliance/system-duplicates-scan-1717-appendix-e-market-data-quotes.md", "alpaca", 31],
  ["docs/compliance/system-duplicates-scan-1717-appendix-e-market-data-quotes.md", "etrade", 27],
  ["docs/compliance/system-duplicates-scan-1717-appendix-e-market-data-quotes.md", "public.com", 1],
  ["docs/compliance/system-duplicates-scan-1717-appendix-e-market-data-quotes.md", "yahoo", 34],
  ["docs/compliance/system-duplicates-scan-1717-appendix-f-etrade-mcp-rest.md", "etrade", 18],
  ["docs/compliance/system-duplicates-scan-1717-appendix-g-foss-mcp-rest.md", "alpaca", 8],
  ["docs/compliance/system-duplicates-scan-1717-appendix-h-agentic-payments-premium.md", "etrade", 2],
  ["docs/compliance/system-duplicates-scan-1717-appendix-j-discovery-ranking-weights-promotion.md", "etrade", 2],
  ["docs/compliance/system-duplicates-scan-1717-appendix-k-report-generators.md", "etrade", 1],
  ["docs/compliance/system-duplicates-scan-1717-appendix-k-report-generators.md", "yahoo", 2],
  ["docs/compliance/system-duplicates-scan-1717-appendix-l-portfolio-repair.md", "etrade", 7],
  ["docs/compliance/system-duplicates-scan-1717-appendix-m-rest-rest-twins.md", "alpaca", 8],
  ["docs/compliance/system-duplicates-scan-1717-appendix-m-rest-rest-twins.md", "etrade", 6],
  ["docs/compliance/system-duplicates-scan-1717-appendix-n-cloudflare-browser-misc.md", "etrade", 4],
  ["docs/compliance/system-duplicates-scan-1717-appendix-p-docs-architecture.md", "alpaca", 3],
  ["docs/compliance/system-duplicates-scan-1717-appendix-p-docs-architecture.md", "etrade", 10],
  ["docs/compliance/system-duplicates-scan-1717-appendix-p-docs-architecture.md", "yahoo", 1],
  ["docs/compliance/system-duplicates-scan-1717-appendix-q-cloudflare-coupling.md", "etrade", 2],
  ["docs/compliance/system-duplicates-scan-1717.md", "alpaca", 13],
  ["docs/compliance/system-duplicates-scan-1717.md", "etrade", 37],
  ["docs/compliance/system-duplicates-scan-1717.md", "public.com", 1],
  ["docs/compliance/system-duplicates-scan-1717.md", "yahoo", 15],
  ["docs/operations/data/neutrality-census.md", "alpaca", 2],
  ["docs/operations/data/neutrality-census.md", "etrade", 3],
  ["docs/operations/data/neutrality-census.md", "fidelity", 4],
  ["docs/operations/data/neutrality-census.md", "finnhub", 1],
  ["docs/operations/data/neutrality-census.md", "interactive brokers / ibkr", 3],
  ["docs/operations/data/neutrality-census.md", "nasdaq", 3],
  ["docs/operations/data/neutrality-census.md", "polygon", 2],
  ["docs/operations/data/neutrality-census.md", "public.com", 1],
  ["docs/operations/data/neutrality-census.md", "robinhood", 1],
  ["docs/operations/data/neutrality-census.md", "schwab", 3],
  ["docs/operations/data/neutrality-census.md", "tastytrade", 1],
  ["docs/operations/data/neutrality-census.md", "thinkorswim", 1],
  ["docs/operations/data/neutrality-census.md", "tradier", 3],
  ["docs/operations/data/neutrality-census.md", "twelvedata", 1],
  ["docs/operations/data/neutrality-census.md", "webull", 1],
  ["docs/operations/data/neutrality-census.md", "yahoo", 1],
  ["docs/plans/IAAA-945-spec.md", "etrade", 2],
  ["docs/plans/UX/baseline/token-coverage.json", "etrade", 2],
  ["docs/plans/UX/ux-token-architecture-plan.md", "etrade", 2],
  ["docs/plans/architecture-audit-1.md", "alpaca", 3],
  ["docs/plans/architecture-audit-1.md", "etrade", 17],
  ["docs/plans/architecture-audit-1.md", "yahoo", 2],
  ["docs/plans/completion_report_3401.md", "alpaca", 5],
  ["docs/plans/completion_report_3401.md", "etrade", 2],
  ["docs/plans/completion_report_3411.md", "alpaca", 3],
  ["docs/plans/completion_report_3411.md", "etrade", 7],
  ["docs/plans/completion_report_3417.md", "alpaca", 1],
  ["docs/plans/completion_report_3417.md", "etrade", 4],
  ["docs/plans/completion_report_3418.md", "alpaca", 3],
  ["docs/plans/completion_report_3418.md", "etrade", 6],
  ["docs/plans/completion_report_3430.md", "alpaca", 5],
  ["docs/plans/completion_report_3430.md", "etrade", 5],
  ["docs/plans/completion_report_3508.md", "alpaca", 5],
  ["docs/plans/completion_report_3513.md", "alpaca", 1],
  ["docs/plans/completion_report_3519.md", "alpaca", 1],
  ["docs/plans/completion_report_3541.md", "etrade", 1],
  ["docs/plans/completion_report_3557.md", "alpaca", 5],
  ["docs/plans/completion_report_3588.md", "alpaca", 1],
  ["docs/plans/completion_report_3658.md", "alpaca", 4],
  ["docs/plans/completion_report_3668.md", "alpaca", 7],
  ["docs/plans/completion_report_3668.md", "etrade", 4],
  ["docs/plans/completion_report_3673.md", "alpaca", 2],
  ["docs/plans/completion_report_3673.md", "thinkorswim", 1],
  ["docs/plans/dimension-registry.json", "etrade", 3],
  ["docs/plans/dimension-registry.json", "public.com", 1],
  ["docs/plans/epic_stock_copilot_omnichannel_program.md", "alpaca", 5],
  ["docs/plans/epic_stock_copilot_omnichannel_program.md", "etrade", 1],
  ["docs/plans/issue_goal_1_stock_copilot_uniform_ux.md", "alpaca", 10],
  ["docs/plans/multi-dimensional-system-plan-2026-10-22.md", "etrade", 4],
  ["docs/plans/multi-dimensional-system-plan-2026-10-22.md", "public.com", 2],
  ["docs/plans/pr_3668_body.md", "alpaca", 6],
  ["docs/plans/pr_3668_body.md", "etrade", 2],
  ["docs/plans/rsi-ceo-cycle-record-2026-11-05-broker-parity.md", "alpaca", 9],
  ["docs/plans/rsi-ceo-cycle-record-2026-11-05-broker-parity.md", "etrade", 9],
  ["docs/plans/rsi-data-plan-2026-10-20.md", "etrade", 3],
  ["docs/plans/rsi-infosec-plan-2026-10-20.md", "etrade", 1],
  ["docs/plans/rsi-tech-plan-2026-10-20.md", "etrade", 1],
  ["docs/plans/rsi-tech-plan-2026-10-20.md", "yahoo", 1],
  ["docs/plans/pr_3719_body.md", "alpaca", 3],
  ["docs/plans/pr_3719_body.md", "etrade", 6],
  // #6076 HISTORICAL: dated CFO-lane survey snapshots naming the
  // providers surveyed — tables rationalization (#6056), run-logging
  // research (#6005), J-stack fit/gap master + stock + options
  // inventories (#3550), broker/provider-neutrality inventory
  // (#3460), options-screening + report-scope inventories (#2528),
  // and the stock-screen gap->issue map. Verbatim copies;
  // neutralizing the names would falsify the dated record.
  ["docs/architecture/survey/2528-options-report-scope-inventory-survey.md", "etrade", 1],
  ["docs/architecture/survey/2528-options-report-scope-inventory-survey.md", "yahoo", 1],
  ["docs/architecture/survey/2528-options-screening-inventory-survey.md", "etrade", 7],
  ["docs/architecture/survey/2528-options-screening-inventory-survey.md", "yahoo", 1],
  ["docs/architecture/survey/3460-broker-provider-neutrality-inventory-survey.md", "etrade", 67],
  ["docs/architecture/survey/3460-broker-provider-neutrality-inventory-survey.md", "alpaca", 10],
  ["docs/architecture/survey/3460-broker-provider-neutrality-inventory-survey.md", "nasdaq", 1],
  ["docs/architecture/survey/3550-jstack-fit-gap-inventory-survey.md", "etrade", 21],
  ["docs/architecture/survey/3550-jstack-fit-gap-inventory-survey.md", "alpaca", 10],
  ["docs/architecture/survey/3550-jstack-fit-gap-inventory-survey.md", "yahoo", 7],
  ["docs/architecture/survey/3550-jstack-fit-gap-inventory-survey.md", "nasdaq", 1],
  ["docs/architecture/survey/3550-options-screener-jstack-inventory-survey.md", "etrade", 11],
  ["docs/architecture/survey/3550-options-screener-jstack-inventory-survey.md", "alpaca", 4],
  ["docs/architecture/survey/3550-options-screener-jstack-inventory-survey.md", "yahoo", 1],
  ["docs/architecture/survey/3550-options-screener-jstack-inventory-survey.md", "nasdaq", 1],
  ["docs/architecture/survey/3550-stock-screener-jstack-inventory-survey.md", "etrade", 4],
  ["docs/architecture/survey/3550-stock-screener-jstack-inventory-survey.md", "alpaca", 1],
  ["docs/architecture/survey/3550-stock-screener-jstack-inventory-survey.md", "yahoo", 8],
  ["docs/architecture/survey/3550-stock-screener-jstack-inventory-survey.md", "nasdaq", 1],
  ["docs/architecture/survey/stock-screen-gap-issue-map-2026-11-13-survey.md", "etrade", 24],
  ["docs/architecture/survey/stock-screen-gap-issue-map-2026-11-13-survey.md", "alpaca", 4],
  ["docs/architecture/survey/stock-screen-gap-issue-map-2026-11-13-survey.md", "yahoo", 18],
  ["docs/architecture/survey/stock-screen-gap-issue-map-2026-11-13-survey.md", "nasdaq", 2],
  // #6528 HISTORICAL: the Phase 1 Config census lands six universal-
  // context survey snapshots plus the census seed record under
  // docs/architecture/survey/. The surveys name the providers they
  // surveyed (resolver/context identifiers, the Nasdaq index, the
  // Interactive Brokers name); neutralizing the names would falsify
  // the evidence record, so all rows are dispositioned HISTORICAL.
  ["docs/architecture/survey/6528-census-seed.md", "etrade", 4],
  ["docs/architecture/survey/context-survey-rca-plan.md", "etrade", 19],
  ["docs/architecture/survey/context-survey-rca-plan.md", "alpaca", 3],
  ["docs/architecture/survey/context-survey-rca-plan.md", "nasdaq", 1],
  ["docs/architecture/survey/copies-and-overlaps.md", "etrade", 8],
  ["docs/architecture/survey/domain-attribution.md", "etrade", 2],
  ["docs/architecture/survey/domain-attribution.md", "alpaca", 2],
  ["docs/architecture/survey/domain-attribution.md", "tastytrade", 2],
  ["docs/architecture/survey/domain-attribution.md", "yahoo", 2],
  ["docs/architecture/survey/per-domain-end-state.md", "etrade", 6],
  ["docs/architecture/survey/per-domain-end-state.md", "yahoo", 1],
  ["docs/architecture/survey/resolvers-and-issues-survey.md", "etrade", 23],
  ["docs/architecture/survey/resolvers-and-issues-survey.md", "alpaca", 2],
  ["docs/architecture/survey/resolvers-and-issues-survey.md", "interactive brokers / ibkr", 1],
  ["docs/architecture/survey/resolvers-and-issues-survey.md", "tastytrade", 3],
  ["docs/architecture/survey/target-state-counts.md", "etrade", 20],
  ["docs/architecture/survey/target-state-counts.md", "tastytrade", 1],
  ["docs/architecture/survey/target-state-counts.md", "yahoo", 1],
  // ---- NOT-PROVIDER (74 rows / 298 lines) ----
  ["docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md", "nasdaq", 4],
  ["docs/CLOUDFLARE_SCHEDULING_AND_ETAPI_TUNING.md", "nasdaq", 1],
  ["docs/EXTERNAL_APIS_AND_ENDPOINTS_DIRECTORY.md", "nasdaq", 6],
  ["docs/SYSTEM_CONFIG_TIERS_AND_MODELS.md", "nasdaq", 1],
  ["docs/architecture/adr/0008-market-data-circuit-breakers.md", "nasdaq", 2],
  ["docs/architecture/application/screener.md", "nasdaq", 6],
  ["docs/architecture/blueprint/abok-target-blueprint.md", "nasdaq", 4],
  ["docs/architecture/business/platform-capabilities.md", "nasdaq", 4],
  ["docs/architecture/business/screener-workflow.md", "nasdaq", 5],
  ["docs/architecture/code/component-taxonomy-01.md", "nasdaq", 2],
  ["docs/architecture/code/screener-01.md", "nasdaq", 1],
  ["docs/architecture/enterprise/assessment/comprehensive-enterprise-strategy-and-capabilities-assessment.md", "nasdaq", 4],
  ["docs/architecture/enterprise/assessment/platform-decoupling-and-native-roadmap.md", "nasdaq", 1],
  ["docs/architecture/enterprise/assessment/screener.md", "nasdaq", 11],
  ["docs/architecture/enterprise/iros-system-analysis.md", "nasdaq", 3],
  ["docs/architecture/infrastructure/infrastructure.md", "nasdaq", 1],
  ["docs/architecture/security/screener-chain-stuck-repair-3787.md", "nasdaq", 1],
  ["docs/business/valueprop/goal-screener-01.md", "nasdaq", 1],
  ["docs/collaboration.md", "nasdaq", 1],
  ["docs/compliance/facts-n-findings-01.md", "nasdaq", 1],
  ["docs/compliance/system-duplicates-scan-1717-appendix-e-market-data-quotes.md", "nasdaq", 3],
  ["docs/compliance/system-duplicates-scan-1717-appendix-f-etrade-mcp-rest.md", "nasdaq", 1],
  ["src/agentic/chainExecutor.ts", "nasdaq", 2],
  ["src/agents/nlq/execution.ts", "nasdaq", 1],
  ["src/agents/nlq/planning.ts", "nasdaq", 2],
  ["src/agents/nlqOptionsStrategy.ts", "nasdaq", 2],
  ["src/agents/routes/dataProviders.ts", "nasdaq", 2],
  ["src/agents/routes/etradeBroker.ts", "nasdaq", 1],
  ["src/agents/routes/optionsProviderGate.ts", "nasdaq", 1],
  ["src/agents/routes/premium.ts", "nasdaq", 1],
  ["src/agents/screener-agent.ts", "nasdaq", 12],
  ["src/agents/trading-agent.ts", "nasdaq", 1],
  ["src/aspects/errorCodes.ts", "nasdaq", 1],
  ["src/breakers/breakerPorts.ts", "nasdaq", 1],
  ["src/breakers/createBreakerPorts.ts", "nasdaq", 1],
  ["src/client/TradeHub.tsx", "nasdaq", 1],
  ["src/client/StockHub.tsx", "nasdaq", 2],
  ["src/client/components/AskAgentWidget.tsx", "nasdaq", 1],
  ["src/client/components/AutopilotControlCenter.tsx", "nasdaq", 1],
  ["src/client/marketClock.ts", "nasdaq", 2],
  ["src/client/options/ScheduledOptionsRunForm.tsx", "nasdaq", 1],
  ["src/client/options/StrategyDiscoveryPanel.tsx", "nasdaq", 1],
  ["src/client/quotes/symbolSets.ts", "nasdaq", 1],
  ["src/client/scheduledOptionsManager/ScheduleFormModal.tsx", "nasdaq", 1],
  ["src/client/workflowsFaqData.ts", "nasdaq", 7],
  ["src/config/curatedStockUniverse.json", "nasdaq", 61],
  ["src/config/curatedStockUniverse.ts", "nasdaq", 2],
  ["src/data/enrichedDatasetPorts.ts", "nasdaq", 1],
  ["src/data/providerConfigPorts.ts", "nasdaq", 3],
  ["src/mcps/openaimp/etradeCommands.ts", "nasdaq", 4],
  ["src/mcps/openaimp/meshDoorCommands.ts", "nasdaq", 2],
  ["src/mcps/scanner/cloudflareWalletsScanner.ts", "nasdaq", 1],
  ["src/orchestrate.ts", "nasdaq", 1],
  ["src/services/etrade.ts", "nasdaq", 1],
  ["src/services/marketDataResearch.ts", "nasdaq", 2],
  ["src/services/optionsProviderContext.ts", "nasdaq", 2],
  ["src/services/platformKnowledge.ts", "nasdaq", 18],
  ["src/services/quoteCache.ts", "nasdaq", 3],
  ["src/services/researchProviders.ts", "nasdaq", 1],
  ["src/services/scheduledTasks.ts", "nasdaq", 5],
  ["src/services/shardExecutors.ts", "nasdaq", 15],
  ["src/services/shardJobs.ts", "nasdaq", 10],
  ["src/trading/etrade/platform.ts", "nasdaq", 1],
  ["src/trading/etrade/quoteTrace.ts", "nasdaq", 2],
  ["src/trading/indexMembership.ts", "nasdaq", 7],
  ["src/trading/liveScreener.ts", "nasdaq", 1],
  ["src/trading/options/flows/flowService.ts", "nasdaq", 2],
  ["src/trading/platformHistory.ts", "nasdaq", 1],
  ["src/trading/screenerPipeline.ts", "nasdaq", 33],
  ["src/trading/screenerReportXlsx.ts", "nasdaq", 3],
  ["src/trading/screeningProvider.ts", "nasdaq", 1],
  ["src/trading/screeningSchemas.ts", "nasdaq", 2],
  ["src/trading/universes.ts", "nasdaq", 3],
  ["src/types.ts", "nasdaq", 1],
  // ---- FALSE-POSITIVE (28 rows / 32 lines) ----
  ["docs/architecture/adr/data/0002-data-foundation-layer.md", "fidelity", 1],
  ["docs/architecture/adr/0005-actor-port.md", "fidelity", 1],
  ["docs/architecture/adr/data/0022-data-foundation.md", "fidelity", 1],
  ["docs/architecture/agentic/think-or-DO.md", "fidelity", 3],
  ["docs/architecture/code/component-taxonomy-01.md", "fidelity", 1],
  ["docs/architecture/technical/cloudflare-01.md", "fidelity", 1],
  ["src/actors/actorTurnRunner.ts", "fidelity", 1],
  ["src/agents/browserAgent.ts", "fidelity", 1],
  ["src/agents/registry.ts", "fidelity", 1],
  ["src/client/components/NavigationMenu.tsx", "polygon", 2],
  ["src/client/components/UniversalChart.tsx", "polygon", 1],
  ["src/client/landing.ts", "polygon", 1],
  ["src/client/options/riskManagementEngine.ts", "etrade", 2],
  ["src/client/options/strategyDiscovery.deprecated.css", "fidelity", 1],
  ["src/client/tokens.css", "fidelity", 1],
  ["src/client/trading/strategyAutobuild.ts", "etrade", 1],
  ["src/config/curatedStockUniverse.json", "robinhood", 1],
  ["src/config/curatedStockUniverse.json", "schwab", 1],
  ["src/config/etapiConfig.ts", "robinhood", 1],
  ["src/config/etapiConfig.ts", "schwab", 1],
  ["src/data/inMemoryDiscoveryAlertAdapter.ts", "fidelity", 1],
  ["src/data/providerCapturePorts.ts", "fidelity", 1],
  ["src/data/strategyPolicyPorts.ts", "fidelity", 1],
  ["src/mcps/openaimp/commands.ts", "fidelity", 1],
  ["src/security/githubOAuth.ts", "polygon", 1],
  ["src/services/browserAgent.ts", "fidelity", 1],
  ["src/services/meshGoldenTasks.ts", "fidelity", 1],
  ["src/services/strategyPolicyState.ts", "fidelity", 1],
  // #3883 INTEGRATION: the cancellation surface names the provider it
  // executes against — the tool contract itself is provider-scoped, the
  // adapter class and its status words are provider facts, and the port
  // keeps the brand in exactly one field (the ledger's broker stamp).
  ["src/trading/cancelFilters.ts", "alpaca", 7],
  ["src/services/orderCancellation.ts", "alpaca", 2],
  ["src/mcps/openaimp/cancelOrderCommands.ts", "alpaca", 9],
  // #4670 INTEGRATION: `resolveTradeEnvironmentFromSettings` is the shared
  // environment resolver the order tools all call; its name carries the brand as
  // an identifier, so the row is baselined rather than the helper rewritten.
  ["src/mcps/openaimp/cancelOrderCommands.ts", "etrade", 2],
  ["src/client/CancelAllControl.tsx", "alpaca", 8],
  // #3866 INTEGRATION: the lifecycle table names the brokers it covers.
  ["docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md", "etrade", 1],
  ["docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md", "public.com", 1],
  ["docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md", "alpaca", 1],
  ["docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md", "yahoo", 1],
  ["docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md", "nasdaq", 1],
  // #3892 INTEGRATION: the registry names the providers whose support it
  // declares (native/emulated/none is a per-provider fact), and its
  // trailing-stop notes quote the provider's field names.
  ["src/trading/advancedOrders.ts", "alpaca", 29],
  // #3892 INTEGRATION: the introspection payload is per provider, so the
  // tool names the providers it enumerates.
  ["src/mcps/openaimp/tradingLimitCommands.ts", "alpaca", 1],
  // #3892 INTEGRATION: the registry declares per-broker support, so the
  // E*TRADE rows are the `none`/`emulated` facts a caller is refused by name.
  ["src/trading/advancedOrders.ts", "etrade", 29],
  // #3892 INTEGRATION: the introspection payload names the provider it
  // enumerates, alongside the other broker's.
  ["src/mcps/openaimp/tradingLimitCommands.ts", "etrade", 1],
  // #3990 INTEGRATION: Public.com joins as a live broker and the
  // data-provider/broker taxonomy splits — the provider's own
  // adapters, command modules, registry entries, trading client,
  // platform, outcome code and token card name the provider they
  // serve, which is their job; the copilot commands name their
  // Alpaca/E*TRADE mirrors in their header (the #3782 precedent).
  ["src/client/BrokerDynamicMenu.tsx", "nasdaq", 1],
  ["src/client/PublicTokenCard.tsx", "public.com", 15],
  ["src/client/PublicTokenCard.tsx", "alpaca", 1],
  ["src/data/commercialPorts.ts", "yahoo", 2],
  ["src/mcps/openaimp/commands.ts", "public.com", 2],
  ["src/mcps/openaimp/publicCommands.ts", "etrade", 3],
  ["src/mcps/openaimp/publicCommands.ts", "public.com", 12],
  ["src/mcps/openaimp/publicCommands.ts", "alpaca", 4],
  ["src/mcps/public/publicTradingMcp.ts", "public.com", 1],
  ["src/outcomes/outcomeCatalog.json", "public.com", 1],
  // #4650 (INTEGRATION growth, the provider's own mapping module): the cancel
  // receipt mapper adds the broker's own name to its cancel messages
  // (`publicCancelReceipt`: cancelled / did-not-cancel / unconfirmed), and the
  // widened no-paper-mode catalog copy is measured in the outcome row above.
  // Raised from 4 by #4650 (PR #4765) — the same provider-subject surface the
  // row already accounted for, not a new PLATFORM framing.
  ["src/services/publicTrading.ts", "public.com", 9],
  ["src/trading/brokerCatalog.ts", "public.com", 4],
  ["src/trading/brokerPresentation.ts", "public.com", 4],
  // Issue #4656: the TIF refusal names the broker in its user-facing message
  // (PUBLIC_TIME_IN_FORCE_UNVERIFIED), the same INTEGRATION growth the #3990
  // rows above already account for.
  ["src/trading/public/platform.ts", "public.com", 19],
  ["src/trading/public/platform.ts", "alpaca", 2],
  ["src/trading/screenerPipeline.ts", "public.com", 3],
  ["docs/architecture/agentic/mcp-server-inventory.md", "public.com", 2],
  // #3990 follow-up in the same PR (mesh family + OASF map + audit
  // doc): the new public-mcp-commands registry family names its
  // Alpaca mirror and the Public tools it accounts for (INTEGRATION —
  // the registry names the providers its families cover; the OASF map
  // names the family it maps), and ADR 0028 + its index row name the
  // providers the decision is about (HISTORICAL — dated decision
  // records, 0028 etrade 10 / public.com 7 / alpaca 24 / yahoo 11 /
  // nasdaq 4, index public.com 1 / alpaca 1->2).
  ["docs/architecture/adr/data/0028-data-provider-broker-taxonomy.md", "etrade", 10],
  ["docs/architecture/adr/data/0028-data-provider-broker-taxonomy.md", "public.com", 7],
  ["docs/architecture/adr/data/0028-data-provider-broker-taxonomy.md", "alpaca", 24],
  ["docs/architecture/adr/data/0028-data-provider-broker-taxonomy.md", "yahoo", 11],
  ["docs/architecture/adr/data/0028-data-provider-broker-taxonomy.md", "nasdaq", 4],
  ["docs/architecture/adr/README.md", "public.com", 1],
  ["src/agents/registry.ts", "alpaca", 1],
  ["src/services/oasfRecords.ts", "public.com", 1],
  // #4178 INTEGRATION: the capability registry gains per-provider
  // entries and the unit-driver table binds them — the registry
  // and the driver table name the providers they integrate, which
  // is their job (the provider-id registries' seed precedent).
  // The ids, capability strings, and adapter factory names are
  // data-bearing identifiers; neutralizing them would falsify the
  // inventory. 9 new rows, +21 lines (measured 1166/9151 ->
  // 1175/9172).
  ["src/agentic/capabilityRegistry.ts", "etrade", 5],
  ["src/agentic/capabilityRegistry.ts", "public.com", 1],
  ["src/agentic/capabilityRegistry.ts", "alpaca", 3],
  ["src/agentic/capabilityRegistry.ts", "yahoo", 3],
  ["src/agentic/capabilityRegistry.ts", "nasdaq", 3],
  ["src/agentic/unitDrivers.ts", "etrade", 3],
  ["src/agentic/unitDrivers.ts", "alpaca", 1],
  ["src/agentic/unitDrivers.ts", "yahoo", 1],
  ["src/agentic/unitDrivers.ts", "nasdaq", 1],
  // #4282 P1 INTEGRATION: the D1 catalogue carries the 3 moved
  // DEFAULT 'etrade' lines (v19 agent_tenant_settings
  // data_provider_id + broker_id, v45 agent_iv_history broker).
  // They are data-bearing migration defaults, reproduced
  // byte-identically from the runner; neutralizing them would
  // falsify the migrations.
  ["src/data/schemaComponent/d1Catalogue.ts", "etrade", 3],
  // #4441 HISTORICAL/INTEGRATION: the measured autopilot-capabilities
  // inventory names the broker integrations it measured (E*TRADE,
  // Alpaca). Naming the providers IS the document's subject — the rows
  // are accounted, not platform framing, and stay shrink-only like every
  // other row. Added by #4476 (the #4441 PR shipped without them, which
  // left test:pins red on main).
  ["docs/architecture/agentic/autopilot-capabilities.md", "etrade", 5],
  ["docs/architecture/agentic/autopilot-capabilities.md", "alpaca", 1],
  // #4282 P2b INTEGRATION: the DO catalogue carries the 1 moved
  // DEFAULT 'etrade' line (mas_iv_history broker). It is a
  // data-bearing schema default, reproduced byte-identically
  // from the IvHistory adapter; neutralizing it would falsify
  // the schema.
  ["src/data/schemaComponent/doCatalogue.ts", "etrade", 1],
  // #4282 P3 INTEGRATION: the remainder catalogue carries the 1
  // moved DEFAULT 'etrade' line (mas_iv_history broker ALTER).
  // Same disposition as the DO catalogue row above: a data-bearing
  // schema default, reproduced byte-identically from the IvHistory
  // adapter; neutralizing it would falsify the schema.
  ["src/data/schemaComponent/remainderCatalogue.ts", "etrade", 1],
  ["src/client/ledgerTable.ts", "etrade", 1],
  // #4634 INTEGRATION: the brokerage & data matrix names the brokers and
  // data providers it compares by definition; the table is the artefact,
  // not platform framing (same disposition as the broker-parity-matrix
  // rows, #4038/#4039). Measured 2026-11-15 on the placed file.
  ["docs/architecture/business/brokerage-data-matrix.md", "etrade", 81],
  ["docs/architecture/business/brokerage-data-matrix.md", "public.com", 14],
  ["docs/architecture/business/brokerage-data-matrix.md", "alpaca", 59],
  ["docs/architecture/business/brokerage-data-matrix.md", "schwab", 3],
  ["docs/architecture/business/brokerage-data-matrix.md", "fidelity", 2],
  ["docs/architecture/business/brokerage-data-matrix.md", "robinhood", 1],
  ["docs/architecture/business/brokerage-data-matrix.md", "webull", 1],
  ["docs/architecture/business/brokerage-data-matrix.md", "thinkorswim", 1],
  ["docs/architecture/business/brokerage-data-matrix.md", "interactive brokers / ibkr", 15],
  ["docs/architecture/business/brokerage-data-matrix.md", "tradier", 2],
  ["docs/architecture/business/brokerage-data-matrix.md", "tastytrade", 12],
  ["docs/architecture/business/brokerage-data-matrix.md", "yahoo", 9],
  ["docs/architecture/business/brokerage-data-matrix.md", "nasdaq", 7],
  ["docs/architecture/business/brokerage-data-matrix.md", "polygon", 2],
  ["docs/architecture/business/brokerage-data-matrix.md", "finnhub", 6],
  ["docs/architecture/business/brokerage-data-matrix.md", "twelvedata", 2],
  // #4802 (post-merge red on #4797): the 30 consolidated survey
  // documents name the providers they survey. They are dated
  // HISTORICAL records — neutralizing the names would falsify
  // the record. Same disposition as the brokerage-data-matrix
  // rows (#4634): the providers are the documents' subject, not
  // platform framing. Counts measured on the placed files.
  ["docs/architecture/survey/1116-alpaca-provider-survey.md", "etrade", 8],
  ["docs/architecture/survey/1116-alpaca-provider-survey.md", "alpaca", 35],
  ["docs/architecture/survey/1116-alpaca-provider-survey.md", "yahoo", 12],
  ["docs/architecture/survey/1116-alpaca-provider-survey.md", "nasdaq", 11],
  ["docs/architecture/survey/1116-data-provider-storage-survey.md", "etrade", 5],
  ["docs/architecture/survey/1116-data-provider-storage-survey.md", "alpaca", 2],
  ["docs/architecture/survey/1116-data-provider-storage-survey.md", "yahoo", 4],
  ["docs/architecture/survey/1116-e2-screening-cutover-survey.md", "etrade", 29],
  ["docs/architecture/survey/1116-e2-screening-cutover-survey.md", "alpaca", 1],
  ["docs/architecture/survey/1116-e2-screening-cutover-survey.md", "yahoo", 10],
  ["docs/architecture/survey/1116-e2-screening-cutover-survey.md", "nasdaq", 6],
  ["docs/architecture/survey/1116-e3-provisioning-lifecycle-survey.md", "etrade", 2],
  ["docs/architecture/survey/1169-r2-agent-search-survey.md", "etrade", 8],
  ["docs/architecture/survey/1169-s4-remainder-survey.md", "etrade", 2],
  ["docs/architecture/survey/1356-stock-screener-etrade-quote-cutover-survey.md", "etrade", 83],
  ["docs/architecture/survey/1356-stock-screener-etrade-quote-cutover-survey.md", "yahoo", 33],
  ["docs/architecture/survey/1356-stock-screener-etrade-quote-cutover-survey.md", "nasdaq", 11],
  ["docs/architecture/survey/1378-nasdaq-residuals-survey.md", "etrade", 8],
  ["docs/architecture/survey/1378-nasdaq-residuals-survey.md", "yahoo", 1],
  ["docs/architecture/survey/1378-nasdaq-residuals-survey.md", "nasdaq", 2],
  ["docs/architecture/survey/1661-storage-handle-survey.md", "etrade", 3],
  ["docs/architecture/survey/1661-storage-handle-survey.md", "nasdaq", 1],
  ["docs/architecture/survey/1686-nlq-mcp-storage-plumbing-survey.md", "etrade", 31],
  ["docs/architecture/survey/1686-nlq-mcp-storage-plumbing-survey.md", "yahoo", 1],
  ["docs/architecture/survey/2223-a2a-agent-reachability-survey.md", "etrade", 4],
  ["docs/architecture/survey/2225-agent-mesh-survey.md", "etrade", 21],
  ["docs/architecture/survey/2225-agent-mesh-survey.md", "public.com", 1],
  ["docs/architecture/survey/2225-agent-mesh-survey.md", "alpaca", 1],
  ["docs/architecture/survey/3527-publish-stage-survey.md", "etrade", 2],
  ["docs/architecture/survey/3530-remainders-survey.md", "etrade", 3],
  ["docs/architecture/survey/3530-remainders-survey.md", "alpaca", 3],
  ["docs/architecture/survey/3530-remainders-survey.md", "yahoo", 4],
  ["docs/architecture/survey/3530-remainders-survey.md", "nasdaq", 2],
  ["docs/architecture/survey/3667-universe-integration-survey.md", "etrade", 1],
  ["docs/architecture/survey/3667-universe-integration-survey.md", "alpaca", 1],
  ["docs/architecture/survey/3667-universe-integration-survey.md", "yahoo", 3],
  ["docs/architecture/survey/3751-provider-identity-survey.md", "etrade", 46],
  ["docs/architecture/survey/3751-provider-identity-survey.md", "public.com", 5],
  ["docs/architecture/survey/3751-provider-identity-survey.md", "alpaca", 27],
  ["docs/architecture/survey/3751-provider-identity-survey.md", "yahoo", 10],
  ["docs/architecture/survey/3751-provider-identity-survey.md", "nasdaq", 9],
  ["docs/architecture/survey/3786-code-standards-survey-2.md", "etrade", 5],
  ["docs/architecture/survey/4306-feed-job-schedules-monthly-survey.md", "etrade", 2],
  ["docs/architecture/survey/4306-feed-job-schedules-monthly-survey.md", "alpaca", 2],
  ["docs/architecture/survey/4306-feed-job-schedules-monthly-survey.md", "yahoo", 20],
  ["docs/architecture/survey/4306-feed-job-schedules-monthly-survey.md", "nasdaq", 8],
  ["docs/architecture/survey/4766-4767-pipeline-run-fidelity-survey.md", "fidelity", 3],
  ["docs/architecture/survey/4766-4767-pipeline-run-fidelity-survey.md", "yahoo", 4],
  ["docs/architecture/survey/4770-dispatch-modes-research-notes-addendum.md", "etrade", 1],
  ["docs/architecture/survey/4770-dispatch-modes-research-notes.md", "etrade", 1],
  ["docs/architecture/survey/4770-dispatch-modes-research-notes.md", "yahoo", 2],
  ["docs/architecture/survey/958-screening-consolidation-survey.md", "etrade", 21],
  ["docs/architecture/survey/958-screening-consolidation-survey.md", "yahoo", 3],
  ["docs/architecture/survey/958-screening-consolidation-survey.md", "nasdaq", 1],
  ["docs/architecture/survey/982-screening-s2-verify-first-survey.md", "etrade", 6],
  // Stop-the-line CI baseline for consolidated survey + dispatch-modes docs on main
  ["docs/architecture/survey/2012-2405-dedup-audit-survey.md", "etrade", 1],
  ["docs/architecture/survey/2373-single-payment-path-design-note.md", "etrade", 8],
  ["docs/architecture/survey/2373-single-payment-path-design-note.md", "yahoo", 1],
  ["docs/architecture/survey/2373-single-payment-path-design-note.md", "nasdaq", 1],
  ["docs/architecture/survey/3551-options-onboarding-survey.md", "etrade", 21],
  ["docs/architecture/survey/3551-options-onboarding-survey.md", "alpaca", 3],
  ["docs/architecture/survey/3551-options-onboarding-survey.md", "yahoo", 3],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey-correction.md", "public.com", 2],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey-correction.md", "alpaca", 2],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey-correction.md", "yahoo", 1],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey.md", "etrade", 16],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey.md", "public.com", 5],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey.md", "alpaca", 24],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey.md", "yahoo", 19],
  ["docs/architecture/survey/3990-data-provider-taxonomy-survey.md", "nasdaq", 3],
  // #4813 (post-merge red on #4809): the #4770 operations guide
  // names the providers that serve each feed/door. It is a dated
  // HISTORICAL record of the system as surveyed (2026-11-16) —
  // naming the serving source is the document's job, as in #4802.
  // Neutralizing the names would make the guide unusable.
  ["docs/operations/jobs-workflow-pipelines-stages-dispatch-modes.md", "etrade", 2],
  ["docs/operations/jobs-workflow-pipelines-stages-dispatch-modes.md", "alpaca", 1],
  ["docs/operations/jobs-workflow-pipelines-stages-dispatch-modes.md", "yahoo", 2],
  ["docs/operations/jobs-workflow-pipelines-stages-dispatch-modes.md", "nasdaq", 1],
  // #5024 (post-merge red on the first CI run): the data-model
  // document names the three broker providers its model maps
  // (Alpaca/E*TRADE/Public) — in the trading subject area, in the
  // broker-route paths, and in the quoted durableKv namespace
  // list. Dispositioned INTEGRATION: naming the provider is the
  // document's job, as in #4802/#4813 — neutralizing the names
  // would make the model document unusable (the route paths and
  // the namespace list are data-bearing identifiers, quoted
  // verbatim). Totals move 1305/10512 -> 1308/10519.
  ["docs/architecture/data/data-model.md", "etrade", 4],
  ["docs/architecture/data/data-model.md", "public.com", 1],
  ["docs/architecture/data/data-model.md", "alpaca", 2],
  // #5131 INTEGRATION (two new modules, 7 matching lines): the channel-broker
  // setting and its one resolver. The config file's literal IS the setting's
  // value (the legacy fallback broker a deployment may change), and the
  // resolver quotes the #4999 expression it replaces plus the two fallback
  // cases it keeps apart. Neither names a broker as copy; both are the
  // provenance a reader needs to see why the historical default was kept.
  // The same PR shrinks slack/agent.ts 81->80, voice/agent.ts 31->17,
  // nlq/execution.ts 82->78 and the matrix (etrade 82->81, alpaca 63->59) by
  // routing the channel labels through brokerPresentation.
  ["src/config/channelBrokers.ts", "etrade", 2],
  ["src/trading/channelBroker.ts", "etrade", 3],
  // #5178 (S-U7 ledger): the styles.css ledger entry names its heaviest
  // consumer file verbatim — TradeHub.tsx. The filename is the
  // provenance a reader needs to trace the 456 live selectors; neutralizing
  // it would make the consumer list unusable. Dispositioned INTEGRATION, as
  // in #4802/#4813/#5024. (The broker-naming sweep #5236 renames the panel
  // to TradeHub, which shrinks this row to 0 in its own slice.)
  // #5236: +3 for the ETradeDynamicMenu.deprecated.tsx ledger entry.
  ["docs/architecture/transition/deprecations.md", "etrade", 4],
  // #5404 INTEGRATION (tech-stack inventory, 5 rows / 5 matching lines):
  // docs/technology/tech-stack.md names the providers its data-provider
  // adapters integrate (E*TRADE live, Alpaca live, Yahoo delayed, Nasdaq
  // universe-only, Public.com) — provenance naming of the serving
  // integration, as in #3761 (MCP server inventory) and #4802/#4813.
  // Naming the provider is the adapters' job; neutralizing the row would
  // remove the inventory the tech-stack doc exists to record. Totals move
  // 1335/10877 -> 1340/10882.
  // #5520 INTEGRATION (FOSS enablement extension): the appended table
  // names the providers/brokers its rows survey — the inventory the
  // extension exists to record, as in #5404. Counts re-measured on
  // the composed file: etrade 1->3, alpaca 1->2, yahoo 1->2,
  // nasdaq 1->2, public.com unchanged, schwab + ibkr new.
  ["docs/technology/tech-stack.md", "etrade", 3],
  ["docs/technology/tech-stack.md", "public.com", 1],
  ["docs/technology/tech-stack.md", "alpaca", 2],
  ["docs/technology/tech-stack.md", "yahoo", 2],
  ["docs/technology/tech-stack.md", "nasdaq", 2],
  ["docs/technology/tech-stack.md", "schwab", 1],
  ["docs/technology/tech-stack.md", "interactive brokers / ibkr", 3],
  // Baseline (#5765, 2026-11-19) — INTEGRATION, not PLATFORM framing: one code
  // row in the neutral cancel service. The branch routes that provider through
  // its own cancellation engine (bracket/OCO family and leg semantics, which a
  // filled order refuses); sending it down the generic adapter instead would
  // change cancel behaviour, so the row is baselined rather than neutralised.
  // Appended at the END so the platform slice (first 188 rows) is untouched.
  ["src/services/brokerOrderCancel.ts", "alpaca", 1],
  // Baseline (#5766, 2026-11-19) — INTEGRATION, and a substring hit rather
  // than a brand use: the neutral replace tool resolves the trade
  // environment through the exported helper whose identifier contains the
  // provider token. Renaming that shared helper would touch every broker
  // route for a census spelling, so the row is baselined instead.
  ["src/mcps/openaimp/brokerOrderCommands.ts", "etrade", 2],
  // #5515 INTEGRATION: docs/architecture/reference/vocabulary.md is the
  // registry's own reference — it names the axis values (provider ids and
  // their labels) because that IS its subject; neutralizing them would make
  // the page unusable. The values live in config/vocabulary.json, which the
  // census does not scan; only the prose table is covered here.
  ["docs/architecture/reference/vocabulary.md", "etrade", 2],
  ["docs/architecture/reference/vocabulary.md", "alpaca", 3],
  ["docs/architecture/reference/vocabulary.md", "yahoo", 1],
  ["docs/architecture/reference/vocabulary.md", "nasdaq", 3],
  ["docs/architecture/reference/vocabulary.md", "tastytrade", 1],
  // #5516 INTEGRATION: the stock screen's data-mode labels name the provider
  // that serves the delayed-quote mode — every surface prints these strings
  // verbatim, so naming it is the label's subject, not incidental prose. The
  // strings moved here from the workflow planner to break a module cycle; no
  // new mention was written.
  ["src/config/yahooDataMode.ts", "yahoo", 3],
  // #6160 INTEGRATION, and a substring hit rather than a brand use: the
  // run-ledger kind rule classifies the orchestrator's own token-renewal
  // callback by its existing operation name, whose identifier contains the
  // provider token. Renaming the callback would touch the dispatch seam,
  // the recording wrapper, and every schedule that names it, for a census
  // spelling — so the row is baselined instead. No new brand mention was
  // written: the token was already in the callback's name before this slice.
  // Appended at the END so the platform slice (first 188 rows) is untouched.
  ["src/config/runLedgerModes.ts", "etrade", 1],
  // #6423 INTEGRATION: the data-layer docs move adds six documents
  // under docs/architecture/data/ that name the providers they survey
  // (E*TRADE, Yahoo, Alpaca, Nasdaq) by definition — the surveys and
  // research are about those providers, so naming them is the
  // documents' job, as the data-model.md rows (#4802/#4813).
  // Neutralizing the names would make the surveys unusable.
  // Appended at the END so the platform slice (first 188 rows) is
  // untouched. table-domains.md and data-studio-scope.md carry no
  // provider-brand row. Counts measured with the census patterns.
  ["docs/architecture/data/adr-0035-verification.md", "etrade", 2],
  ["docs/architecture/data/adr-0035-verification.md", "alpaca", 2],
  ["docs/architecture/data/adr-0035-verification.md", "tastytrade", 1],
  ["docs/architecture/data/ciso-review.md", "etrade", 5],
  ["docs/architecture/data/ciso-review.md", "alpaca", 2],
  ["docs/architecture/data/ciso-review.md", "yahoo", 2],
  ["docs/architecture/data/ciso-review.md", "nasdaq", 3],
  ["docs/architecture/data/data-provider-platform-survey.md", "etrade", 5],
  ["docs/architecture/data/data-provider-platform-survey.md", "alpaca", 2],
  ["docs/architecture/data/data-provider-platform-survey.md", "yahoo", 4],
  ["docs/architecture/data/identity-json-research.md", "etrade", 1],
  ["docs/architecture/data/identity-json-research.md", "alpaca", 1],
  ["docs/architecture/data/identity-json-research.md", "yahoo", 1],
  ["docs/architecture/data/normalization-survey.md", "etrade", 1],
  ["docs/architecture/data/normalization-survey.md", "alpaca", 1],
  ["docs/architecture/data/screening-consolidation-survey.md", "etrade", 21],
  ["docs/architecture/data/screening-consolidation-survey.md", "yahoo", 3],
  ["docs/architecture/data/screening-consolidation-survey.md", "nasdaq", 1],
  ["src/client/mcpEndpointsData.deprecated.ts", "alpaca", 14],
  ["src/client/mcpEndpointsData.deprecated.ts", "etrade", 53],
  ["src/client/mcpEndpointsData.deprecated.ts", "yahoo", 5],
  ["src/client/restEndpointsData.ts", "alpaca", 4],
  ["src/client/restEndpointsData.ts", "etrade", 35],
  ["src/client/restEndpointsData.ts", "yahoo", 3],
  // Issue #6509 — the broker-tool capability map is a provider-id registry:
  // naming each broker's own tool is its job (INTEGRATION).
  ["src/shared/brokerToolNames.ts", "etrade", 5],
  ["src/shared/brokerToolNames.ts", "alpaca", 10],
];

const BASELINE_MAP = new Map(BASELINE.map(([f, t, c]) => [`${f}\t${t}`, c]));
const PLATFORM_KEYS = new Set(
  BASELINE.slice(0, 188).map(([f, t]) => `${f}\t${t}`),
);
// #3917: derived, not a hand-maintained literal — the platform slice is the
// first 188 rows, so its total follows from them.
const PLATFORM_BASELINE_TOTAL = BASELINE.slice(0, 188).reduce((sum, [, , count]) => sum + count, 0);

describe("#3525 S6 shrink-only provider-brand census pin", () => {
  const measured = measure();

  it("the measurement actually ran (walk found the census population)", () => {
    expect(measured.size).toBeGreaterThan(500);
    let total = 0;
    for (const n of measured.values()) total += n;
    expect(total).toBeGreaterThan(5000);
  });

  it("no provider-brand row exists outside the baseline", () => {
    const offenders = [...measured.keys()].filter((k) => !BASELINE_MAP.has(k));
    expect(
      offenders,
      "new file x term rows must be neutralized, or baselined with a census disposition + reason in the same PR",
    ).toEqual([]);
  });

  it("no row's count exceeds its baseline count (shrink-only)", () => {
    const offenders: string[] = [];
    for (const [key, n] of measured) {
      const base = BASELINE_MAP.get(key);
      if (base !== undefined && n > base) offenders.push(`${key.replaceAll("\t", " / ")}: ${base} -> ${n}`);
    }
    expect(
      offenders,
      "counts may only shrink; a raise needs a disposition + reason in the same PR",
    ).toEqual([]);
  });

  it("the PLATFORM population only shrinks (programme headline)", () => {
    let total = 0;
    for (const [key, n] of measured) if (PLATFORM_KEYS.has(key)) total += n;
    expect(total).toBeLessThanOrEqual(PLATFORM_BASELINE_TOTAL);
  });

  it("the baseline is a well-formed seed: unique rows, every count positive (#3917)", () => {
    // #3917: the row total and the line total are NOT pinned as literals. They
    // moved on every additive slice and each bump broke every open PR. What
    // must hold is the shape: no duplicate file×term row, no zero/negative
    // count, and (elsewhere) every measured row present in this table.
    const keys = BASELINE.map(([file, term]) => `${file}\t${term}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [file, term, count] of BASELINE) {
      expect(count, `${file} / ${term}`).toBeGreaterThan(0);
    }
    expect(BASELINE.length).toBeGreaterThan(1000);
  });
});
