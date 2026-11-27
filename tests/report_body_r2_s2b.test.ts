/**
 * Issue #338 S2b: the screener persist producer flips to the R2 write
 * path. persistScreenerReportCanonical becomes async and stores through
 * storeReportAtGenerationWithR2: with REPORTS_BUCKET bound the screen
 * body lands in R2 and the row keeps only the pointer; the
 * REST route contexts declare Promise<void> and await the store.
 *
 * Issue #6101 (step 8): the row is a D1 agent_reports row now — the
 * seam reads/writes D1 over the shared MockD1Database; the DO
 * mas_reports table is frozen and receives no new writes.
 */
import { describe, it, expect, vi } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  getCanonicalReport,
  listScheduledReports,
  reportBodyR2Key,
} from "../src/services/scheduledReports";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";

type D1Database = any;

function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-338-s2b",
    ...extra,
  };
  return { mock, env };
}

function createFakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, value: unknown) => { objects.set(key, String(value)); }),
    get: vi.fn(async (key: string) => {
      const v = objects.get(key);
      return v === undefined ? null : { text: async () => v };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const screenResult = {
  timestamp: "2026-10-23T14:00:00.000Z",
  universe: "ALL",
  provider: "yahoo",
  success: true,
  totalScanned: 500,
  matchedCount: 12,
  opportunities: [{ symbol: "ACME" }],
  allStocks: [{ symbol: "ACME" }],
  trigger: "manual",
  userLogin: "venus",
};

function makeCtx(env: Record<string, unknown>) {
  return {
    env,
    ensureTables: () => { throw new Error("screener persist must not use DO tables after the flip"); },
    getOrm: () => { throw new Error("screener persist must not use the ORM after the flip"); },
    reportDispatchHitlKey: "report_dispatch_hitl",
    reportConfirmationTtlMs: 86_400_000,
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true })),
  } as unknown as ReportDispatchContext;
}

describe("#338 S2b screener persist flip", () => {
  it("stores the screen body in R2 with a pointer row, provenance intact", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const ctx = makeCtx(env);
    await persistScreenerReportCanonical(ctx, screenResult);
    const hits = await listScheduledReports(env as never, { userLogin: "venus" });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit.source).toBe("screener");
    expect(hit.runId).toBe("screener:2026-10-23T14:00:00.000Z");
    expect(hit.bodyR2Key).toBe(reportBodyR2Key(hit.id));
    expect(hit.body).toBe("");
    const body = JSON.parse(objects.get(hit.bodyR2Key!)!);
    expect(body.provider).toBe("yahoo");
    expect(body.trigger).toBe("manual");
    expect(body.opportunities).toEqual([{ symbol: "ACME" }]);
    // The canonical read + resolve path returns the same body.
    const stored = await getCanonicalReport(env as never, hit.id);
    expect(stored?.bodyR2Key).toBe(hit.bodyR2Key);
  });

  it("dedupes on the screener generation id (no second row, no second put)", async () => {
    const { bucket } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const ctx = makeCtx(env);
    await persistScreenerReportCanonical(ctx, screenResult);
    await persistScreenerReportCanonical(ctx, screenResult);
    expect(await listScheduledReports(env as never, { userLogin: "venus" })).toHaveLength(1);
    expect((bucket as any).put).toHaveBeenCalledTimes(1);
  });

  it("without a bucket, stores inline exactly as before", async () => {
    const { env } = d1Env();
    const ctx = makeCtx(env);
    await persistScreenerReportCanonical(ctx, screenResult);
    const hits = await listScheduledReports(env as never, { userLogin: "venus" });
    expect(hits).toHaveLength(1);
    expect(hits[0].bodyR2Key).toBeNull();
    const body = JSON.parse(hits[0].body);
    expect(body.provider).toBe("yahoo");
    expect(body.trigger).toBe("manual");
  });
});
