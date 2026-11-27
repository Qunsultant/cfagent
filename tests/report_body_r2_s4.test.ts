/**
 * Issue #338 S4: lazy backfill on read — the design's migration path
 * ("NULL → serve inline, optionally backfill on first read"). When a
 * body-resolving read path serves an inline row while REPORTS_BUCKET is
 * bound, the body is copied to R2 and the row is rewritten to the
 * pointer shape (body "", body_r2_key set). The read itself never
 * fails because of the migration: any backfill error leaves the row
 * untouched and the inline body is served.
 *
 * Issue #6101 (step 8): the row is a D1 agent_reports row now — the
 * backfilled pointer lands as a new D1 version, never a DO row.
 * resolveCanonicalReportBodyWithBackfill takes (env, hit).
 */
import { describe, it, expect, vi } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  getCanonicalReport,
  resolveCanonicalReportBodyWithBackfill,
  canonicalResearchEmailBody,
  reportBodyR2Key,
} from "../src/services/scheduledReports";
import {
  storeResearchReportCanonicalAsync,
  deliverStoredReportEmail,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";

type D1Database = any;

function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-338-s4",
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

const input = {
  runId: "run-338-s4",
  generationId: "gen-338-s4",
  title: "Backfill probe",
  source: "research_report",
  summary: "Probe summary",
  body: { title: "Probe", fileName: "probe.xlsx", attachmentBase64: "QUJD" },
  userLogin: "tenant@example.com",
};
const bodyJson = JSON.stringify(input.body);

describe("#338 S4 lazy backfill on read", () => {
  it("serving an inline row with a bucket bound migrates it to the pointer shape", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGeneration(input, env as never);
    const hit = (await getCanonicalReport(env as never, stored!.reportId))!;
    expect(hit.bodyR2Key).toBeNull();
    const body = await resolveCanonicalReportBodyWithBackfill(env as never, hit);
    expect(body).toBe(bodyJson);
    const key = reportBodyR2Key(stored!.reportId);
    expect(objects.get(key)).toBe(bodyJson);
    const after = (await getCanonicalReport(env as never, stored!.reportId))!;
    expect(after.bodyR2Key).toBe(key);
    expect(after.body).toBe("");
    // The next read resolves through the pointer.
    const again = await resolveCanonicalReportBodyWithBackfill(env as never, after);
    expect(again).toBe(bodyJson);
    expect((bucket as any).put).toHaveBeenCalledTimes(1);
  });

  it("without a bucket, the inline body is served and the row is untouched", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration(input, env as never);
    const hit = (await getCanonicalReport(env as never, stored!.reportId))!;
    const body = await resolveCanonicalReportBodyWithBackfill(env as never, hit);
    expect(body).toBe(bodyJson);
    const after = (await getCanonicalReport(env as never, stored!.reportId))!;
    expect(after.bodyR2Key).toBeNull();
    expect(after.body).toBe(bodyJson);
  });

  it("a backfill put failure serves the inline body and leaves the row inline", async () => {
    const { env } = d1Env();
    const failing = {
      put: vi.fn(async () => { throw new Error("R2 unavailable"); }),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;
    const stored = await storeReportAtGeneration(input, env as never);
    const hit = (await getCanonicalReport(env as never, stored!.reportId))!;
    const body = await resolveCanonicalReportBodyWithBackfill(
      { ...env, REPORTS_BUCKET: failing } as never,
      hit,
    );
    expect(body).toBe(bodyJson);
    const after = (await getCanonicalReport(env as never, stored!.reportId))!;
    expect(after.bodyR2Key).toBeNull();
    expect(after.body).toBe(bodyJson);
  });

  it("a pointer row resolves through R2 and is never re-put", async () => {
    const { bucket } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    const hit = (await getCanonicalReport(env as never, stored!.reportId))!;
    expect(hit.bodyR2Key).not.toBeNull();
    const body = await resolveCanonicalReportBodyWithBackfill(env as never, hit);
    expect(body).toBe(bodyJson);
    expect((bucket as any).put).toHaveBeenCalledTimes(1); // the original write only
  });

  it("delivering a stored inline report backfills its row (dispatch path)", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env();
    const sendReportEmail = vi.fn(async () => true);
    const ctx = {
      env: { ...env, REPORTS_BUCKET: bucket },
      ensureTables: () => { throw new Error("dispatch must not use DO tables after the flip"); },
      getOrm: () => { throw new Error("unused"); },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 86_400_000,
      sendReportEmail,
      sendReportWebhook: vi.fn(async () => ({ success: true })),
    } as unknown as ReportDispatchContext;
    // Store WITHOUT a bucket (legacy inline row), then bind the bucket
    // for the delivery read: the store happens inline, delivery migrates.
    const noBucketCtx = { ...ctx, env } as unknown as ReportDispatchContext;
    const bodyJson2 = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "weekly.xlsx",
      attachmentBase64: "QUJD",
    });
    const stored = await storeResearchReportCanonicalAsync(noBucketCtx, bodyJson2, {
      title: "Weekly scan",
      summary: "s",
      userLogin: "venus",
    });
    expect((await getCanonicalReport(env as never, stored!.reportId))?.bodyR2Key).toBeNull();
    const outcome = await deliverStoredReportEmail(ctx, stored!.reportId, "a@b.com", "venus");
    expect(outcome).toBe("sent");
    const after = (await getCanonicalReport(env as never, stored!.reportId))!;
    expect(after.bodyR2Key).toBe(reportBodyR2Key(stored!.reportId));
    expect(objects.get(after.bodyR2Key!)).toBe(bodyJson2);
  });
});
