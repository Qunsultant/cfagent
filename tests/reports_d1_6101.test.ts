/**
 * Issue #6101 (step 8) — the mas_reports writer + readers move to D1:
 * storeReportAtGeneration writes agent_reports directly (no projector,
 * no DO row), the DO readers (search/list/detail-by-id/detail-by-run)
 * read D1, and the D1 adapter gains the three reads the seam needs
 * (searchReports, latestReportByGeneration, latestReportByRunId).
 *
 * Pinned here (TDD red→green):
 *  1. searchReports: token LIKE over title/summary/body, tenant- and
 *     owner-scoped, newest first, latest version per report.
 *  2. latestReportByGeneration: newest version for a generation id,
 *     null when absent, owner-scoped (the writer dedupe).
 *  3. latestReportByRunId: newest row for a run id, null when absent.
 *  4. listReports: source filter (DO listRows parity).
 *  5. Writer: first store lands a v1 D1 row (provenanceWriter
 *     "store-report-at-generation", linkedJobRunId resolved only when
 *     exactly one job run is in-window); a redelivery of the same
 *     generation id dedupes (created:false, same reportId, one row);
 *     a redelivery carrying a missing artifact key backfills as v2;
 *     an unbound AGENT_DB returns null and never throws.
 *  6. Link helpers (re-created from the deleted projector):
 *     jobIdForGenerationId + resolveLinkedJobRunId.
 *  7. Readers: the stored row is visible through
 *     searchScheduledReports / listScheduledReports /
 *     getScheduledReportById / getScheduledReportByRunId, with
 *     fanoutOutcome null (D1 carries no fan-out column — named loss).
 *  8. resolveCanonicalReportBodyWithBackfill serves an inline row's
 *     body when no R2 binding exists.
 */
import { describe, it, expect } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import { InMemoryAuditReportAdapter } from "../src/data/inMemoryAuditReportAdapter";
import type { CanonicalReportRow } from "../src/data/auditReportPorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import { buildJobRunRecord, type JobRunRecord } from "../src/services/jobRunRecords";
import { d1JobRunRecordId } from "../src/services/jobRunRecordReads";
import {
  storeReportAtGeneration,
  searchScheduledReports,
  listScheduledReports,
  getScheduledReportById,
  getScheduledReportByRunId,
  resolveCanonicalReportBodyWithBackfill,
  jobIdForGenerationId,
  resolveLinkedJobRunId,
} from "../src/services/scheduledReports";

/** Shared D1Database stand-in over node:sqlite (tests/mock-d1.ts). */
type D1Database = any;

const TENANT = "tenant-6101";
const OWNER = "analyst@example.com";

function env(mock: MockD1Database) {
  return { AGENT_DB: mock as unknown as D1Database, IAAA_TENANT_ID: TENANT };
}

function reportRow(overrides: Partial<CanonicalReportRow> = {}): CanonicalReportRow {
  return {
    tenantId: TENANT,
    workspaceId: TENANT,
    reportId: `rep-${Math.random().toString(36).slice(2, 10)}`,
    runId: "screener:2026-11-26T10:00:00.000Z",
    generationId: null,
    title: "Market screen — Technology",
    source: "screener",
    summary: "Scanned 100 symbols, 3 matched.",
    body: JSON.stringify({ symbols: ["AAPL"] }),
    createdAtMs: Date.parse("2026-11-26T10:00:00.000Z"),
    updatedAtMs: Date.parse("2026-11-26T10:00:00.000Z"),
    version: 1,
    provenanceWriter: "test",
    provenanceSourceDo: "Orchestrator",
    provenanceSourceVersion: "1",
    linkedJobRunId: null,
    userLogin: OWNER,
    bodyR2Key: null,
    ...overrides,
  };
}

async function seededAdapter() {
  const mock = new MockD1Database();
  const d1 = mock as unknown as D1Database;
  const db = createD1AuditReportDb(d1);
  await ensureAuditReportSchema(db);
  const adapter = new D1AuditReportAdapter(db);
  return { mock, adapter };
}

describe("D1AuditReportAdapter — step-8 reads", () => {
  it("searchReports matches tokens over title/summary/body, tenant- and owner-scoped", async () => {
    const { adapter } = await seededAdapter();
    await adapter.recordReport(
      reportRow({ reportId: "r-alpha-title", title: "Alpha screen", body: "{}" }),
    );
    await adapter.recordReport(
      reportRow({ reportId: "r-alpha-body", title: "Other", body: JSON.stringify({ note: "alpha signal" }) }),
    );
    await adapter.recordReport(
      reportRow({ reportId: "r-beta", title: "Beta screen", summary: "beta only" }),
    );
    await adapter.recordReport(
      reportRow({ reportId: "r-alpha-other-tenant", tenantId: "tenant-other", title: "Alpha elsewhere" }),
    );
    await adapter.recordReport(
      reportRow({ reportId: "r-alpha-other-owner", userLogin: "someone-else@example.com", title: "Alpha not mine" }),
    );
    const hits = await adapter.searchReports(TENANT, ["alpha"]);
    expect(hits.map((r) => r.reportId).sort()).toEqual([
      "r-alpha-body",
      "r-alpha-other-owner",
      "r-alpha-title",
    ]);
    const mine = await adapter.searchReports(TENANT, ["alpha"], { userLogin: OWNER });
    expect(mine.map((r) => r.reportId).sort()).toEqual(["r-alpha-body", "r-alpha-title"]);
    expect(await adapter.searchReports(TENANT, ["zzz"])).toEqual([]);
    expect(await adapter.searchReports(TENANT, [])).toEqual([]);
  });

  it("latestReportByGeneration returns the newest version, null when absent", async () => {
    const { adapter } = await seededAdapter();
    await adapter.recordReport(reportRow({ reportId: "r-gen", generationId: "gen-1", version: 1 }));
    await adapter.recordReport(reportRow({ reportId: "r-gen", generationId: "gen-1", version: 2, title: "v2" }));
    await adapter.recordReport(reportRow({ reportId: "r-gen-other", generationId: "gen-2", version: 1 }));
    const latest = await adapter.latestReportByGeneration(TENANT, "gen-1");
    expect(latest?.version).toBe(2);
    expect(latest?.title).toBe("v2");
    expect(await adapter.latestReportByGeneration(TENANT, "gen-missing")).toBeNull();
    expect(
      await adapter.latestReportByGeneration(TENANT, "gen-1", "someone-else@example.com"),
    ).toBeNull();
  });

  it("latestReportByRunId returns the newest row for the run", async () => {
    const { adapter } = await seededAdapter();
    await adapter.recordReport(
      reportRow({ reportId: "r-old", runId: "run-1", createdAtMs: 1000, updatedAtMs: 1000 }),
    );
    await adapter.recordReport(
      reportRow({ reportId: "r-new", runId: "run-1", createdAtMs: 2000, updatedAtMs: 2000 }),
    );
    const latest = await adapter.latestReportByRunId(TENANT, "run-1");
    expect(latest?.reportId).toBe("r-new");
    expect(await adapter.latestReportByRunId(TENANT, "run-missing")).toBeNull();
  });

  it("listReports filters by source", async () => {
    const { adapter } = await seededAdapter();
    await adapter.recordReport(reportRow({ reportId: "r-scr", source: "screener" }));
    await adapter.recordReport(reportRow({ reportId: "r-res", source: "research_report" }));
    const screened = await adapter.listReports(TENANT, { source: "screener" });
    expect(screened.map((r) => r.reportId)).toEqual(["r-scr"]);
    expect((await adapter.listReports(TENANT)).map((r) => r.reportId).sort()).toEqual([
      "r-res",
      "r-scr",
    ]);
  });

  it("in-memory adapter implements the new reads with the same semantics", async () => {
    const adapter = new InMemoryAuditReportAdapter();
    await adapter.recordReport(reportRow({ reportId: "m-1", generationId: "g-1", title: "Alpha one" }));
    await adapter.recordReport(reportRow({ reportId: "m-1", generationId: "g-1", version: 2, title: "Alpha two" }));
    await adapter.recordReport(reportRow({ reportId: "m-2", runId: "run-9", source: "research_report" }));
    expect((await adapter.searchReports(TENANT, ["alpha"])).map((r) => r.reportId)).toEqual(["m-1"]);
    expect((await adapter.latestReportByGeneration(TENANT, "g-1"))?.version).toBe(2);
    expect((await adapter.latestReportByRunId(TENANT, "run-9"))?.reportId).toBe("m-2");
    expect((await adapter.listReports(TENANT, { source: "research_report" })).map((r) => r.reportId)).toEqual([
      "m-2",
    ]);
  });
});

describe("storeReportAtGeneration — D1 writer (step 8)", () => {
  it("first store lands a v1 D1 row; no DO row is written", async () => {
    const { mock, adapter } = await seededAdapter();
    const stored = await storeReportAtGeneration(
      {
        runId: "screener:2026-11-26T10:00:00.000Z",
        generationId: "gen-writer-1",
        title: "Market screen — Technology",
        source: "screener",
        summary: "Scanned 100 symbols.",
        body: { symbols: ["AAPL"] },
        userLogin: OWNER,
        createdAt: "2026-11-26T10:00:00.000Z",
      },
      env(mock),
    );
    expect(stored).not.toBeNull();
    expect(stored?.created).toBe(true);
    const row = await adapter.latestReportByGeneration(TENANT, "gen-writer-1");
    expect(row).not.toBeNull();
    expect(row?.reportId).toBe(stored?.reportId);
    expect(row?.version).toBe(1);
    expect(row?.provenanceWriter).toBe("store-report-at-generation");
    expect(row?.linkedJobRunId).toBeNull();
    expect(row?.userLogin).toBe(OWNER);
    // No mas_reports table exists anywhere in this D1 — the DO home is gone.
    expect(
      mock.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mas_reports'")
        .all(),
    ).toHaveLength(0);
  });

  it("a redelivery of the same generation id dedupes; a missing artifact key backfills as v2", async () => {
    const { mock, adapter } = await seededAdapter();
    const input = {
      runId: "screener:2026-11-26T10:00:00.000Z",
      generationId: "gen-writer-2",
      title: "Market screen — Technology",
      source: "screener",
      summary: "Scanned 100 symbols.",
      body: { symbols: ["AAPL"] },
      userLogin: OWNER,
      createdAt: "2026-11-26T10:00:00.000Z",
    };
    const first = await storeReportAtGeneration(input, env(mock));
    const second = await storeReportAtGeneration(input, env(mock));
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    expect((await adapter.latestReportByGeneration(TENANT, "gen-writer-2"))?.version).toBe(1);
    const third = await storeReportAtGeneration(
      { ...input, body: { symbols: ["AAPL"], pdfKey: "reports/abc.pdf", pdfStatus: "generated" } },
      env(mock),
    );
    expect(third?.created).toBe(false);
    expect(third?.reportId).toBe(first?.reportId);
    const latest = await adapter.latestReportByGeneration(TENANT, "gen-writer-2");
    expect(latest?.version).toBe(2);
    const merged = JSON.parse(latest?.body ?? "{}") as Record<string, unknown>;
    expect(merged.pdfKey).toBe("reports/abc.pdf");
    expect(merged.symbols).toEqual(["AAPL"]);
  });

  it("an unbound AGENT_DB returns null and never throws", async () => {
    const stored = await storeReportAtGeneration(
      {
        runId: "screener:2026-11-26T10:00:00.000Z",
        generationId: "gen-writer-3",
        title: "t",
        source: "screener",
        summary: "s",
        body: {},
        userLogin: OWNER,
      },
      {},
    );
    expect(stored).toBeNull();
  });

  it("resolves linkedJobRunId only when exactly one job run is in-window", async () => {
    const mock = new MockD1Database();
    const d1 = mock as unknown as D1Database;
    const reportDb = createD1AuditReportDb(d1);
    await ensureAuditReportSchema(reportDb);
    const runDb = createD1JobRunRecordDb(d1);
    await ensureJobRunRecordsSchema(runDb);
    const runStore = new D1JobRunRecordStore(runDb);
    const jobRecord: JobRunRecord = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "job-6101-link",
      operation: "test-op",
      started: "2026-11-26T10:00:00.000Z",
      finished: "2026-11-26T10:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    await runStore.record(jobRecord);
    const stored = await storeReportAtGeneration(
      {
        runId: "pipeline-generate:job-6101-link:2026-11-26T10:00:00.500Z",
        generationId: "pipeline-generate:job-6101-link:2026-11-26T10:00:00.500Z",
        title: "Pipeline generate — job-6101-link",
        source: "research_report",
        summary: "generated",
        body: {},
        userLogin: OWNER,
        createdAt: "2026-11-26T10:00:00.500Z",
      },
      env(mock),
    );
    expect(stored).not.toBeNull();
    const adapter = new D1AuditReportAdapter(reportDb);
    const row = await adapter.latestReportByGeneration(
      TENANT,
      "pipeline-generate:job-6101-link:2026-11-26T10:00:00.500Z",
    );
    expect(row?.linkedJobRunId).toBe(d1JobRunRecordId(jobRecord));
    // Out of window: no link.
    const stored2 = await storeReportAtGeneration(
      {
        runId: "pipeline-generate:job-6101-link:2026-11-26T11:00:00.000Z",
        generationId: "pipeline-generate:job-6101-link:2026-11-26T11:00:00.000Z",
        title: "Pipeline generate — job-6101-link",
        source: "research_report",
        summary: "generated",
        body: {},
        userLogin: OWNER,
        createdAt: "2026-11-26T11:00:00.000Z",
      },
      env(mock),
    );
    expect(stored2).not.toBeNull();
    const row2 = await adapter.latestReportByGeneration(
      TENANT,
      "pipeline-generate:job-6101-link:2026-11-26T11:00:00.000Z",
    );
    expect(row2?.linkedJobRunId).toBeNull();
  });
});

describe("link helpers (re-created from the deleted projector)", () => {
  it("jobIdForGenerationId strips the pipeline-generate prefix", () => {
    expect(jobIdForGenerationId("pipeline-generate:job-1:2026-11-26T10:00:00.000Z")).toBe("job-1");
    expect(jobIdForGenerationId("screener:2026-11-26T10:00:00.000Z")).toBe(
      "screener:2026-11-26T10:00:00.000Z",
    );
    expect(jobIdForGenerationId(null)).toBeNull();
    expect(jobIdForGenerationId("pipeline-generate:")).toBeNull();
  });

  it("resolveLinkedJobRunId links only the unique in-window run", () => {
    const inWindow: JobRunRecord = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "job-1",
      operation: "op",
      started: "2026-11-26T10:00:00.000Z",
      finished: "2026-11-26T10:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    const outOfWindow: JobRunRecord = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "job-1",
      operation: "op",
      started: "2026-11-26T11:00:00.000Z",
      finished: "2026-11-26T11:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    const at = Date.parse("2026-11-26T10:00:00.500Z");
    expect(resolveLinkedJobRunId("pipeline-generate:job-1:x", at, [inWindow])).toBe(
      d1JobRunRecordId(inWindow),
    );
    expect(resolveLinkedJobRunId("pipeline-generate:job-1:x", at, [outOfWindow])).toBeNull();
    expect(
      resolveLinkedJobRunId("pipeline-generate:job-1:x", at, [inWindow, { ...inWindow }]),
    ).toBeNull();
    expect(resolveLinkedJobRunId(null, at, [inWindow])).toBeNull();
  });
});

describe("D1 report readers (step 8)", () => {
  it("a stored row is visible through search/list/detail, fanoutOutcome null", async () => {
    const { mock } = await seededAdapter();
    const e = env(mock);
    const stored = await storeReportAtGeneration(
      {
        runId: "screener:2026-11-26T10:00:00.000Z",
        generationId: "gen-read-1",
        title: "Alpha screen — Technology",
        source: "screener",
        summary: "Scanned 100 symbols.",
        body: { symbols: ["AAPL"] },
        userLogin: OWNER,
        createdAt: "2026-11-26T10:00:00.000Z",
      },
      e,
    );
    expect(stored).not.toBeNull();
    const found = await searchScheduledReports(e, "alpha", 5, { userLogin: OWNER });
    expect(found.map((h) => h.id)).toEqual([stored?.reportId]);
    expect(found[0]?.fanoutOutcome).toBeNull();
    const listed = await listScheduledReports(e, { userLogin: OWNER });
    expect(listed.map((h) => h.id)).toEqual([stored?.reportId]);
    const byId = await getScheduledReportById(e, stored!.reportId, { userLogin: OWNER });
    expect(byId?.runId).toBe("screener:2026-11-26T10:00:00.000Z");
    const byRun = await getScheduledReportByRunId(e, "screener:2026-11-26T10:00:00.000Z", {
      userLogin: OWNER,
    });
    expect(byRun?.id).toBe(stored?.reportId);
    expect(await getScheduledReportById(e, "missing", { userLogin: OWNER })).toBeNull();
  });

  it("resolveCanonicalReportBodyWithBackfill serves an inline row with no R2 bound", async () => {
    const { mock } = await seededAdapter();
    const e = env(mock);
    const stored = await storeReportAtGeneration(
      {
        runId: "screener:2026-11-26T10:00:00.000Z",
        generationId: "gen-read-2",
        title: "t",
        source: "screener",
        summary: "s",
        body: { symbols: ["AAPL"] },
        userLogin: OWNER,
        createdAt: "2026-11-26T10:00:00.000Z",
      },
      e,
    );
    const hit = await getScheduledReportById(e, stored!.reportId, { userLogin: OWNER });
    expect(hit).not.toBeNull();
    const body = await resolveCanonicalReportBodyWithBackfill(e, hit!);
    expect(JSON.parse(body ?? "{}")).toEqual({ symbols: ["AAPL"] });
  });
});
