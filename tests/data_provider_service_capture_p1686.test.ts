/**
 * Issue #1686 (L2 follow-up to #1661, epic #1116) — the slice's NEW behaviour:
 * thread a DO storage handle into the NLQ, MCP, and trading-agent stock-screen
 * legs so their listings fetches write capture rows (raw blob + SHA-256 + run id).
 *
 * TDD Red: the executing pins FAIL on the pre-slice tree (constructions without
 * storage, service/platform internal builds without a storage arg, the trading
 * leg returning the missing-seam error result) and pass after threading.
 *
 * What each pin proves, honestly:
 *  - Executing pins (NLQ/MCP/trading): a listings fetch through the leg writes
 *    a capture row (COUNT(*) on mas_data_captures) AND blob bytes (put count
 *    on the stubbed store). The listings fetch itself is stubbed at the
 *    nasdaqListings module boundary (same seam the bundle's adapter calls) —
 *    no network in vitest. The trading pin additionally asserts the NEW
 *    SUCCESS SHAPE (no discovery.error, stub stocks present), not just capture.
 *  - Source pins (p1661 precedent, readFileSync): the construction/call site
 *    carries the handle. They prove threading, not a fetched row.
 *  - Contract pins (disclosed — pass on control too): without storage the
 *    service/platform still build outcome-only (no capture); they pin the
 *    degradation contract, not the new behaviour.
 *  - NLQ mcp-mode pin (scope update 2026-10-26: mcp mode is FULLY IN SCOPE —
 *    the earlier disclosed exception was withdrawn by the user): the mcp
 *    branch passes storage and nothing else (no ports/stores/runners).
 *    It fails on control (no storage in the branch) and passes after.
 *  - Verification pins (disclosed — pass on control too): async-job NLQ and
 *    chat-fallback NLQ already pass a stock-screen port (the #1661-closed
 *    capturing path); they document the brief's VERIFY step, not new work.
 *
 * No secret-shaped literals: this file contains no credentials, keys, or
 * tokens in any form.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureCaptureTable,
} from "../src/trading/dataProviders/captureStore";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

/** The single source line containing a needle. */
function lineWith(fileSrc: string, needle: string): string {
  const line = fileSrc.split("\n").find((l) => l.includes(needle));
  expect(line).toBeDefined();
  return line!;
}

/** Source span from the first line containing `start` through the first line containing `end` after it. */
function spanBetween(fileSrc: string, start: string, end: string): string {
  const lines = fileSrc.split("\n");
  const s = lines.findIndex((l) => l.includes(start));
  expect(s).toBeGreaterThan(-1);
  const e = lines.findIndex((l, i) => i > s && l.includes(end));
  expect(e).toBeGreaterThan(-1);
  return lines.slice(s, e + 1).join("\n");
}

/** Interface block: from `export interface NAME` (extends clause tolerated) to the closing `}` at column 0. */
function interfaceBlock(fileSrc: string, name: string): string {
  const start = fileSrc.indexOf(`export interface ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = fileSrc.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(-1);
  return fileSrc.slice(start, end);
}

function fakeBlobStorage() {
  const store = new Map<string, unknown>();
  let puts = 0;
  return {
    store,
    puts: () => puts,
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      puts += 1;
      store.set(key, value);
    },
  };
}

function stubListings(): NasdaqStockListing[] {
  return [
    { symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", lastPrice: 150, change: 1, changePercent: 0.5, sector: "Technology", marketCap: 3e12 } as NasdaqStockListing,
    { symbol: "MSFT", companyName: "Microsoft Corp.", exchange: "NASDAQ", lastPrice: 300, change: 1, changePercent: 0.5, sector: "Technology", marketCap: 2.5e12 } as NasdaqStockListing,
  ];
}

function countCaptures(sql: MockSqlStorage): number {
  const rows = Array.from(
    sql.exec("SELECT COUNT(*) AS count FROM mas_data_captures") as Iterable<{ count: number }>
  );
  return rows[0]?.count ?? 0;
}

/**
 * Installs the offline fetch seam (stubbed nasdaq listings + mocked provider
 * verify, p1661 S4 pattern), dynamically imports the NLQ/MCP leg modules
 * fresh, runs `fn`, then restores the module registry. Every NLQ/MCP
 * executing pin runs inside this helper so the mock cannot leak.
 * NOTE: trading-agent is NOT imported here — its `agents` SDK import is
 * unimportable under vitest's node loader (cloudflare: scheme); the
 * trading pin uses withTradingMocks, which stubs `agents` + `ai`.
 */
async function withFetchMocks<T>(fn: (mods: {
  ETradeService: any;
  ETradeMarketScanCommand: any;
  executeNLQQueryAsync: any;
}) => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/services/nasdaqListings", async () => {
    const actual: any = await vi.importActual("../src/services/nasdaqListings");
    return { ...actual, fetchAllUsStockListings: async () => stubListings() };
  });
  vi.doMock("../src/trading/dataProviders/adapters", async () => {
    const actual: any = await vi.importActual("../src/trading/dataProviders/adapters");
    return { ...actual, verifyNasdaqDataProvider: async () => ({ ok: true, summary: "mocked verify" }) };
  });
  try {
    const { ETradeService } = await import("../src/services/etrade");
    const { ETradeMarketScanCommand } = await import("../src/mcps/openaimp/etradeCommands");
    const { executeNLQQueryAsync } = await import("../src/agents/nlq/execution");
    return await fn({ ETradeService, ETradeMarketScanCommand, executeNLQQueryAsync });
  } finally {
    vi.doUnmock("../src/services/nasdaqListings");
    vi.doUnmock("../src/trading/dataProviders/adapters");
    vi.resetModules();
  }
}

/**
 * Trading-leg variant: same fetch seam PLUS stubs for the Cloudflare Agents
 * SDK (`agents`) and `ai` tool helper, without which trading-agent.ts cannot
 * load under vitest (its `Agent` base imports the cloudflare: scheme).
 * The stubs only stand in for the DO base class + tool wrapper; the leg
 * under test (executeTradingService → resolveTradingPlatform → factory →
 * platform → seam → fetch → capture) runs entirely on real code. Also
 * imports the trading barrel so the etrade factory registers.
 */
async function withTradingMocks<T>(fn: (mods: {
  executeTradingService: any;
}) => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/services/nasdaqListings", async () => {
    const actual: any = await vi.importActual("../src/services/nasdaqListings");
    return { ...actual, fetchAllUsStockListings: async () => stubListings() };
  });
  vi.doMock("../src/trading/dataProviders/adapters", async () => {
    const actual: any = await vi.importActual("../src/trading/dataProviders/adapters");
    return { ...actual, verifyNasdaqDataProvider: async () => ({ ok: true, summary: "mocked verify" }) };
  });
  vi.doMock("agents", () => ({ Agent: class {} }));
  vi.doMock("ai", () => ({ tool: (def: any) => def }));
  try {
    const { executeTradingService } = await import("../src/agents/trading-agent");
    await import("../src/trading");
    return await fn({ executeTradingService });
  } finally {
    vi.doUnmock("../src/services/nasdaqListings");
    vi.doUnmock("../src/trading/dataProviders/adapters");
    vi.doUnmock("agents");
    vi.doUnmock("ai");
    vi.resetModules();
  }
}

function mockOrm(sql: MockSqlStorage): any {
  // The ctor detects an ORM by `"trades" in ormOrEnv` (p1661 precedent).
  return { trades: {}, getSql: () => sql };
}

describe("NLQ leg (executing)", () => {
  it("port-less screen action writes a capture row + blob bytes", async () => {
    await withFetchMocks(async ({ executeNLQQueryAsync }) => {
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      const plan = {
        domain: "trading",
        tradingData: { action: "screen", filters: {} },
      };
      const result = await executeNLQQueryAsync(
        mockOrm(sql),
        "test-session",
        plan,
        {} as never,
        "tester",
        undefined,
        { storage: blob as never }
      );
      expect(result.status).not.toBe("error");
      expect(countCaptures(sql)).toBeGreaterThan(0);
      expect(blob.puts()).toBeGreaterThan(0);
    });
  });
});

describe("MCP leg (executing)", () => {
  it("etrade_market_scan with storage writes a capture row + blob bytes", async () => {
    await withFetchMocks(async ({ ETradeMarketScanCommand }) => {
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      const cmd = new ETradeMarketScanCommand();
      const result = await cmd.execute(
        {},
        {
          orm: mockOrm(sql),
          env: {} as never,
          sessionId: "tester",
          audit: () => undefined,
          storage: blob as never,
        }
      );
      expect(result.stocks?.length ?? result.matchedCount ?? 0).toBeGreaterThan(0);
      expect(countCaptures(sql)).toBeGreaterThan(0);
      expect(blob.puts()).toBeGreaterThan(0);
    });
  });
});

describe("trading-agent leg (executing, Q7)", () => {
  it("stock_screening returns the NEW SUCCESS SHAPE + capture row (not the missing-seam error)", async () => {
    await withTradingMocks(async ({ executeTradingService }) => {
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      const result: any = await executeTradingService(
        {} as never,
        { enabledProviders: ["etrade"], defaultProvider: "etrade", enabledServices: ["stock_screening"] },
        {
          serviceId: "stock_screening",
          input: { filter: {} },
          userLogin: "tester",
          orm: mockOrm(sql),
          storage: blob as never,
        } as never
      );
      expect(result.discovery?.error).toBeUndefined();
      expect(Array.isArray(result.stocks) && result.stocks.length).toBeGreaterThan(0);
      expect(countCaptures(sql)).toBeGreaterThan(0);
      expect(blob.puts()).toBeGreaterThan(0);
    });
  });
});

describe("service/platform internal builds (module-spy + contract)", () => {
  it("service internal build receives storage when constructed with it", async () => {
    vi.resetModules();
    const seamInputs: any[] = [];
    vi.doMock("../src/trading/screenerPipeline", async () => {
      const actual: any = await vi.importActual("../src/trading/screenerPipeline");
      return {
        ...actual,
        nasdaqUniverseSeamFromSql: async (...args: any[]) => {
          seamInputs.push(args);
          return actual.nasdaqUniverseSeamFromSql(...args);
        },
      };
    });
    vi.doMock("../src/services/nasdaqListings", async () => {
      const actual: any = await vi.importActual("../src/services/nasdaqListings");
      return { ...actual, fetchAllUsStockListings: async () => stubListings() };
    });
    vi.doMock("../src/trading/dataProviders/adapters", async () => {
      const actual: any = await vi.importActual("../src/trading/dataProviders/adapters");
      return { ...actual, verifyNasdaqDataProvider: async () => ({ ok: true, summary: "mocked verify" }) };
    });
    try {
      const { ETradeService } = await import("../src/services/etrade");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      const etrade = new ETradeService(mockOrm(sql), {} as never, "tester", undefined, blob as never);
      await etrade.screenMarketsAsync({}).catch(() => null);
      expect(seamInputs.length).toBeGreaterThan(0);
      expect(seamInputs[0][3]).toBe(blob);
    } finally {
      vi.doUnmock("../src/trading/screenerPipeline");
      vi.doUnmock("../src/services/nasdaqListings");
      vi.doUnmock("../src/trading/dataProviders/adapters");
      vi.resetModules();
    }
  });

  it("service without storage still builds outcome-only (contract, passes on control)", async () => {
    vi.resetModules();
    const seamInputs: any[] = [];
    vi.doMock("../src/trading/screenerPipeline", async () => {
      const actual: any = await vi.importActual("../src/trading/screenerPipeline");
      return {
        ...actual,
        nasdaqUniverseSeamFromSql: async (...args: any[]) => {
          seamInputs.push(args);
          return actual.nasdaqUniverseSeamFromSql(...args);
        },
      };
    });
    try {
      const { ETradeService } = await import("../src/services/etrade");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const etrade = new ETradeService(mockOrm(sql), {} as never, "tester");
      await etrade.screenMarketsAsync({}).catch(() => null);
      expect(seamInputs.length).toBeGreaterThan(0);
      expect(seamInputs[0][3]).toBeUndefined();
    } finally {
      vi.doUnmock("../src/trading/screenerPipeline");
      vi.resetModules();
    }
  });
});

describe("source pins: NLQ threading", () => {
  it("AsyncCore constructs the service with deps storage", () => {
    const line = lineWith(src("agents/nlq/execution.ts"), "new ETradeService(orm, env, login");
    expect(line).toContain("deps?.storage");
  });

  it("executeNaturalLanguageQuery guard + deps literal carry storage", () => {
    const span = spanBetween(
      src("agents/nlq/execution.ts"),
      "resolvedOptions?.storage ||",
      ": undefined,"
    );
    expect(span).toContain("resolvedOptions?.storage");
    expect(span).toContain("storage: resolvedOptions?.storage");
  });

  it("NLQ route rest-mode options literal carries top-level storage", () => {
    const line = lineWith(src("agents/routes/mcpChatNlq.ts"), "fitDiscoveryRunner: createFitDiscoveryRunner");
    expect(line).toContain("socialBriefPort, storage: ctx.getStorage?.()");
  });

  it("NLQExecutionDeps declares optional storage", () => {
    expect(interfaceBlock(src("agents/nlq/types.ts"), "NLQExecutionDeps")).toContain("storage?:");
  });
});

describe("source pins: MCP threading", () => {
  it("McpToolContext declares optional storage", () => {
    expect(interfaceBlock(src("patterns/interfaces.ts"), "McpToolContext")).toContain("storage?:");
  });

  it("orchestrator turn context supplies this.ctx.storage", () => {
    const span = spanBetween(
      src("agents/orchestrator.ts"),
      "private chatTurnHelpersContext()",
      "activeTurnMetadata:"
    );
    expect(span).toContain("storage: this.ctx.storage");
  });

  it("createTurnTools forwards storage into the tool context", () => {
    const span = spanBetween(
      src("agents/orchestrator/chatTurnHelpers.ts"),
      "return createAgentMcpTools({",
      "});"
    );
    expect(span).toContain("storage: ctx.storage");
  });

  it("etrade_market_scan constructs the service with context storage", () => {
    const line = lineWith(src("mcps/openaimp/etradeCommands.ts"), "new ETradeService(context.orm");
    expect(line).toContain("context.storage");
  });

  it("ChatTurnHelpersContext declares optional storage", () => {
    expect(interfaceBlock(src("agents/orchestrator/chatTurnHelpers.ts"), "ChatTurnHelpersContext")).toContain("storage?:");
  });
});

describe("source pins: trading-agent threading", () => {
  it("TradingServiceContext declares optional orm + storage", () => {
    const block = interfaceBlock(src("agents/trading-agent.ts"), "TradingServiceContext");
    expect(block).toContain("orm?:");
    expect(block).toContain("storage?:");
  });

  it("TradingServiceCall declares optional orm + storage", () => {
    const block = interfaceBlock(src("agents/trading-agent.ts"), "TradingServiceCall");
    expect(block).toContain("orm?:");
    expect(block).toContain("storage?:");
  });

  it("getTools supplies the instance orm + storage", () => {
    const line = lineWith(src("agents/trading-agent.ts"), "buildTradingTools(this.env");
    expect(line).toContain("this.getOrm()");
    expect(line).toContain("this.ctx.storage");
  });

  it("executeTradingService ctx forwards call orm + storage", () => {
    const span = spanBetween(
      src("agents/trading-agent.ts"),
      "const ctx: TradingServiceContext = {",
      "};"
    );
    expect(span).toContain("orm: call.orm");
    expect(span).toContain("storage: call.storage");
  });

  it("buildTradingTools forwards deps orm + storage into the call", () => {
    const span = spanBetween(
      src("agents/trading-agent.ts"),
      "export function buildTradingTools(",
      "});"
    );
    expect(span).toContain("orm: deps?.orm");
    expect(span).toContain("storage: deps?.storage");
  });

  it("resolveTradingPlatform passes orm + storage through (no undefined orm)", () => {
    const span = spanBetween(
      src("agents/trading-agent.ts"),
      "return TradingPlatformRegistry.getPlatform(",
      ");"
    );
    expect(span).toContain("orm,");
    expect(span).toContain("storage,");
  });

  it("registry getPlatform accepts optional storage", () => {
    const line = lineWith(src("trading/registry.ts"), "static getPlatform(");
    expect(line).toContain("storage?");
  });

  it("etrade factory passes storage to the platform ctor", () => {
    const line = lineWith(src("trading/index.ts"), 'register("etrade"');
    expect(line).toContain("storage");
  });

  it("platform internal build receives this.storage", () => {
    const line = lineWith(
      src("trading/etrade/platform.ts"),
      "nasdaqUniverseSeamFromSql(this.orm?.getSql?.(), this.env, this.userLogin"
    );
    expect(line).toContain("this.storage");
  });

  it("service internal build receives this.storage", () => {
    const line = lineWith(
      src("services/etrade.ts"),
      "nasdaqUniverseSeamFromSql(this.orm?.getSql?.(), this.env, this.userLogin"
    );
    expect(line).toContain("this.storage");
  });

  it("Door 3 (executeService) supplies instance orm + storage as fallback", () => {
    const span = spanBetween(
      src("agents/trading-agent.ts"),
      "async executeService(call",
      "});"
    );
    expect(span).toContain("this.getOrm()");
    expect(span).toContain("this.ctx.storage");
  });

  it("A2A door (handleA2A) supplies instance orm + storage", () => {
    const span = spanBetween(
      src("agents/trading-agent.ts"),
      "async handleA2A(",
      "dispatchTradingA2A("
    );
    expect(span).toContain("this.getOrm()");
    expect(span).toContain("this.ctx.storage");
  });
});

describe("source pins: NLQ mcp-mode coverage (scope update — fully in scope)", () => {
  it("NLQ mcp mode passes storage (no exception; ports/stores/runners stay absent)", () => {
    const fileSrc = src("agents/routes/mcpChatNlq.ts");
    const mcpIdx = fileSrc.indexOf('resolvedNlqMode.mode === "mcp"');
    expect(mcpIdx).toBeGreaterThan(-1);
    const span = fileSrc.slice(mcpIdx, fileSrc.indexOf(": await executeNaturalLanguageQuery(", mcpIdx));
    expect(span).toContain("storage: ctx.getStorage?.()");
    expect(span).not.toContain("stockScreenPort");
    expect(span).not.toContain("scanRunStore");
  });
});

describe("goal-screen leg (new construction, scope update — fully in scope)", () => {
  it("handler constructs a seamed listings stockScreener from the goal bundle (Red pin)", () => {
    const fileSrc = src("agents/screener-agent.ts");
    // Issue #4279 (#3550 S4): the goal bundle is built and bound before the run,
    // and the seamed listings screener is constructed from it at the single site
    // that owns the fallback. The slice from the bundle block to the run call no
    // longer contains the construction — the helper extraction moved it below —
    // so the assertions anchor on the construction site itself.
    expect(fileSrc).toContain("let goalUniverseDeps");
    expect(fileSrc).toContain("nasdaqUniverseRouteBundle({");
    expect(fileSrc).toContain(
      "bindNasdaqUniverseDeps(goalNasdaqProvider, goalBundle.runContext)",
    );
    const idx = fileSrc.indexOf("if (!stockScreener && goalBundle)");
    expect(idx).toBeGreaterThan(-1);
    const span = fileSrc.slice(idx, idx + 400);
    expect(span).toContain("createLiveStockScreener");
    expect(span).toContain("universeRoute: goalBundle");
  });

  it("seamed listings screener fetches + captures (mechanism, passes on control — disclosed)", async () => {
    await withFetchMocks(async () => {
      const { nasdaqUniverseRouteBundle } = await import("../src/trading/screenerPipeline");
      const { createLiveStockScreener } = await import("../src/services/screeningRuntime");
      const { DynamicMarketScreener } = await import("../src/trading/screener");
      const sql = new MockSqlStorage();
      ensureCaptureTable(sql as never);
      const blob = fakeBlobStorage();
      const bundle = await nasdaqUniverseRouteBundle({
        sql: sql as never,
        storage: blob as never,
        env: {} as never,
        userLogin: "tester",
        runId: "run-goal-screen-1686",
      });
      const screener = createLiveStockScreener(new DynamicMarketScreener(), { universeRoute: bundle });
      const result: any = await screener.screenMarkets({});
      expect(result.discovery?.error).toBeUndefined();
      expect(Array.isArray(result.stocks) && result.stocks.length).toBeGreaterThan(0);
      expect(countCaptures(sql)).toBeGreaterThan(0);
      expect(blob.puts()).toBeGreaterThan(0);
    });
  });

  it("unseamed listings screener still returns the missing-seam error (contract, passes on control — disclosed)", async () => {
    await withFetchMocks(async () => {
      const { createLiveStockScreener } = await import("../src/services/screeningRuntime");
      const { DynamicMarketScreener } = await import("../src/trading/screener");
      const screener = createLiveStockScreener(new DynamicMarketScreener());
      const result: any = await screener.screenMarkets({});
      expect(result.discovery?.error).toBeDefined();
    });
  });
});

describe("already-capturing verification (passes on control too — disclosed)", () => {
  it("async-job NLQ passes a stock-screen port (the #1661-closed path)", () => {
    const fileSrc = src("agents/orchestrator/asyncJobs.ts");
    // #3907: the NLQ call is now raced against the execution deadline
    // (`await Promise.race([..., executionDeadline.promise])`), so the
    // `await` no longer sits on the call itself. Pin the call, not the
    // await — the intent is unchanged: the async-job NLQ path passes a
    // stock-screen port.
    const idx = fileSrc.indexOf("executeNaturalLanguageQuery(");
    expect(idx).toBeGreaterThan(-1);
    const span = fileSrc.slice(idx, fileSrc.indexOf(");", idx));
    expect(span).toContain("stockScreenPort");
  });
});

describe("source pins: asyncJobs mcp.tool mount (parent-gate addition)", () => {
  // The mcp.tool job literal cannot be executing-pinned in vitest:
  // executeAsyncJob's claim UPDATE needs `rowsWritten`, which
  // MockSqlStorage never returns, so the job never runs under the
  // mock (it returns early, silently). The literal below is therefore
  // source-pinned; the mechanism it feeds (storage -> scan -> capture)
  // is executing-pinned by the MCP leg pin above. Never claim this
  // pin alone proves a job scan captures.
  it("mcp.tool branch passes ctx.agentCtx.storage into executeMCPTool", () => {
    const fileSrc = src("agents/orchestrator/asyncJobs.ts");
    const span = spanBetween(fileSrc, '} else if (job.capability === "mcp.tool")', "});");
    expect(span).toContain("storage: ctx.agentCtx.storage");
  });
});
