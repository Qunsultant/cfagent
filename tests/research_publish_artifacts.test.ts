/**
 * Issue #2167: the research publish seam records the full document set.
 *
 * Pins (TDD red first):
 *  - the canonical `options_research` row is written once, with all three
 *    artifact keys and statuses in its body (today it is written before
 *    generation and carries none);
 *  - a failed PDF leg records `failed` + the coded error while the workbook
 *    and CSV still record theirs;
 *  - a total artifact failure still writes the row (the run is never lost
 *    because its documents were);
 *  - the row stays owner-scoped, like every other canonical row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { listScheduledReports } from "../src/services/scheduledReports";
import { generateAndStoreResearchReport } from "../src/agents/orchestrator/researchPublish";
import { generateReportStage } from "../src/services/unifiedReportPipeline";

vi.mock("../src/services/unifiedReportPipeline", () => ({
  generateReportStage: vi.fn(),
}));

function report() {
  return {
    runId: "run-1",
    generationId: "research:manual:2026-10-28T19:00:00.000Z",
    trigger: "manual",
    userLogin: "tester",
    createdAt: "2026-10-28T19:00:00.000Z",
    rulesVersion: "v1",
    configSnapshot: {},
    regime: { regime: "risk_on", notes: [] },
    summary: "1 qualified idea.",
    ideas: [],
    watchlist: [],
    rejected: [],
    stats: { universeSize: 1, qualified: 0 },
    oodaTrace: [],
    stageTrace: [],
  } as any;
}

// #6101 step 8: the research publish seam stores through the D1
// canonical seam via ctx.env, so the context binds a fresh
// MockD1Database (the DO mas_reports table is frozen).
function ctxFor(sql: MockSqlStorage) {
  const mock = new MockD1Database();
  const env = { AGENT_DB: mock as unknown as never };
  return {
    env,
    ensureTables: () => sql as any,
    getOrm: () => ({}) as any,
  } as any;
}

describe("generateAndStoreResearchReport (#2167)", () => {
  beforeEach(() => {
    vi.mocked(generateReportStage).mockReset();
  });

  it("stores one owner-scoped row carrying every artifact key and status", async () => {
    vi.mocked(generateReportStage).mockResolvedValue({
      pdfKey: "report:pdf:research:abc12345",
      pdfStatus: "generated",
      generationId: "research:manual:2026-10-28T19:00:00.000Z",
    });
    const agent = {
      generateAndStoreResearchArtifacts: vi.fn(async () => ({
        xlsxKey: "report:xlsx:research:abc12345",
        xlsxStatus: "generated" as const,
        csvKey: "report:csv:research:abc12345",
        csvStatus: "generated" as const,
      })),
    };
    const sql = new MockSqlStorage();
    const ctx = ctxFor(sql);

    const result = await generateAndStoreResearchReport(ctx, agent as any, report(), {
      trigger: "manual",
      userLogin: "tester",
    });

    expect(result.created).toBe(true);
    expect(result.artifacts).toMatchObject({
      pdfKey: "report:pdf:research:abc12345",
      pdfStatus: "generated",
      xlsxKey: "report:xlsx:research:abc12345",
      csvKey: "report:csv:research:abc12345",
    });

    const rows = await listScheduledReports(ctx.env, { userLogin: "tester" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "options_research", runId: "run-1" });
    expect(JSON.parse(String(rows[0].body))).toMatchObject({
      pdfKey: "report:pdf:research:abc12345",
      pdfStatus: "generated",
      xlsxKey: "report:xlsx:research:abc12345",
      xlsxStatus: "generated",
      csvKey: "report:csv:research:abc12345",
      csvStatus: "generated",
    });

    // The row belongs to its owner only.
    expect(await listScheduledReports(ctx.env, { userLogin: "someone-else" })).toHaveLength(0);
  });

  it("records a failed PDF while the workbook and CSV still land", async () => {
    vi.mocked(generateReportStage).mockResolvedValue({
      pdfKey: "",
      pdfStatus: "failed",
      pdfError: "[FAILURE_REPORT_PDF_GENERATION] PDF failed",
      generationId: "g",
    });
    const agent = {
      generateAndStoreResearchArtifacts: vi.fn(async () => ({
        xlsxKey: "report:xlsx:research:def",
        xlsxStatus: "generated" as const,
        csvKey: "report:csv:research:def",
        csvStatus: "generated" as const,
      })),
    };
    const sql = new MockSqlStorage();
    const ctx = ctxFor(sql);

    const result = await generateAndStoreResearchReport(ctx, agent as any, report(), {
      trigger: "scheduled",
      userLogin: "tester",
    });

    expect(result.artifacts.pdfStatus).toBe("failed");
    expect(result.artifacts.pdfError).toContain("FAILURE_REPORT_PDF_GENERATION");
    expect(result.artifacts.xlsxKey).toBe("report:xlsx:research:def");
    const body = JSON.parse(String((await listScheduledReports(ctx.env, { userLogin: "tester" }))[0].body));
    expect(body.pdfStatus).toBe("failed");
    expect(body.pdfError).toContain("FAILURE_REPORT_PDF_GENERATION");
    expect(body.xlsxKey).toBe("report:xlsx:research:def");
  });

  it("still stores the row when artifact generation throws", async () => {
    vi.mocked(generateReportStage).mockRejectedValue(new Error("asset agent down"));
    const agent = {
      generateAndStoreResearchArtifacts: vi.fn(async () => {
        throw new Error("blob store down");
      }),
    };
    const sql = new MockSqlStorage();
    const ctx = ctxFor(sql);

    const result = await generateAndStoreResearchReport(ctx, agent as any, report(), {
      trigger: "manual",
      userLogin: "tester",
    });

    expect(result.created).toBe(true);
    expect(result.artifacts).toMatchObject({
      pdfStatus: "failed",
      xlsxStatus: "failed",
      csvStatus: "failed",
    });
    const rows = await listScheduledReports(ctx.env, { userLogin: "tester" });
    expect(rows).toHaveLength(1);
    const body = JSON.parse(String(rows[0].body));
    expect(body.pdfStatus).toBe("failed");
    expect(body.pdfError).toContain("FAILURE_REPORT_PDF_GENERATION");
    expect(body.xlsxError).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(body.xlsxError).toContain("blob store down");
    expect(body.csvError).toContain("FAILURE_REPORT_CSV_GENERATION");
  });
});
