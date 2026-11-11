/**
 * Issue #1023 (screening consolidation S4, umbrella #958): ONE PDF path.
 *
 * Pins:
 *  (a) No production file outside the unified report pipeline
 *      (src/services/unifiedReportPipeline.ts) and the generator
 *      definition modules (src/trading/*ReportPdf.ts) CALLS a direct PDF
 *      generator (generateOptionsPdf / generateScreenerPdf /
 *      generateResearchPdf). Call-level pins — comments do not satisfy
 *      them (house idiom). Consolidation C4 (#1329) completed the
 *      epic's "report-asset-agent's direct PDF call moves behind
 *      runReportPipeline" item: the ReportAssetAgent (still the single
 *      owner of the generate step, #680) now dispatches through the
 *      pipeline's generateReportPdf, so it leaves this allowed set —
 *      the pipeline is the ONE generator dispatch.
 *  (b) ScreenerAgent.persistRun has no direct-generator fallback: on
 *      pipeline failure it records pdfStatus "failed" (the #822 contract)
 *      instead of generating behind the pipeline's back. And
 *      storeOptionsPdf — the manual store seam of the old dual path —
 *      is gone from production code entirely (no callers remain).
 *  (c) The manual options routes (POST /trading/options/screen and
 *      POST /trading/options/unified action=opportunities) generate
 *      through the unified pipeline seam: runReportPipeline is invoked
 *      with type "options" / trigger "manual", the response and the
 *      canonical report carry the pipeline's pdfKey, the reportUrl
 *      addresses /api/options/report.pdf?key=<pipeline key>, and the
 *      artifact serves through that download route. On pipeline failure
 *      the routes surface NO pdfKey/reportUrl (no fallback generation,
 *      no fabricated link) while the run itself still succeeds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MockSqlStorage } from "./mock-sql";

/* ------------------------------------------------------------------ */
/* Mocks (route behaviour pins)                                        */
/* ------------------------------------------------------------------ */

const hoisted = vi.hoisted(() => ({
  pipelineCalls: [] as any[],
  pipelineResult: {
    pdfKey: "report:pdf:options:s4mock01",
    generationId: "options:manual:2026-10-22T00:00:00.000Z",
    pdfStatus: "generated",
  } as any,
  unifiedRequests: [] as any[],
  storeOptionsPdfCalls: [] as any[],
  canonicalReports: [] as any[],
  // #3186 (optional 500 pin): when true the fake fetchChains throws,
  // so the pipeline fails at chainFetch and the route surfaces a 500
  // naming the failed stage.
  failFetchChains: false,
}));

vi.mock("agents", () => ({ Agent: class {} }));

vi.mock("../src/services/unifiedReportPipeline", () => ({
  runReportPipeline: vi.fn(async (_env: any, _storage: any, input: any) => {
    hoisted.pipelineCalls.push(input);
    return hoisted.pipelineResult;
  }),
}));

vi.mock("../src/services/etrade", () => ({
  ETradeService: class FakeETradeService {
    client = {};
    constructor(..._args: unknown[]) {}
  },
}));

// Rich screen result (the shape generateOptionsPdf renders — so the OLD
// fallback path, if it still existed, would succeed and produce a key;
// the pins below then discriminate).
//
// #3186: the manual screen no longer calls screenOptions — the one
// options pipeline's chainFetch stage calls fetchChains(filter), and
// enrich runs the REAL evaluateContracts/aggregateScreenResult over the
// returned chains (the mock spreads the real module via importOriginal
// so those stay real; a factory returning only the fake class would
// leave them undefined and the enrich stage would throw). The fake
// chain below carries exactly ONE passing leg (NVDA CALL, strike =
// spot, bid 12.5 / ask 13.0, delta 0.45), so the engine aggregates to
// matchedCount 1 — the same count the old canned screenOptions result
// carried. screenOptions is KEPT: the scanner path (#23, unified
// opportunities) reaches the engine through OptionsDataAgent.loadSnapshot
// -> screener.screenOptions, and returns the same single contract.
vi.mock("../src/trading/optionsScreener", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class FakeDynamicOptionsScreener {
    constructor(_client: unknown) {}
    async fetchChains(filter: any) {
      if (hoisted.failFetchChains) throw new Error("chain fetch boom");
      const symbols: string[] = filter?.underlyingSymbols ?? ["NVDA"];
      const expiry = new Date(Date.now() + 30 * 86400000);
      const chainFor = (symbol: string) => ({
        symbol,
        underlyingPrice: 200,
        selectedExpiry: {
          year: expiry.getUTCFullYear(),
          month: expiry.getUTCMonth() + 1,
          day: expiry.getUTCDate(),
        },
        pairs: [
          {
            call: {
              timeStamp: Date.now(),
              adjustedFlag: false,
              optionType: "CALL",
              strikePrice: 200,
              symbol: `${symbol}200C`,
              bid: 12.5,
              ask: 13.0,
              lastPrice: 12.75,
              volume: 1000,
              openInterest: 2000,
              delta: 0.45,
              gamma: 0.02,
              theta: -0.03,
              impliedVolatility: 0.35,
            },
          },
        ],
      });
      return {
        chains: symbols.map((symbol) => ({ symbol, chain: chainFor(symbol) })),
        filter,
        fetchErrors: [],
        deferredSymbols: [],
        symbols,
        warnings: [],
      };
    }
    async screenOptions(_filter: any) {
      return {
        contracts: [
          {
            symbol: "NVDA_261023C200",
            underlyingSymbol: "NVDA",
            expirationDate: "2026-10-23",
            strikePrice: 200,
            optionType: "CALL",
            delta: 0.45,
            impliedVolatility: 0.35,
            bid: 12.5,
            ask: 13.0,
          },
        ],
        totalUnderlyingsScanned: 2,
        totalContractsEvaluated: 10,
        matchedCount: 1,
        filterSummary: "delta >= 0.30",
        screenedAt: "2026-10-22T00:00:00.000Z",
        fetchErrors: [],
        warnings: [],
      };
    }
    evaluateChains() {
      throw new Error("not used in these tests");
    }
  }
  return { ...actual, DynamicOptionsScreener: FakeDynamicOptionsScreener };
});

vi.mock("../src/services/eventCalendar", () => ({
  getEventCalendarCoverage: async () => ({ bySymbol: new Map() }),
  getSymbolEventCalendar: async () => null,
  toEventCalendarInfo: (x: any) => x,
}));

vi.mock("../src/trading", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  class FakeUnifiedOptionsService {
    constructor(..._args: unknown[]) {}
    // #3186: the unified opportunities handler no longer calls execute()
    // for opportunities — it calls these three seams, then runs the one
    // options pipeline. The canned formatResponse shape is the one the
    // old execute() fake returned, so the downstream PDF/XLSX/CSV +
    // Slack + canonical code runs on the same shape as before.
    async resolveStrategyProfile(_req: any) {
      return { profile: undefined, error: undefined };
    }
    async resolveEngineClient() {
      return { engineClient: {} };
    }
    formatResponse(_req: any, _data: any, _summary: any, _cached: boolean) {
      return {
        success: true,
        data: { scanned: 3, withTrades: 1, opportunities: [{ symbol: "NVDA" }], matchedCount: 1 },
        summary: "fake unified summary",
        toSlack: () => "fake slack text",
        toWebhook: () => ({ fake: "webhook" }),
        toUi: () => ({ mode: "fake-ui" }),
        toEmailHtml: () => "",
        toEmailText: () => "",
        toVoice: () => ({}),
        toMcp: () => ({}),
      };
    }
    async execute(req: any) {
      hoisted.unifiedRequests.push(req);
      return {
        success: true,
        data: { scanned: 3, withTrades: 1, opportunities: [{ symbol: "NVDA" }], matchedCount: 1 },
        summary: "fake unified summary",
        toSlack: () => "fake slack text",
        toWebhook: () => ({ fake: "webhook" }),
        toUi: () => ({ mode: "fake-ui" }),
        toEmailHtml: () => "",
        toEmailText: () => "",
        toVoice: () => ({}),
        toMcp: () => ({}),
      };
    }
  }
  return { ...actual, UnifiedOptionsService: FakeUnifiedOptionsService };
});

import { handleEtradeOptionsRoutes } from "../src/agents/routes/etradeOptions";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";

const PIPELINE_KEY = "report:pdf:options:s4mock01";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

function fakeScreenerAgent() {
  return {
    async getPdfByKey(key: string) {
      return key === PIPELINE_KEY ? { bytes: PDF_BYTES, fileName: "options-scan_mock.pdf" } : null;
    },
    async getOptionsPdfByKey(key: string) {
      return key === PIPELINE_KEY ? { bytes: PDF_BYTES, fileName: "options-scan_mock.pdf" } : null;
    },
    async storeOptionsPdf(base64: string, fileName: string) {
      hoisted.storeOptionsPdfCalls.push({ base64, fileName });
      return "options-pdf:legacy.pdf";
    },
  };
}

function optionsCtx() {
  const sql = new MockSqlStorage();
  // #3186: the pipeline persists all 8 stage artifacts via
  // storage.put/get, so the ctx storage is Map-backed (the
  // tests/manual_options_screen_workflow_3186.test.ts pattern);
  // sql-only storage dies at plan.persist.
  const store = new Map<string, unknown>();
  // Issue #4060: the manual entry writes its canonical row through
  // the engine's leg (the orchestrator door), so the fake ctx
  // supplies the door — a namespace whose record writes through the
  // same fake store the direct ORM used, so the pin keeps capturing
  // both writes (persist + shapeReport re-record, one generationId).
  // The fake dedupes by generationId like the real seam (first
  // write created:true, re-record created:false, one reportId).
  const seenGenerations = new Set<string>();
  const storeCanonicalReport = (report: any) => {
    hoisted.canonicalReports.push(report);
    const generationId = String(report?.generationId ?? "");
    const created = !seenGenerations.has(generationId);
    seenGenerations.add(generationId);
    return { reportId: "report-1", created };
  };
  return {
    env: {
      ORCHESTRATOR_AGENT: {
        idFromName: (name: string) => name,
        get: () => ({
          recordPipelineGenerateReport: async (input: any) => storeCanonicalReport(input),
        }),
      },
    } as any,
    getOrm: () => ({ storeCanonicalReport }) as any,
    agentCtx: {
      storage: {
        sql,
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
    },
    ensureTables: () => sql,
    audit: () => {},
    getScreenerAgent: () => fakeScreenerAgent(),
    requestedEnv: undefined,
  } as any;
}

const post = (path: string, body: unknown) =>
  new Request(`https://agent.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-login": "alice" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  hoisted.pipelineCalls.length = 0;
  hoisted.unifiedRequests.length = 0;
  hoisted.storeOptionsPdfCalls.length = 0;
  hoisted.canonicalReports.length = 0;
  hoisted.failFetchChains = false;
  hoisted.pipelineResult = {
    pdfKey: PIPELINE_KEY,
    generationId: "options:manual:2026-10-22T00:00:00.000Z",
    pdfStatus: "generated",
  };
});

/* ------------------------------------------------------------------ */
/* (c) Route behaviour: manual options routes use the pipeline seam    */
/* ------------------------------------------------------------------ */

describe("#1023 manual options routes generate through the unified pipeline", () => {
  it("POST /trading/options/screen: pipeline invoked (options/manual), response + canonical carry its key", async () => {
    const req = post("/api/trading/options/screen", { underlyingSymbols: ["NVDA"], pushToSlack: false });
    const res = await handleEtradeOptionsRoutes(req, new URL(req.url), "/api/trading/options/screen", "sess-1", optionsCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;

    expect(hoisted.pipelineCalls).toHaveLength(1);
    expect(hoisted.pipelineCalls[0]).toMatchObject({ type: "options", trigger: "manual", userLogin: "alice" });
    expect(hoisted.pipelineCalls[0].result).toMatchObject({ matchedCount: 1 });

    expect(body.pdfKey).toBe(PIPELINE_KEY);
    expect(body.reportUrl).toBe(`/api/options/report.pdf?key=${encodeURIComponent(PIPELINE_KEY)}`);
    expect(hoisted.storeOptionsPdfCalls).toHaveLength(0);

    // #3186: the canonical row is written TWICE under one generationId —
    // the persist stage records the run (no artifact keys yet), then the
    // shapeReport stage re-records the same generationId with the
    // pipeline's pdfKey/reportUrl (#2602 backfill). The old pin asserted
    // a single write carrying the key; the new pin proves one row, two
    // writes, and that the LAST write carries the key.
    expect(hoisted.canonicalReports).toHaveLength(2);
    expect(hoisted.canonicalReports[0].generationId).toBe(hoisted.canonicalReports[1].generationId);
    expect(hoisted.canonicalReports[0].body.pdfKey).toBeUndefined();
    expect(hoisted.canonicalReports[1].body.pdfKey).toBe(PIPELINE_KEY);
    expect(hoisted.canonicalReports[1].body.reportUrl).toBe(body.reportUrl);
  });

  it("POST /trading/options/unified (opportunities): pipeline invoked, reportUrl + canonical carry its key", async () => {
    const req = post("/api/trading/options/unified", {
      action: "opportunities",
      symbols: ["NVDA", "AAPL"],
      mode: "per_name_best",
      maxSymbols: 10,
      pushToSlack: false,
    });
    const res = await handleEtradeOptionsRoutes(req, new URL(req.url), "/api/trading/options/unified", "sess-1", optionsCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;

    // #3186: the retired execute() seam is gone for opportunities — the
    // handler runs the one options pipeline instead, so no execute() call
    // is recorded. The pipeline run itself is pinned by pipelineCalls
    // below; this test proves the unified opportunities path still
    // generates through the pipeline and carries its key.
    expect(hoisted.unifiedRequests).toHaveLength(0);
    expect(hoisted.pipelineCalls).toHaveLength(1);
    expect(hoisted.pipelineCalls[0]).toMatchObject({ type: "options", trigger: "manual", userLogin: "alice" });

    expect(body.reportUrl).toBe(`/api/options/report.pdf?key=${encodeURIComponent(PIPELINE_KEY)}`);
    expect(hoisted.storeOptionsPdfCalls).toHaveLength(0);

    expect(hoisted.canonicalReports).toHaveLength(1);
    expect(hoisted.canonicalReports[0].body.pdfKey).toBe(PIPELINE_KEY);
    expect(hoisted.canonicalReports[0].body.reportUrl).toBe(body.reportUrl);
  });

  it("pipeline failure surfaces honestly: run succeeds, NO pdfKey/reportUrl, NO fallback generation", async () => {
    hoisted.pipelineResult = { pdfKey: "", generationId: "options:manual:x", pdfStatus: "failed", pdfError: "asset agent down" };
    const req = post("/api/trading/options/screen", { underlyingSymbols: ["NVDA"], pushToSlack: false });
    const res = await handleEtradeOptionsRoutes(req, new URL(req.url), "/api/trading/options/screen", "sess-1", optionsCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.matchedCount).toBe(1);
    expect(body.pdfKey).toBeUndefined();
    expect(body.reportUrl).toBeUndefined();
    expect(hoisted.storeOptionsPdfCalls).toHaveLength(0);
  });

  it("pipeline-stage failure surfaces as a 500 naming the failed stage", async () => {
    // #3186: a stage that throws fails the run with its stage name; the
    // route throws (no fallback generation from a partial run) and the
    // handler shapes it as a 500 carrying "options screen failed at
    // <stage>".
    hoisted.failFetchChains = true;
    const req = post("/api/trading/options/screen", { underlyingSymbols: ["NVDA"], pushToSlack: false });
    const res = await handleEtradeOptionsRoutes(req, new URL(req.url), "/api/trading/options/screen", "sess-1", optionsCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("options screen failed at chainFetch");
    expect(body.pdfKey).toBeUndefined();
    expect(hoisted.storeOptionsPdfCalls).toHaveLength(0);
  });

  it("the pipeline artifact serves through GET /api/options/report.pdf?key=", async () => {
    const req = new Request(`https://agent.test/api/options/report.pdf?key=${encodeURIComponent(PIPELINE_KEY)}`, {
      method: "GET",
      headers: { "x-user-login": "alice" },
    });
    const ctx: any = {
      getScreenerAgent: () => fakeScreenerAgent(),
      getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
    };
    const res = (await handleScreenerResearchRoutes(req, new URL(req.url), "/api/options/report.pdf", "sess-1", ctx)) as Response;
    expect(res).not.toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF_BYTES);
  });
});

/* ------------------------------------------------------------------ */
/* (a)+(b) Source pins: one PDF path                                   */
/* ------------------------------------------------------------------ */

const SRC_ROOT = join(process.cwd(), "src");
const listTs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
const rel = (p: string) => p.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");

const ALLOWED_GENERATOR_CALLERS = new Set([
  "services/unifiedReportPipeline.ts", // the pipeline — the ONE dispatch (C4 #1329)
  "trading/optionsReportPdf.ts", // generator definitions
  "trading/screenerReportPdf.ts",
  "trading/researchReportPdf.ts",
]);
const GENERATOR_CALL = /\bgenerate(?:Options|Screener|Research)Pdf\s*\(/;

describe("#1023 one PDF path — source pins", () => {
  it("(a) no production file outside the pipeline/owner/definitions calls a direct PDF generator", () => {
    const offenders: string[] = [];
    for (const file of listTs(SRC_ROOT)) {
      const r = rel(file);
      if (ALLOWED_GENERATOR_CALLERS.has(r)) continue;
      // The definition modules re-export through the trading barrel; the
      // barrel itself never calls the generators.
      const srcText = readFileSync(file, "utf8");
      if (GENERATOR_CALL.test(srcText)) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  it("(a) the pipeline remains the only dispatch, and the ReportAssetAgent dispatches through it", () => {
    // Guards against the allowed set silently shrinking the pin's value:
    // the pipeline must still be the place that renders, and the agent
    // (the generate step's owner, #680) must reach the generators only
    // through the pipeline's dispatch (C4 #1329).
    const pipeline = readFileSync(join(SRC_ROOT, "services/unifiedReportPipeline.ts"), "utf8");
    expect(pipeline).toMatch(/generateOptionsPdf\s*\(/);
    expect(pipeline).toMatch(/generateScreenerPdf\s*\(/);
    expect(pipeline).toMatch(/generateResearchPdf\s*\(/);
    const owner = readFileSync(join(SRC_ROOT, "agents/report-asset-agent.ts"), "utf8");
    expect(owner).toMatch(/generateReportPdf\s*\(/);
    expect(owner).not.toMatch(/generateOptionsPdf\s*\(/);
    expect(owner).not.toMatch(/generateScreenerPdf\s*\(/);
    expect(owner).not.toMatch(/generateResearchPdf\s*\(/);
  });

  it("(b) persistRun has no direct-generator fallback; failure is recorded, not re-generated", () => {
    const agent = readFileSync(join(SRC_ROOT, "agents/screener-agent.ts"), "utf8");
    const start = agent.indexOf("private async persistRun");
    expect(start).toBeGreaterThan(-1);
    const region = agent.slice(start, start + 9000);
    // Issue #2911 (G4): persistRun reaches the PDF path only through
    // generateRunPdf (shared with regeneration); the pipeline call and
    // the failure recording live in the one generation module, which
    // this pin now checks directly — the intent (one PDF path, the
    // pipeline's own error recorded, no fallback generation) is
    // unchanged, only the file holding the call moved.
    expect(region).toContain("this.generateRunPdf");
    expect(region).not.toMatch(/generateScreenerPdf\s*\(/);
    const module = readFileSync(join(SRC_ROOT, "services/stockReportArtifacts.ts"), "utf8");
    expect(module).toContain("runReportPipeline(");
    expect(module).toContain('result.pdfStatus = "failed"');
    // Exact assignment of the pipeline's own error — ctrl's fallback
    // version reads `= pipelineResult.pdfError || (fallbackErr ...)`.
    expect(module).toContain("result.pdfError = pipelineResult.pdfError;");
  });

  it("(b) storeOptionsPdf is gone from production code (no definition, no callers)", () => {
    const offenders: string[] = [];
    for (const file of listTs(SRC_ROOT)) {
      if (readFileSync(file, "utf8").includes("storeOptionsPdf")) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it("scheduled options analysis generates through the pipeline with no direct fallback", () => {
    const scheduled = readFileSync(join(SRC_ROOT, "services/scheduledTasks.ts"), "utf8");
    expect(scheduled).toContain("runReportPipeline");
    expect(scheduled).not.toMatch(/generateOptionsPdf\s*\(/);
    expect(scheduled).not.toContain("storeOptionsPdf");
  });
});
