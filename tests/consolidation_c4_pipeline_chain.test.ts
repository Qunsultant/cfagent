/**
 * Consolidation C4 (issue #1329, epic #1151) — one generate/store/serve
 * pipeline + #1236 C4 remainder (stage-chain extension).
 *
 * What is pinned here:
 *  - Pipeline stages are separately callable: generateReportStage
 *    (ReportAssetAgent call + retry policy, as runReportPipeline does
 *    today), storeReportStage (the shared canonical mas_reports write
 *    the callers previously inlined), serveReportStage (canonical-row
 *    + artifact-key verification). runReportPipeline keeps its exact
 *    output (it is the generate entry; the fused path is unchanged).
 *  - The ReportAssetAgent dispatches through the pipeline's
 *    generateReportPdf — no direct trading-generator call remains in
 *    the agent (source pin; the single-PDF-path pin in
 *    single_pdf_path_s4.test.ts is updated in the same PR).
 *  - Every run kind stores a canonical report: discovery runs gain a
 *    mas_reports row (source "discovery", body.discoveryRunId), and
 *    GET /api/runs de-duplicates discovery twins exactly (canonical
 *    twin wins, as for scans/screens).
 *  - Retention is one recorded contract (RUN_STORE_RETENTION_CONTRACT):
 *    mas_reports KEEP; detail stores prune 365d + caps; a run kind's
 *    detail row is never its sole record (canonical row exists).
 *  - Stage-chain extension: stageChain is accepted on
 *    options/discovery/goal criteria (C3 rejected it there); the
 *    planners stamp serve/deliver stages for options + discovery +
 *    goal outcomes; deliverViaChain=false plans no deliveries (the
 *    run's delivery stays on its direct path); options bus events
 *    carry pdfKey + stageChain into the outcome; generic http.request
 *    jobs carrying stageChain resolve a chain context (identity) while
 *    only recognized screener completions plan serve/deliver.
 *  - Decisions recorded on #1329: stages begin at generate (no stored
 *    feed artifact seam exists); serve = canonical publication +
 *    artifact verification (the followup.report adoption job).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
  assetCalls: 0,
  assetQueue: [] as Array<unknown>,
}));

vi.mock("../src/agents/report-asset-agent", () => ({
  generatePdfAsset: vi.fn(async () => {
    hoisted.assetCalls++;
    return hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift() : null;
  }),
  generatePdfAssetOutcome: vi.fn(async () => {
    hoisted.assetCalls++;
    const asset = hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift() : null;
    return asset
      ? { status: "generated", asset }
      : { status: "failed", error: "REPORT_ASSET_GENERATION_FAILED: mock returned no asset." };
  }),
}));

import {
  generateReportStage,
  runReportPipeline,
  serveReportStage,
  storeReportStage,
} from "../src/services/unifiedReportPipeline";
import {
  mergeRunSummaries,
  runSummaryFromReport,
} from "../src/services/runSummaries";
import { RUN_STORE_RETENTION_CONTRACT } from "../src/security/storageRetention";
import { buildSchedulePayload } from "../src/trading/screeningSchemas";
import {
  planDeliveryFollowups,
  planInitialFollowups,
  resolveScreenerFollowupConfig,
  resolveHttpJobChain,
  screenerOutcomeFromEvent,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  recordScreenerRunMainJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

const identity = { userLogin: "default_trader", environment: "TEST" } as const;

/* ------------------------------------------------------------------ */
/* Minimal fake SQL for the bridge (INSERT/DELETE/SELECT, single-line  */
/* INSERT idiom honored by production code).                           */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

class C4FakeSql {
  tables: Record<string, Row[]> = { mas_async_jobs: [], mas_screening_activity: [] };

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Row> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Row[], rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    if (/^DELETE FROM/i.test(q)) return wrap([]);
    if (/^INSERT INTO/i.test(q)) {
      const table = q.match(/INSERT INTO (\w+)/i)![1];
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Row = {};
      let ai = 0;
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      }
      (this.tables[table] ??= []).push(row);
      return wrap([], 1);
    }
    if (/^SELECT/i.test(q)) {
      const m = q.match(/SELECT (.+?) FROM (\w+)/i);
      if (!m) return wrap([]);
      const cols = m[1].split(",").map((c) => c.trim());
      let rows = [...(this.tables[m[2]] ?? [])];
      const wherePart = (q.split(/ WHERE /i)[1] ?? "").split(/ ORDER BY /i)[0];
      let ai = 0;
      for (const cond of wherePart.split(/ AND /i)) {
        const cm = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (cm) {
          const val = cm[2] === "?" ? args[ai++] : cm[2].replace(/^'|'$/g, "");
          rows = rows.filter((r) => r[cm[1]] === val);
        }
      }
      const out = rows.map((r) => {
        if (cols.length === 1 && cols[0] === "*") return r;
        const o: Row = {};
        for (const c of cols) {
          const name = c.includes(".") ? c.split(".").pop()! : c;
          o[name] = r[name] ?? null;
        }
        return o;
      });
      return wrap(out);
    }
    return wrap([]);
  }
}

function bridgeCtx(sql: C4FakeSql): AsyncJobsContext {
  return {
    ensureTables: () => sql as any,
    sessionKey: () => "default_trader",
    schedule: async () => undefined,
    audit: () => undefined,
    getOrm: () => undefined as any,
    routeRequest: async () => new Response(""),
    nlqSchedulingPort: () => undefined as any,
    nlqStockScreenPort: () => undefined as any,
    followupReportPort: () => ({
      getStockPdf: async () => null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "conf-1",
    agentCtx: { storage: { sql: sql as any } },
    env: {},
  } as unknown as AsyncJobsContext;
}

/* ------------------------------------------------------------------ */
/* Pipeline stages                                                     */
/* ------------------------------------------------------------------ */

describe("C4 pipeline stage split (#1329)", () => {
  beforeEach(() => {
    hoisted.assetCalls = 0;
    hoisted.assetQueue = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const INPUT = {
    type: "screener" as const,
    trigger: "manual" as const,
    result: { provider: "yahoo" },
    userLogin: "default_trader",
    title: "Market screen — NASDAQ100",
    summary: "Scanned 25 symbols, 25 matched.",
    timestamp: "2026-10-24T00:00:00.000Z",
  };

  it("generateReportStage returns the pipeline's generate output", async () => {
    hoisted.assetQueue = [{ key: "report:pdf:screener:c4gen01", fileName: "m.pdf" }];
    const out = await generateReportStage({} as any, INPUT as any);
    expect(out).toEqual({
      pdfKey: "report:pdf:screener:c4gen01",
      generationId: "screener:manual:2026-10-24T00:00:00.000Z",
      pdfStatus: "generated",
    });
  });

  it("generateReportStage failure is coded, never thrown", async () => {
    hoisted.assetQueue = [];
    const out = await generateReportStage(
      { PIPELINE_REPORT_RETRY_ATTEMPTS: "1" } as any,
      INPUT as any,
    );
    expect(out.pdfStatus).toBe("failed");
    expect(out.pdfKey).toBe("");
    expect(out.pdfError ?? "").toMatch(/^\[FAILURE_REPORT_PDF_GENERATION\]/);
  });

  it("runReportPipeline output is unchanged (the fused generate entry)", async () => {
    hoisted.assetQueue = [{ key: "report:pdf:screener:c4fused", fileName: "m.pdf" }];
    const out = await runReportPipeline({} as any, { put: async () => {}, get: async () => undefined } as any, INPUT as any);
    expect(out.pdfKey).toBe("report:pdf:screener:c4fused");
    expect(out.generationId).toBe("screener:manual:2026-10-24T00:00:00.000Z");
    expect(out.pdfStatus).toBe("generated");
  });

  it("storeReportStage writes the canonical row and returns its id", () => {
    const recorded: any[] = [];
    const orm = {
      storeCanonicalReport: (input: any) => {
        recorded.push(input);
        return { reportId: "rep-c4-1", created: true };
      },
    };
    const res = storeReportStage(orm as any, {
      runId: "discovery:run-1",
      generationId: "discovery:run-1",
      title: "Strategy discovery — no-view",
      source: "discovery",
      summary: "3 completed, 0 failed.",
      body: { discoveryRunId: "run-1", completedCount: 3 },
      createdAt: "2026-10-24T00:00:00.000Z",
    });
    expect(res).toEqual({ reportId: "rep-c4-1", created: true });
    expect(recorded[0].source).toBe("discovery");
    expect(recorded[0].body.discoveryRunId).toBe("run-1");
  });

  it("storeReportStage without an ORM returns null, never throws", () => {
    expect(
      storeReportStage(undefined as any, {
        runId: "x",
        generationId: "x",
        title: "t",
        source: "discovery",
        summary: "s",
        body: {},
        createdAt: "2026-10-24T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("serveReportStage verifies a canonical row, fails explicitly when missing", async () => {
    const found = await serveReportStage({
      canonicalReportId: "rep-c4-1",
      findCanonicalReport: async (id: string) => (id === "rep-c4-1" ? { id } : null),
    });
    expect(found.verified).toBe(true);
    const missing = await serveReportStage({
      canonicalReportId: "rep-gone",
      findCanonicalReport: async () => null,
    });
    expect(missing.verified).toBe(false);
    expect(missing.reason ?? "").toMatch(/canonical report/i);
  });

  it("serveReportStage fails when a named pdfKey does not resolve", async () => {
    const res = await serveReportStage({
      pdfKey: "report:pdf:gone",
      resolvePdfKey: async () => null,
    });
    expect(res.verified).toBe(false);
  });

  it("ReportAssetAgent dispatches through generateReportPdf (source pin)", () => {
    const src = readFileSync(join(__dirname, "../src/agents/report-asset-agent.ts"), "utf8");
    expect(src).toContain("generateReportPdf");
    expect(src).not.toContain("generateOptionsPdf(");
    expect(src).not.toContain("generateScreenerPdf(");
    expect(src).not.toContain("generateResearchPdf(");
  });
});

/* ------------------------------------------------------------------ */
/* Canonical discovery + Runs de-duplication                           */
/* ------------------------------------------------------------------ */

describe("C4 canonical discovery reports + Runs (#1329)", () => {
  it("a canonical discovery row maps to kind discovery", () => {
    const row = runSummaryFromReport({
      id: "rep-c4-1",
      runId: "discovery:run-1",
      source: "discovery",
      title: "Strategy discovery — no-view",
      summary: "3 completed.",
      body: JSON.stringify({ discoveryRunId: "run-1", trigger: "scheduled" }),
      createdAt: "2026-10-24T00:00:00.000Z",
    } as any);
    expect(row.kind).toBe("discovery");
    expect(row.reportId).toBe("rep-c4-1");
  });

  it("a canonical discovery twin absorbs its detail row exactly once", () => {
    const canonical = runSummaryFromReport({
      id: "rep-c4-1",
      runId: "discovery:run-1",
      source: "discovery",
      title: "Strategy discovery — no-view",
      summary: "3 completed.",
      body: JSON.stringify({ discoveryRunId: "run-1" }),
      createdAt: "2026-10-24T00:00:00.000Z",
    } as any);
    const detail = {
      kind: "discovery" as const,
      id: "run-1",
      runId: "run-1",
      title: "Strategy discovery — no-view",
      summary: "3 completed, 0 failed.",
      trigger: "scheduled",
      createdAt: "2026-10-24T00:00:00.000Z",
      status: "completed",
      resultCount: 3,
      pdfKey: null,
      reportUrl: null,
      pdfStatus: null,
      pdfError: null,
      reportId: null,
      scanRunId: null,
      discoveryRunId: "run-1",
      source: "discovery",
    };
    const merged = mergeRunSummaries([[canonical], [detail]], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].reportId).toBe("rep-c4-1");
    expect(merged[0].id).toBe("rep-c4-1");
  });
});

/* ------------------------------------------------------------------ */
/* Retention contract                                                  */
/* ------------------------------------------------------------------ */

describe("C4 retention contract (#1329)", () => {
  it("records one window per run store", () => {
    expect(RUN_STORE_RETENTION_CONTRACT.mas_reports).toBe("keep");
    expect(RUN_STORE_RETENTION_CONTRACT.mas_opportunity_scans).toBe("365d+caps");
    expect(RUN_STORE_RETENTION_CONTRACT.mas_discovery_runs).toBe("365d+caps");
    expect(RUN_STORE_RETENTION_CONTRACT.mas_async_jobs).toBe("30d+500cap");
  });
});

/* ------------------------------------------------------------------ */
/* Stage-chain extension                                               */
/* ------------------------------------------------------------------ */

describe("C4 stage-chain extension (#1329)", () => {
  const chain = { serveDelaySeconds: 60, deliverDelaySeconds: 3600 };

  it("accepts stageChain on options/discovery/goal criteria", () => {
    const opt = buildSchedulePayload("autonomousOptionsAnalysis", { symbols: ["AAA"], stageChain: chain }, identity);
    expect(opt.ok).toBe(true);
    if (opt.ok) expect(opt.value.stageChain).toEqual(chain);
    const disc = buildSchedulePayload(
      "autonomousStrategyDiscovery",
      { inputModel: "no-view", constraintSets: [{ symbol: "AAA" }], stageChain: chain } as any,
      identity,
    );
    // No-view constraint sets still validate on their own fields; the
    // assertion here is only that stageChain is not the rejection.
    if (!disc.ok) expect(disc.error).not.toContain("stageChain");
    const goal = buildSchedulePayload("autonomousGoalScreen", { goalKind: "income", stageChain: chain }, identity);
    expect(goal.ok).toBe(true);
    if (goal.ok) expect(goal.value.stageChain).toEqual(chain);
  });

  it("rejects out-of-range stage delays on options criteria too", () => {
    const built = buildSchedulePayload(
      "autonomousOptionsAnalysis",
      { symbols: ["AAA"], stageChain: { serveDelaySeconds: 604_801 } },
      identity,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("stageChain");
  });

  it("plans serve/deliver stages for options + discovery + goal outcomes", () => {
    const config = resolveScreenerFollowupConfig({});
    const ctx = { chainId: "chain-c4-1", nowIso: "2026-10-24T00:00:00.000Z" };
    for (const kind of ["options", "discovery", "goal"] as const) {
      const outcome = {
        kind,
        trigger: "scheduled" as const,
        success: true,
        pdfKeys: [],
        stageChain: chain,
      } as unknown as ScreenerRunOutcome;
      const specs = planInitialFollowups(outcome, config, "main-c4-1", "default_trader", ctx);
      expect(specs).toHaveLength(1);
      expect((specs[0] as any).stage).toBe("serve");
      expect((specs[0] as any).chainId).toBe("chain-c4-1");
      expect((specs[0] as any).runAt).toBe("2026-10-24T00:01:00.000Z");
    }
  });

  it("plans no deliveries when deliverViaChain is false", () => {
    const config = resolveScreenerFollowupConfig({ SCREENER_EMAIL_TO: "a@b.c" });
    const outcome = {
      kind: "discovery",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      deliverViaChain: false,
    } as unknown as ScreenerRunOutcome;
    expect(planDeliveryFollowups(outcome, config, { status: "ready", artifacts: [] } as any, "main-c4-1", "default_trader")).toEqual([]);
  });

  it("options bus events carry pdfKey + stageChain into the outcome", () => {
    const outcome = screenerOutcomeFromEvent({
      type: "options.completed",
      timestamp: "2026-10-24T00:00:00.000Z",
      trigger: "scheduled",
      thesis: "bullish",
      totalScanned: 10,
      withTrades: 3,
      symbols: ["AAA"],
      summary: "ok",
      pdfKey: "report:pdf:options:c4opt",
      stageChain: chain,
    } as any);
    expect(outcome.kind).toBe("options");
    expect(outcome.pdfKeys).toEqual(["report:pdf:options:c4opt"]);
    expect(outcome.stageChain).toEqual(chain);
  });

  it("resolves a chain context for staged http.request jobs, none otherwise", () => {
    expect(
      resolveHttpJobChain({ stage: "generate", chainId: "chain-c4-9" }, { stageChain: chain }),
    ).toEqual({ chainId: "chain-c4-9", stageChain: chain });
    expect(resolveHttpJobChain({}, {})).toBeUndefined();
    expect(resolveHttpJobChain({ stage: "generate", chainId: "chain-c4-9" }, {})).toBeUndefined();
  });

  it("bridges a discovery chain: generate main row + serve stage, no deliver rows", async () => {
    const sql = new C4FakeSql();
    const ctx = bridgeCtx(sql);
    const jobId = await recordScreenerRunMainJob(
      ctx,
      {
        kind: "discovery",
        trigger: "scheduled",
        success: true,
        pdfKeys: [],
        canonicalReportId: "rep-c4-1",
        stageChain: chain,
      } as unknown as ScreenerRunOutcome,
      "default_trader",
      { chainReport: true },
    );
    const jobs = sql.tables.mas_async_jobs;
    const main = jobs.find((j) => j.job_id === jobId);
    expect(main?.stage).toBe("generate");
    expect(typeof main?.chain_id).toBe("string");
    const serve = jobs.find((j) => j.capability === "followup.report");
    expect(serve?.stage).toBe("serve");
    expect(serve?.chain_id).toBe(main?.chain_id);
    expect(jobs.filter((j) => j.capability === "followup.deliver")).toHaveLength(0);
  });
});
