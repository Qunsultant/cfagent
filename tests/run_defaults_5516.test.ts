/**
 * Issue #5516 — the run-level defaults are externalized: ONE block, one reader,
 * no per-surface literal.
 *
 * The block is config/vocabulary.json -> defaults
 * (provider=alpaca, broker=alpaca, mode=paper, asset=equity,
 * universe=nasdaq100). Before this slice the block existed but had no
 * consumers: the stock screen defaulted its universe to TECH (a sector, not a
 * universe) in five places and its provider to etrade in two, and the tenant
 * default table carried its own copy of alpaca/alpaca.
 *
 * The pins, and what each one protects:
 *
 *   D1  the block holds the owner's values;
 *   D2  a SEAM CHANGE MOVES every resolved surface — the proof that each one
 *       reads the block at call time instead of snapshotting it;
 *   D3  an explicit selection is untouched by the default;
 *   D4  a source pin: the run-default modules carry no default literal of
 *       their own;
 *   D5  the legacy stored-value readers still read an absent value as etrade —
 *       kept deliberately, so history is never relabelled;
 *   D6  a configured default that cannot serve refuses by name instead of
 *       silently doing something else.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  defaultFor,
  getVocabulary,
  setVocabulary,
  vocabularyDefaults,
  type Vocabulary,
} from "../src/config/vocabulary";
import {
  buildSchedulePayload,
  defaultBrokerId,
  defaultStockScreenProvider,
  parseStockScreenRequest,
  resolveUniverse,
  STOCK_SCREEN_PROVIDERS,
  UNIVERSES,
} from "../src/trading";
import { planStockScreenRun } from "../src/workflows/stockScreenPlanner";
import { defaultUniverseId } from "../src/config/defaultUniverse";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";
import { DEFAULT_TENANT_PROVIDERS_STATE } from "../src/client/tenantProviders";
import { normalizeDiscoveryRunBroker } from "../src/data/discoveryRunPorts";
import { normalizeScanRunBroker } from "../src/data/scanRunPorts";
import { normalizeIvBroker } from "../src/data/ivHistoryPorts";

/** A copy of the registry with one or more defaults changed (the seam). */
function withDefaults(over: Partial<Vocabulary["defaults"]>): Vocabulary {
  const current = getVocabulary();
  // Spread the whole registry: a field another slice adds (e.g. the provider ×
  // dataset matrix) must survive, or the seam copy fails validation the moment
  // main grows an axis.
  return { ...current, defaults: { ...current.defaults, ...over } };
}

afterEach(() => setVocabulary(null));

describe("#5516 run-level defaults are externalized", () => {
  it("D1 the one block holds the owner's defaults", () => {
    expect(vocabularyDefaults()).toEqual({
      provider: "alpaca",
      broker: "alpaca",
      mode: "paper",
      asset: "equity",
      universe: "nasdaq100",
    });
  });

  it("D2 a seam change moves every resolved surface", () => {
    setVocabulary(withDefaults({ provider: "etrade", broker: "public", mode: "live", universe: "sp500" }));

    // The readers themselves.
    expect(defaultFor("universe")).toBe("sp500");
    expect(defaultUniverseId()).toBe("SP500");
    expect(defaultStockScreenProvider()).toBe("etrade");
    expect(defaultBrokerId()).toBe("public");

    // The run planner: the universe it plans with no selection.
    const plan = planStockScreenRun(
      { trigger: "manual", provider: "yahoo" },
      "2026-11-21T00:00:00.000Z",
    );
    expect(plan.universe).toBe("SP500");

    // The interactive route default and the schedule-creation default.
    const parsed = parseStockScreenRequest({});
    expect(parsed.ok && parsed.value.universe).toBe("SP500");
    const built = buildSchedulePayload("autonomousOptionsAnalysis", {}, {} as never);
    expect(built.ok && built.value.universe).toBe("SP500");

    // The tenant default table and its client mirror are views, not copies.
    expect(DEFAULT_TENANT_PROVIDERS).toEqual({ dataProviderId: "etrade", brokerId: "public" });
    expect(DEFAULT_TENANT_PROVIDERS_STATE).toEqual({ dataProviderId: "etrade", brokerId: "public" });
  });

  it("D3 an explicit selection is untouched by the default", () => {
    setVocabulary(withDefaults({ universe: "sp500", provider: "etrade" }));

    const plan = planStockScreenRun(
      { trigger: "manual", provider: "yahoo", universe: "TECH" },
      "2026-11-21T00:00:00.000Z",
    );
    expect(plan.universe).toBe("TECH");
    expect(plan.provider).toBe("yahoo");

    const parsed = parseStockScreenRequest({ universe: "NASDAQ100" });
    expect(parsed.ok && parsed.value.universe).toBe("NASDAQ100");
  });

  it("D4 no run-default surface carries a default literal of its own", () => {
    const files = [
      "src/workflows/stockScreenPlanner.ts",
      "src/agents/orchestrator/nlqPorts.ts",
      "src/agents/orchestrator/scheduledCallbacks.ts",
      "src/agents/orchestrator/reportDispatch.ts",
      "src/agents/screenerA2aDispatch.ts",
      "src/agents/screener-agent.ts",
      "src/agents/routes/brokerScreen.ts",
      "src/agents/routes/schedules.ts",
      "src/agents/nlqOptionsStrategy.ts",
      "src/services/scheduledTasks.ts",
      "src/services/optionsServeRecord.ts",
      "src/services/tradingRunOutcome.ts",
      "src/services/orderCancellation.ts",
      "src/services/orderExecutionNotifier.ts",
      "src/events/screenerPublishers.ts",
      "src/trading/screenerReportPdf.ts",
      "src/trading/screeningSchemas.ts",
      "src/client/TradeHub.tsx",
      "src/client/BrokerDynamicMenu.tsx",
      "src/client/BrokerPanel.tsx",
    ];
    // A default in expression position: "x ?? 'TECH'" or "x || 'etrade'". A
    // comparison (=== "paper") or a ternary branch is not a default and is
    // left alone (the legacy stored-value readings in D5 are exactly that).
    // Comment lines are documentation, not behaviour: the planner's header
    // records the pre-#4431 literal it removed, and that history is why the
    // removal must not be re-introduced.
    const DEFAULT_LITERAL = /(\?\?|\|\|)\s*["'](TECH|NASDAQ100|etrade|alpaca|paper)["']/;
    const violations: string[] = [];
    for (const rel of files) {
      const lines = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (/^(\*|\/\/|\/\*|\*\/)/.test(trimmed)) return;
        if (DEFAULT_LITERAL.test(line)) violations.push(`${rel}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it("D5 legacy stored values still read as etrade — history is not relabelled", () => {
    // Rows written before provenance existed were produced by the E*TRADE-wired
    // engine; the new default broker does not rewrite them.
    expect(normalizeDiscoveryRunBroker(undefined)).toBe("etrade");
    expect(normalizeScanRunBroker("")).toBe("etrade");
    expect(normalizeIvBroker(undefined)).toBe("etrade");
    // And the live default is the new one, so the contrast is explicit.
    expect(DEFAULT_TENANT_PROVIDERS.brokerId).toBe("alpaca");

    // The one creation-time bootstrap exception is named, not silent: an
    // unreadable tenant store still checks the E*TRADE token (pre-#3655),
    // because that check names the broker it checks.
    const schedulesRoute = fs.readFileSync(
      path.resolve(__dirname, "../src/agents/routes/schedules.ts"),
      "utf8",
    );
    expect(schedulesRoute).toContain('const LEGACY_UNREADABLE_BROKER = "etrade";');
  });

  it("D6 a configured default that cannot serve refuses by name", () => {
    // The universe bridge is registry-free on purpose (a planner can run
    // before UNIVERSES initializes, #5516); the registry itself refuses an id
    // it does not hold, at the one place that indexes it.
    setVocabulary(withDefaults({ universe: "dow" }));
    expect(defaultUniverseId()).toBe("DOW");
    expect(() => resolveUniverse(defaultUniverseId(), [])).toThrow(/"DOW" is not a screener universe/);
    expect(() => resolveUniverse(defaultUniverseId(), [])).toThrow(/Screener universes/);

    setVocabulary(withDefaults({ provider: "nasdaq" }));
    expect(() => defaultStockScreenProvider()).toThrow(/configured default provider "nasdaq"/);
    expect(() => defaultStockScreenProvider()).toThrow(new RegExp(STOCK_SCREEN_PROVIDERS.join(", ")));
  });

  it("D7 the registry keeps TECH selectable — it is just never a default", () => {
    expect(Object.prototype.hasOwnProperty.call(UNIVERSES, "TECH")).toBe(true);
    expect(vocabularyDefaults().universe).not.toBe("tech");
  });
});
