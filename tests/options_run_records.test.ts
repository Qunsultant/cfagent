/**
 * Options run-record seam (Reports tab + Workflow Runs).
 *
 * A run is only visible to its owner when the canonical mas_reports row
 * carries that owner's login (listScheduledReports / `/api/runs` filter
 * `user_login`), and it is only visible in Workflow Runs when a
 * mas_job_outcomes row carries its artifact keys.
 *
 * Before this pin, every options canonical write omitted `userLogin`
 * (row stored under "default", invisible to the signed-in owner) and the
 * sharded serve recorder wrote no outcome at all (no ledger row). These
 * tests pin the two seams that every options path funnels through:
 *  - storeOptionsCanonicalReport: one owner-aware canonical write.
 *  - recordOptionsServeReport: canonical row + outcome row, with keys.
 * Plus the scheduled scanner's own canonical call, which bypasses the
 * serve recorder on the monolithic path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { DatabaseORM } from "../src/orm";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { createJobRunRecordAdapter } from "../src/data/createJobRunRecordPorts";
import {
  recordOptionsServeReport,
  storeOptionsCanonicalReport,
} from "../src/services/optionsServeRecord";
import type { Env } from "../src/types";

const OWNER = "trader@example.com";

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => map.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      map.set(key, value);
    }),
  };
}

const canonicalInput = {
  runId: "options:2026-10-28T12:00:00.000Z",
  generationId: "options:2026-10-28T12:00:00.000Z",
  title: "Options scanner — bullish",
  source: "options_scanner",
  summary: "12 underlyings scanned, 4 matched.",
  body: { pdfKey: "options/pdf/run-1" },
  createdAt: "2026-10-28T12:00:00.000Z",
};

/**
 * Expiry 90 days out, computed at run time so the fixture never goes stale
 * (#5947): the screener drops chains whose expiry falls outside the default
 * 0–90 day DTE window, so a fixed future date only postpones the next
 * date-bomb — a run-time-relative expiry is always DTE 90 (the user's ruling
 * is current date + 90 days; the screener's window check is inclusive, so
 * DTE 90 passes the default 0–90 window).
 */
function expiry90DaysOut() {
  const d = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

describe("storeOptionsCanonicalReport", () => {
  it("writes the run owner onto the canonical row", async () => {
    const orm = { storeCanonicalReport: vi.fn(async () => ({ reportId: "r1", created: true })) };
    await storeOptionsCanonicalReport(orm, { ...canonicalInput, userLogin: OWNER });
    expect(orm.storeCanonicalReport).toHaveBeenCalledTimes(1);
    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({
      generationId: canonicalInput.generationId,
      userLogin: OWNER,
    });
  });

  it("never throws when the report store fails", async () => {
    const orm = {
      storeCanonicalReport: vi.fn(async () => {
        throw new Error("report store unavailable");
      }),
    };
    await expect(storeOptionsCanonicalReport(orm, { ...canonicalInput, userLogin: OWNER })).resolves.toBeNull();
  });
});

describe("recordOptionsServeReport", () => {
  let sql: MockSqlStorage;

  beforeEach(() => {
    sql = new MockSqlStorage();
  });

  it("stores the canonical row under the owner and records the run outcome", async () => {
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "r1", created: true })),
      getSql: () => sql,
    };
    const storage = memoryStorage();
    // #6101: the outcome folds onto D1 (recordOptionsServeReport
    // threads deps.env through); the read-back is the D1 run record.
    const d1 = new MockD1Database();

    const ok = await recordOptionsServeReport(
      { orm: orm as any, storage, env: { AGENT_DB: d1 } },
      {
        kind: "options",
        timestamp: "2026-10-28T12:00:00.000Z",
        trigger: "scheduled",
        success: true,
        thesis: "bullish",
        symbols: ["NVDA", "AAPL"],
        totalScanned: 12,
        matchedCount: 4,
        summary: "12 underlyings scanned, 4 matched.",
        pdfKeys: ["options/pdf/run-1"],
        xlsxKey: "options/xlsx/run-1",
        csvKey: "options/csv/run-1",
        reportUrl: "/api/options/report.pdf?key=options%2Fpdf%2Frun-1",
        deliveryId: "scheduled:options:chain-1",
        userLogin: OWNER,
      } as any,
    );

    expect(ok).toBe(true);
    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({ userLogin: OWNER });

    const store = createJobRunRecordAdapter({ AGENT_DB: d1 });
    const row = await store!.latestByJob("scheduled:options:chain-1");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      jobId: "scheduled:options:chain-1",
      operation: "options",
      trigger: "scheduled",
      outcome: "success",
      scanned: 12,
      matched: 4,
      pdfKey: "options/pdf/run-1",
      xlsxKey: "options/xlsx/run-1",
      csvKey: "options/csv/run-1",
      reportUrl: "/api/options/report.pdf?key=options%2Fpdf%2Frun-1",
    });
  });

  it("records per-format statuses and scanRunId in the canonical body; a failed leg records failed", async () => {
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "r3", created: true })),
      getSql: () => sql,
    };
    await recordOptionsServeReport(
      { orm: orm as any, storage: memoryStorage() },
      {
        kind: "options",
        timestamp: "2026-10-28T14:00:00.000Z",
        trigger: "manual",
        success: true,
        thesis: "bullish",
        symbols: ["NVDA"],
        totalScanned: 5,
        matchedCount: 2,
        summary: "5 scanned, 2 matched.",
        pdfKeys: ["options/pdf/run-3"],
        pdfStatus: "generated",
        xlsxKey: "options/xlsx/run-3",
        xlsxStatus: "failed",
        xlsxError: "workbook render failed",
        csvKey: "options/csv/run-3",
        csvStatus: "generated",
        scanRunId: "scan-uuid-3",
        userLogin: OWNER,
      } as any,
    );
    const body = orm.storeCanonicalReport.mock.calls[0][0].body;
    expect(body).toMatchObject({
      pdfKey: "options/pdf/run-3",
      pdfStatus: "generated",
      xlsxKey: "options/xlsx/run-3",
      xlsxStatus: "failed",
      xlsxError: "workbook render failed",
      csvKey: "options/csv/run-3",
      csvStatus: "generated",
      scanRunId: "scan-uuid-3",
    });
  });

  it("records a failed run's coded error rather than a silent absence", async () => {
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "r2", created: true })),
      getSql: () => sql,
    };
    // #6101: the outcome folds onto D1; the read-back is the D1 run
    // record (outcome "failure" replaces the DO status "failed").
    const d1 = new MockD1Database();

    await recordOptionsServeReport(
      { orm: orm as any, storage: memoryStorage(), env: { AGENT_DB: d1 } },
      {
        kind: "options",
        timestamp: "2026-10-28T13:00:00.000Z",
        trigger: "scheduled",
        success: false,
        thesis: "bullish",
        symbols: [],
        totalScanned: 0,
        matchedCount: 0,
        error: "[FAILURE_SCREEN_NO_CONTRACTS_EVALUATED] incomplete universe",
        deliveryId: "scheduled:options:chain-2",
        userLogin: OWNER,
      } as any,
    );

    const store = createJobRunRecordAdapter({ AGENT_DB: d1 });
    const row = await store!.latestByJob("scheduled:options:chain-2");
    expect(row?.outcome).toBe("failure");
    expect(row?.codedError).toContain("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED");
  });
});

describe("scheduled options scanner canonical report", () => {
  let mockEnv: Env;
  let orm: DatabaseORM;
  let storeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const sql = { exec: vi.fn(() => []) };
    orm = new DatabaseORM(sql as any);
    storeSpy = vi.spyOn(orm, "storeCanonicalReport").mockReturnValue({ reportId: "sched-1", created: true });
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;

    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: {
        symbol: "NVDA",
        underlyingPrice: 130,
        quoteTime: Date.now(),
        selectedExpiry: expiry90DaysOut(),
        pairs: [
          {
            call: {
              symbol: "NVDA",
              optionType: "CALL",
              strikePrice: 130,
              bid: 5.5,
              ask: 5.8,
              volume: 800,
              openInterest: 2000,
              impliedVolatility: 0.45,
              delta: 0.52,
              gamma: 0.04,
              theta: -0.05,
              vega: 0.12,
              rho: 0.02,
            },
          },
        ],
      },
    });
  });

  it("stores the scheduled run's canonical report under the run owner", async () => {
    const service = new ScheduledTasksService(mockEnv, orm, OWNER);
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["NVDA"],
      thesis: "bullish",
      riskProfile: "balanced",
    });

    expect(result.success).toBe(true);
    expect(storeSpy).toHaveBeenCalled();
    const input = (storeSpy.mock.calls.at(-1) as any[])[0];
    expect(input.source).toBe("options_scanner");
    expect(input.userLogin).toBe(OWNER);
  });
});
