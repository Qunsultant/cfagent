/**
 * Issue #995: re-split of the two route modules that outgrew #359's
 * <50 KB target — src/agents/routes/etradeOptions.ts (72,232 B) and
 * src/agents/routes/etradeBroker.ts (57,032 B). Owner decision on #995:
 * option (a) RE-SPLIT; the target is NOT amended.
 *
 * The split is constrained by the unmodified #359 pins, which anchor the
 * route conditions, the ETradeService construction sites
 * (trading_extraction_ledger: 20 in etradeBroker.ts, 7 in
 * etradeOptions.ts at split time — 5 since #291 T5c migrated two
 * handlers to the platform registry), and several body literals to the two original
 * files. The originals therefore remain the dispatchers — every route
 * condition, prologue (validation / schema parse / service
 * construction), and pinned literal stays in place — and the unpinned
 * handler bodies move to per-family sibling modules:
 *
 *   etradeOptionsRuns.ts       latest runs, scan/discovery run stores, IV history
 *   etradeOptionsProfiles.ts   strategy profiles CRUD, strategy reviews
 *   etradeOptionsEvaluate.ts   llm-ideas evaluation tail, compare LLM ranking
 *   etradeOptionsScreen.ts     options screen / unified execution tails
 *   etradeBrokerDiagnostics.ts broker diagnostics body
 *   etradeBrokerScreen.ts      equity screen execution tail
 *   etradeBrokerOrders.ts      order preview / execute completion tails
 *   etradeBrokerLearning.ts    setup catalog, learnings, reflection trigger
 *
 * This pin asserts: (a) every module in the split set is < 50,000 bytes
 * (the #359 target, strictest reading); (b) the whole-file route
 * condition inventory of each original file is byte-identical to the
 * pre-split baseline captured on main ac61fb39 (order and duplicates
 * included — the same COND_RE scan thin_router_inventory uses), except
 * the #1334 dedup below (catalog 2→1: the dead second handler is gone,
 * so the baseline carries one catalog condition); (c) the
 * regex-match conditions stay in etradeOptions.ts in order; (d) the
 * construction ledger is preserved exactly — originals keep their
 * counts, new modules construct no ETradeService; (e) the originals
 * still export the public handlers and delegate to the new modules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";

const LIMIT = 50_000;

const OPTIONS_FILE = "src/agents/routes/etradeOptions.ts";
const BROKER_FILE = "src/agents/routes/etradeBroker.ts";

const NEW_MODULES = [
  "src/agents/routes/etradeOptionsRuns.ts",
  "src/agents/routes/etradeOptionsProfiles.ts",
  "src/agents/routes/etradeOptionsEvaluate.ts",
  "src/agents/routes/etradeOptionsScreen.ts",
  "src/agents/routes/etradeBrokerDiagnostics.ts",
  "src/agents/routes/etradeBrokerScreen.ts",
  "src/agents/routes/etradeBrokerOrders.ts",
  "src/agents/routes/etradeBrokerLearning.ts",
];

const COND_RE = /path\.(endsWith|includes|startsWith)\("([^"]+)"\)|path === "([^"]+)"/g;
const conditionsIn = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(COND_RE))
    out.push(m[3] !== undefined ? `=== "${m[3]}"` : `${m[1]}("${m[2]}")`);
  return out;
};

// Pre-split baselines, captured on main ac61fb39 with the same scan.
const OPTIONS_CONDITIONS_BASELINE = [
  'endsWith("/options/latest")',
  'endsWith("/etrade/options/chains")',
  'endsWith("/etrade/options/strategy")',
  'endsWith("/etrade/options/expire-dates")',
  'endsWith("/etrade/options/scans")',
  'endsWith("/etrade/options/scans/diff")',
  // Issue #2180: the discovery run-report downloads.
  'endsWith("/discovery/report.pdf")',
  'endsWith("/discovery/report.xlsx")',
  'endsWith("/discovery/report.csv")',
  'endsWith("/etrade/options/discovery-runs")',
  'endsWith("/etrade/options/iv-history")',
  'endsWith("/etrade/options/profiles")',
  'endsWith("/etrade/options/profiles")',
  'endsWith("/trading/options/llm-ideas")',
  'endsWith("/trading/options/compare")',
  'endsWith("/trading/options/compare")',
  // Issue #1361 (consolidation C5): the comparison surface — ledger
  // read-back first (its path ends with the comparison path), then
  // the comparison run, both before recommend (source order).
  'endsWith("/trading/options/comparison/outcomes")',
  'endsWith("/trading/options/comparison")',
  'endsWith("/trading/options/recommend")',
  // Issue #1334: one catalog condition — the dead second handler is gone.
  'endsWith("/trading/options/catalog")',
  'endsWith("/trading/options/strategies")',
  'endsWith("/trading/options/best-trade")',
  'endsWith("/best-trade")',
  'endsWith("/trading/options/screen")',
  'endsWith("/trading/options/regenerate")',
  'endsWith("/trading/options/unified")',
  'endsWith("/trading/options/config")',
  'endsWith("/options/strategy-reviews")',
  'endsWith("/options/strategy-reviews/decide")',
];

const BROKER_CONDITIONS_BASELINE = [
  'endsWith("/environment/switch")',
  'endsWith("/broker/etrade/environment")',
  'endsWith("/environment/switch")',
  'endsWith("/broker/etrade/environment")',
  'endsWith("/etrade/status")',
  'endsWith("/etrade/diagnostics")',
  'endsWith("/etrade/accounts")',
  'endsWith("/etrade/screen")',
  'endsWith("/etrade/quote")',
  'endsWith("/etrade/order/preview")',
  'endsWith("/etrade/order/execute")',
  'endsWith("/etrade/positions")',
  'endsWith("/etrade/portfolio-risk")',
  'endsWith("/etrade/portfolio-risk/evaluate")',
  'endsWith("/etrade/portfolio-risk/correlation")',
  'endsWith("/etrade/portfolio-risk/size")',
  'endsWith("/etrade/portfolio-risk/bundle")',
  'endsWith("/etrade/think/evaluate")',
  'endsWith("/etrade/hedge/analyze")',
  'endsWith("/etrade/portfolio-repair/analyze")',
  'endsWith("/etrade/orders")',
  'endsWith("/etrade/orders/remote")',
  'endsWith("/etrade/orders/cancel")',
  'endsWith("/etrade/transactions")',
  'includes("/etrade/transactions/")',
  'endsWith("/etrade/alerts")',
  'includes("/etrade/alerts/")',
  'includes("/etrade/alerts/")',
  'endsWith("/etrade/lookup")',
  'endsWith("/trading/setup-catalog")',
  'endsWith("/learnings")',
  'endsWith("/learnings")',
  'endsWith("/reflection/run")',
];

describe("route module re-split (#995)", () => {
  it("every module in the split set is under the #359 50 KB target", () => {
    for (const file of [OPTIONS_FILE, BROKER_FILE, ...NEW_MODULES]) {
      expect(existsSync(file), `${file} must exist`).toBe(true);
      const size = statSync(file).size;
      expect(size, `${file} is ${size} B, over the ${LIMIT} B target`).toBeLessThan(LIMIT);
    }
  });

  it("the route condition inventory of each original file is unchanged (order + duplicates)", () => {
    expect(conditionsIn(readFileSync(OPTIONS_FILE, "utf8"))).toEqual(OPTIONS_CONDITIONS_BASELINE);
    expect(conditionsIn(readFileSync(BROKER_FILE, "utf8"))).toEqual(BROKER_CONDITIONS_BASELINE);
  });

  it("the regex-match conditions stay in etradeOptions.ts in order", () => {
    const text = readFileSync(OPTIONS_FILE, "utf8");
    const markers = [
      "path.match(/\\/etrade\\/options\\/scans\\/([^/]+)$/)",
      "path.match(/\\/etrade\\/options\\/discovery-runs\\/([^/]+)$/)",
      "path.match(/\\/etrade\\/options\\/profiles\\/([^/]+)$/)",
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = text.indexOf(marker, last + 1);
      expect(idx, `regex condition must stay in etradeOptions.ts: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the ETradeService construction ledger is preserved (originals keep counts, new modules add none)", () => {
    const count = (file: string) => readFileSync(file, "utf8").split("new ETradeService(").length - 1;
    // Was 7 at the #995 re-split; #291 T5c migrated the chain +
    // expire-dates handlers to the platform registry (ledger 51 -> 49),
    // shrinking this count in the migrating PR per the ledger's rule.
    // #1361 (consolidation C5) added the comparison route, which
    // constructs its own service like every sibling options route.
    expect(count(OPTIONS_FILE)).toBe(6);
    // Was 20 at the re-split; #291 Q3 migrated the quote route to the
    // registry + LIVE_STRICT policy (ledger 48 -> 47); #1135 added the
    // recommendation-bundle route, which constructs its own service
    // like every sibling portfolio-risk route (19 -> 20); #1726 adds
    // the /etrade/screen listings branch, which constructs its own
    // service like every sibling broker route (20 -> 21). The branch
    // body lives in etradeBrokerScreen.ts, which constructs none.
    expect(count(BROKER_FILE)).toBe(21);
    for (const file of NEW_MODULES) {
      expect(count(file), `${file} must not construct ETradeService`).toBe(0);
    }
  });

  it("the originals still export the public handlers and delegate to the split modules", () => {
    const options = readFileSync(OPTIONS_FILE, "utf8");
    expect(options).toContain("export interface EtradeOptionsRouteContext");
    expect(options).toContain("export async function handleOptionsStrategyRecommend");
    expect(options).toContain("export async function handleEtradeOptionsRoutes");
    for (const call of [
      "handleOptionsLatestRuns(",
      "handleOptionsScansList(",
      "handleOptionsProfilesList(",
      "executeLlmIdeasEvaluation(",
      "executeOptionsScreen(",
      "executeUnifiedOptions(",
    ]) {
      expect(options, `etradeOptions.ts must delegate via ${call}`).toContain(call);
    }
    const broker = readFileSync(BROKER_FILE, "utf8");
    expect(broker).toContain("export interface EtradeBrokerRouteContext");
    // Issue #2482 split: the switch handler lives in brokerEnvironment.ts
    // (same #995 pattern as diagnostics); etradeBroker.ts delegates.
    expect(readFileSync("src/agents/routes/brokerEnvironment.ts", "utf8")).toContain(
      "export async function handleEnvironmentSwitch",
    );
    expect(broker).toContain("return handleEnvironmentSwitch(request, ctx);");
    expect(broker).toContain("export async function handleEtradeBrokerRoutes");
    expect(broker).toContain("export async function handleEtradeBrokerActivityRoutes");
    for (const call of [
      "handleEtradeDiagnostics(",
      "executeEtradeScreen(",
      "completeEtradeOrderPreview(",
      "completeEtradeOrderExecution(",
      "handleLearningsList(",
      "handleReflectionRun(",
    ]) {
      expect(broker, `etradeBroker.ts must delegate via ${call}`).toContain(call);
    }
  });
});
