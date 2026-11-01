/**
 * Issue #2654 (Platform Phase 3, program #2468) — mesh-aligned access.
 *
 * TDD RED first: this suite imports src/data/productAccess.ts, which does
 * not exist yet. The module must resolve, per catalog entry, the serving
 * card AND workflow (named separately), the chat / panel / api surfaces,
 * and a parity verdict PER DIMENSION — overall "parity" only when every
 * dimension agrees, otherwise "divergent" with named dimensions.
 * Divergences are pinned, never smoothed over (see PHASE3-INVENTORY.md).
 *
 * The workflow-start test drives runStockScreenViaDoor directly with
 * binding-seam fakes only (the #2488 pattern: InMemoryWorkflowAdapter,
 * MockSqlStorage, shard/trace stores), monetization OFF: it is the
 * product-level proof that the stock product's chat command starts the
 * real ScreenerScreenWorkflow run. The #2488 suite remains the
 * turn-level proof (discovered turn tool → queue → executor → door).
 */
import { describe, expect, it } from "vitest";
import {
  buildProductCatalog,
  type ProductEntry,
} from "../src/data/productCatalogue";
import type { PriceEntry } from "../src/data/priceCataloguePorts";
import {
  PRODUCT_CHAT_ROUTES,
  PRODUCT_PANEL_SURFACES,
  resolveProductAccess,
  resolveStockScreeningPrimary,
} from "../src/data/productAccess";
import {
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
  type MeshScreenDoorSeams,
} from "../src/agents/orchestrator/meshScreenDoor";
import { getAgentByClass } from "../src/agents/registry";
import { TRADING_PAID_SERVICES } from "../src/services/agenticPayments";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { recordWorkflowTraceHop } from "../src/observability/meshTrace";
import type {
  ScreenerWorkflowDeps,
  ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import type {
  WorkflowJobCommand,
  WorkflowPort,
} from "../src/workflows/workflowPorts";
import type { Env } from "../src/types";
import { MockSqlStorage } from "./mock-sql";

const LOGIN = "alice";

function seededCatalog(): ProductEntry[] {
  return buildProductCatalog([]);
}

function stockEntry(catalog: ProductEntry[]): ProductEntry {
  const entry = catalog.find((p) => p.id === "stock:PayPerUse");
  if (!entry) throw new Error("stock:PayPerUse missing from catalog");
  return entry;
}

function optionsEntry(catalog: ProductEntry[]): ProductEntry {
  const entry = catalog.find((p) => p.id === "options:PayPerUse");
  if (!entry) throw new Error("options:PayPerUse missing from catalog");
  return entry;
}

function stockPriceRow(priceUSD: number, approvalStatus: string): PriceEntry {
  return {
    family: "stock",
    priceUSD,
    approvalStatus,
  } as unknown as PriceEntry;
}

describe("product access resolution (listed products)", () => {
  it("stock×PayPerUse resolves to the screener chat door + gated API", () => {
    const access = resolveProductAccess(stockEntry(seededCatalog()), [
      stockPriceRow(0.02, "proposed"),
    ]);
    expect(access.routable).toBe(true);
    expect(access.servingAgent).toBe("screener");
    expect(access.canonicalName).toBe(
      TRADING_PAID_SERVICES.STOCK_SIGNALS.name,
    );
    expect(access.chat?.command).toBe("run_stock_screen");
    expect(access.chat?.workflow).toBe("ScreenerScreenWorkflow");
    expect(access.chat?.workflowBinding).toBe("SCREENER_WORKFLOW");
    expect(access.chat?.durable).toBe(true);
    expect(access.api?.gateEndpoint).toBe("/api/premium/stock-signals");
    expect(access.api?.priceUSD).toBe(0.02);
    expect(access.panel.runStatusSurface).toBe(
      "AsyncJobsPanel / WorkflowRunsPanel",
    );
  });

  it("stock×PayPerUse parity is DIVERGENT with gate + operation named", () => {
    const access = resolveProductAccess(stockEntry(seededCatalog()), [
      stockPriceRow(0.02, "proposed"),
    ]);
    expect(access.parity.verdict).toBe("divergent");
    expect(access.parity.dimensions.gate.verdict).toBe("divergent");
    expect(access.parity.dimensions.operation.verdict).toBe("divergent");
    expect(access.parity.dimensions.agent.verdict).toBe("agree");
    // Price VALUES agree as seeded — but the sources differ, and the
    // note must say so; a silent "agree" would hide the divergence risk.
    expect(access.parity.dimensions.price.verdict).toBe("agree");
    expect(access.parity.dimensions.price.note).toMatch(
      /sources differ|raw operator catalogue/,
    );
  });

  it("stock price dimension diverges when the operator catalogue moves", () => {
    const access = resolveProductAccess(stockEntry(seededCatalog()), [
      stockPriceRow(0.03, "proposed"),
    ]);
    expect(access.parity.dimensions.price.verdict).toBe("divergent");
  });

  it("stock chat paid price source is raw catalogue even when approved (F3 pin)", () => {
    const access = resolveProductAccess(stockEntry(seededCatalog()), [
      stockPriceRow(0.02, "approved"),
    ]);
    // The door honors NO approval state: the read path is raw
    // regardless of approvalStatus. #2547 discipline is NOT honored
    // on the door path — pinned here so it cannot silently change.
    expect(access.chat?.paidPriceSource).toBe(
      "operator catalogue (raw, no approval check)",
    );
    expect(access.parity.notes.join(" ")).toMatch(/#2547/);
  });

  it("options×PayPerUse parity holds on gate, price, and envelope", () => {
    const access = resolveProductAccess(optionsEntry(seededCatalog()), []);
    expect(access.routable).toBe(true);
    expect(access.servingAgent).toBe("trading");
    expect(access.chat?.command).toBe("paid_options_screener");
    expect(access.api?.gateEndpoint).toBe("/api/premium/options-scan");
    expect(access.api?.priceUSD).toBe(0.05);
    expect(access.parity.verdict).toBe("parity");
    expect(access.parity.dimensions.gate.verdict).toBe("agree");
    expect(access.parity.dimensions.price.verdict).toBe("agree");
    expect(access.parity.dimensions.operation.verdict).toBe("agree");
    // The free-form strategy door is inline (no workflow/job) — it
    // is recorded, not mistaken for the PayPerUse route.
    expect(access.chat?.freeForm?.command).toBe(
      "run_options_strategy_screen",
    );
    expect(access.chat?.freeForm?.durable).toBe(false);
  });

  it("serving card is never conflated with workflow (options ≠ trade workflow)", () => {
    const access = resolveProductAccess(optionsEntry(seededCatalog()), []);
    expect(access.servingAgent).toBe("trading");
    expect(access.workflow).not.toBe("TradingTradeWorkflow");
  });
});

describe("product access resolution (unlisted products)", () => {
  it("goal×PayPerUse is non-routable with named reasons and honest reachability", () => {
    const entry = seededCatalog().find((p) => p.id === "goal:PayPerUse");
    if (!entry) throw new Error("goal:PayPerUse missing");
    const access = resolveProductAccess(entry, []);
    expect(access.routable).toBe(false);
    expect(access.nonRoutableReasons.join(" ")).toMatch(
      /missing approved price|missing gate endpoint/,
    );
    expect(access.chat).toBeNull();
    expect(access.chatReachabilityNote).toMatch(/trigger_scheduled_goal/);
    expect(access.chatReachabilityNote).toMatch(/run_goal_screen/);
    expect(access.api?.gateEndpoint).toBeNull();
  });

  it("strategy×PayPerUse is non-routable: no serving card, no invented route", () => {
    const entry = seededCatalog().find((p) => p.id === "strategy:PayPerUse");
    if (!entry) throw new Error("strategy:PayPerUse missing");
    const access = resolveProductAccess(entry, []);
    expect(access.routable).toBe(false);
    expect(access.nonRoutableReasons.join(" ")).toMatch(
      /missing serving card/,
    );
    expect(access.chat).toBeNull();
  });

  it("Subscribed and Free never resolve to a purchasable route", () => {
    const catalog = seededCatalog();
    for (const id of ["stock:Subscribed", "stock:Free"]) {
      const entry = catalog.find((p) => p.id === id);
      if (!entry) throw new Error(`${id} missing`);
      const access = resolveProductAccess(entry, []);
      expect(access.routable).toBe(false);
    }
  });
});

describe("dual-card resolution (F4)", () => {
  it("stock screening primary is screener, routed by operation", () => {
    const primary = resolveStockScreeningPrimary();
    expect(primary.primary).toBe("screener");
    expect(primary.primaryOperation).toBe("screener.run_screen");
    expect(primary.alternateOperation).toBe("trading.screen_stocks");
    expect(primary.alternateKind).toMatch(/provider market scan/);
    expect(primary.routingRule).toMatch(/by operation/);
  });

  it("stock access never routes through trading", () => {
    const access = resolveProductAccess(stockEntry(seededCatalog()), [
      stockPriceRow(0.02, "proposed"),
    ]);
    expect(access.chat?.command).not.toMatch(/trading/);
    expect(access.servingAgent).toBe("screener");
  });
});

describe("drift pins", () => {
  it("chat command map and gate values are pinned", () => {
    expect(PRODUCT_CHAT_ROUTES.stock?.command).toBe("run_stock_screen");
    expect(PRODUCT_CHAT_ROUTES.options?.command).toBe(
      "paid_options_screener",
    );
    expect(PRODUCT_CHAT_ROUTES.goal).toBeNull();
    expect(PRODUCT_CHAT_ROUTES.strategy).toBeNull();
    expect(TRADING_PAID_SERVICES.STOCK_SIGNALS.priceUSD).toBe(0.02);
    expect(TRADING_PAID_SERVICES.OPTIONS_SCREENER.priceUSD).toBe(0.05);
    expect(getAgentByClass("ScreenerAgent")).toBeDefined();
    expect(getAgentByClass("TradingAgent")).toBeDefined();
  });

  it("panel surfaces are pinned (options routes, stock provider endpoints)", () => {
    expect(PRODUCT_PANEL_SURFACES.options.trigger).toMatch(
      /\/api\/premium\/options-scan/,
    );
    expect(PRODUCT_PANEL_SURFACES.stock.trigger).toMatch(
      /provider endpointByAssetClass/,
    );
    expect(PRODUCT_PANEL_SURFACES.stock.trigger).not.toBe(
      "/api/premium/stock-signals",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Product-level chat-path workflow-start proof                        */
/* ------------------------------------------------------------------ */

function screenFullResult(universe: string) {
  return {
    timestamp: new Date().toISOString(),
    trigger: "manual",
    provider: "etrade",
    universe,
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 2,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      { symbol: "AMD", companyName: "AMD", lastPrice: 160, changePercent: 1.2 },
    ],
    allStocks: [
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, changePercent: 1.2, source: "etrade" },
    ],
    discoveryMessage: `Discovered listings for ${universe}`,
    filterSummary: "minPrice >= 10",
    rejections: [{ symbol: "XYZ", reason: "below min price" }],
    pdfKey: `screener/${universe}/report.pdf`,
    userLogin: LOGIN,
  };
}

interface DoorHarness {
  startedCommands: WorkflowJobCommand[];
  seams: MeshScreenDoorSeams;
  ctx: MeshScreenDoorContext;
}

function makeDoorHarness(): DoorHarness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const traceStore = new InMemoryMeshTraceStore();
  const startedCommands: WorkflowJobCommand[] = [];
  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        const full = screenFullResult(req.universe ?? "TECH");
        const summary: ShardScreenResult = {
          success: full.success,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: full.totalScanned,
          expectedCount: full.totalScanned,
          matchedCount: full.matchedCount,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore,
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async () => {},
    nowMs: () => Date.now(),
    traceHop: (command, event) =>
      recordWorkflowTraceHop(traceStore, command, event),
  };
  const adapter = new InMemoryWorkflowAdapter(deps);
  const recordingPort: WorkflowPort = {
    start: async (command) => {
      startedCommands.push(command);
      return adapter.start(command);
    },
    status: (workflowId) => adapter.status(workflowId),
  };
  const seams: MeshScreenDoorSeams = {
    workflowPort: recordingPort,
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    traceStore,
    monetizationOn: async () => false,
  };
  const ctx = {
    env: {},
    ensureTables: () => sql,
    ...seams,
  } as unknown as MeshScreenDoorContext;
  return { startedCommands, seams, ctx };
}

describe("chat-path workflow start (product level, #2468 §3 acceptance)", () => {
  it("the stock product's chat command starts a real ScreenerScreenWorkflow run", async () => {
    const access = resolveProductAccess(stockEntry(seededCatalog()), [
      stockPriceRow(0.02, "proposed"),
    ]);
    expect(access.chat?.command).toBe("run_stock_screen");
    const { startedCommands, ctx } = makeDoorHarness();
    const result = await runStockScreenViaDoor(ctx, LOGIN, {
      universe: "NASDAQ100",
    });
    const parents = startedCommands.filter(
      (c) => c.type === "run-screen" && c.role === "parent",
    );
    expect(parents.length).toBeGreaterThanOrEqual(1);
    expect(parents[0].userLogin).toBe(LOGIN);
    expect(result.success).toBe(true);
    expect(result.universe).toBe("NASDAQ100");
    expect(result.matchedCount).toBe(2);
  });

  it("a missing acting login refuses before any workflow start", async () => {
    const { startedCommands, ctx } = makeDoorHarness();
    await expect(
      runStockScreenViaDoor(ctx, undefined, { universe: "NASDAQ100" }),
    ).rejects.toThrow();
    expect(startedCommands).toHaveLength(0);
  });
});
