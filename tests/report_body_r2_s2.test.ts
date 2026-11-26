/**
 * Issue #338 S2: the write/read flip. New canonical reports written
 * through storeReportAtGenerationWithR2 put their body in R2
 * (reports/<reportId>.json via REPORTS_BUCKET) and keep only the
 * body_r2_key pointer in the row; the research dispatch path
 * (store + stored-copy delivery) resolves the pointer on read.
 * Inline rows (NULL pointer) are a permanent read shape: every
 * pre-migration row and every no-bucket/failure fallback stays inline.
 *
 * Issue #6101 (step 8): the row is a D1 agent_reports row now — the
 * seam reads/writes D1 over the shared MockD1Database; the DO
 * mas_reports table is frozen and receives no new writes.
 */
import { describe, it, expect, vi } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  getCanonicalReport,
  listScheduledReports,
  resolveCanonicalReportBody,
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
    IAAA_TENANT_ID: "tenant-338-s2",
    ...extra,
  };
  return { mock, env };
}

/** Minimal in-memory R2 bucket fake. */
function createFakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, value: unknown) => {
      objects.set(key, String(value));
    }),
    get: vi.fn(async (key: string) => {
      const v = objects.get(key);
      return v === undefined ? null : { text: async () => v };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const input = {
  runId: "run-338-s2",
  generationId: "gen-338-s2",
  title: "R2 flip probe",
  source: "research_report",
  summary: "Probe summary",
  body: { title: "Probe", fileName: "probe.xlsx", attachmentBase64: "QUJD" },
  userLogin: "tenant@example.com",
};
const bodyJson = JSON.stringify(input.body);

describe("#338 S2 R2 write/read flip", () => {
  it("with a bucket bound, the body lands in R2 and the row keeps only the pointer", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    expect(stored?.created).toBe(true);
    const key = reportBodyR2Key(stored!.reportId);
    expect(objects.get(key)).toBe(bodyJson);
    const hit = await getCanonicalReport(env as never, stored!.reportId);
    expect(hit?.bodyR2Key).toBe(key);
    expect(hit?.body).toBe("");
    expect(await resolveCanonicalReportBody({ REPORTS_BUCKET: bucket } as never, hit!)).toBe(bodyJson);
  });

  it("dedupe on generation id returns the existing row and does not rewrite the R2 object", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const first = await storeReportAtGenerationWithR2(env as never, input);
    const second = await storeReportAtGenerationWithR2(env as never, {
      ...input,
      body: { title: "Changed", fileName: "changed.xlsx", attachmentBase64: "REVG" },
    });
    // #2347 (§7 disclosed pin update): the store result now also
    // carries the recorded fan-out outcome — deduped, body in R2.
    expect(second).toEqual({
      reportId: first!.reportId,
      created: false,
      fanout: expect.objectContaining({ outcome: "deduped", body: "r2" }),
    });
    expect((bucket as any).put).toHaveBeenCalledTimes(1);
    expect(objects.get(reportBodyR2Key(first!.reportId))).toBe(bodyJson);
    expect(await listScheduledReports(env as never)).toHaveLength(1);
  });

  it("without a bucket, the write is the legacy inline write", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    expect(stored?.created).toBe(true);
    const hit = await getCanonicalReport(env as never, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toBe(bodyJson);
    expect(await resolveCanonicalReportBody({} as never, hit!)).toBe(bodyJson);
  });

  it("an R2 put failure falls back to the inline write (a report is never lost to the flip)", async () => {
    const { env } = d1Env();
    const failing = {
      put: vi.fn(async () => { throw new Error("R2 unavailable"); }),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;
    const stored = await storeReportAtGenerationWithR2(
      { ...env, REPORTS_BUCKET: failing } as never,
      input,
    );
    expect(stored?.created).toBe(true);
    const hit = await getCanonicalReport(env as never, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toBe(bodyJson);
  });

  it("resolve fails closed to null when the pointer's object is gone or no bucket is bound", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    const hit = (await getCanonicalReport(env as never, stored!.reportId))!;
    objects.clear();
    expect(await resolveCanonicalReportBody({ REPORTS_BUCKET: bucket } as never, hit)).toBeNull();
    expect(await resolveCanonicalReportBody({} as never, hit)).toBeNull();
  });

  it("the sync seam is unchanged by the refactor (still inline, still idempotent)", async () => {
    const { env } = d1Env();
    const a = await storeReportAtGeneration(input, env as never);
    const b = await storeReportAtGeneration(input, env as never);
    expect(a?.created).toBe(true);
    // #2347 (§7 disclosed pin update): the store result now also
    // carries the recorded fan-out outcome — deduped, body inline.
    expect(b).toEqual({
      reportId: a!.reportId,
      created: false,
      fanout: expect.objectContaining({ outcome: "deduped", body: "inline" }),
    });
    const hit = await getCanonicalReport(env as never, a!.reportId);
    expect(hit?.body).toBe(bodyJson);
    expect(hit?.bodyR2Key).toBeNull();
  });
});

describe("#338 S2 research dispatch path", () => {
  function makeCtx(env: Record<string, unknown>, bucket: R2Bucket) {
    const sendReportEmail = vi.fn(async () => true);
    const ctx = {
      env: { ...env, REPORTS_BUCKET: bucket },
      ensureTables: () => { throw new Error("dispatch must not use DO tables after the flip"); },
      getOrm: () => { throw new Error("store path must not use the ORM after the flip"); },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 86_400_000,
      sendReportEmail,
      sendReportWebhook: vi.fn(async () => ({ success: true })),
    } as unknown as ReportDispatchContext;
    return { ctx, sendReportEmail };
  }

  it("stores the canonical research report in R2 and delivers the stored copy from R2", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env();
    const { ctx, sendReportEmail } = makeCtx(env, bucket);
    const bodyJson = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "weekly.xlsx",
      attachmentBase64: "QUJD",
    });
    const stored = await storeResearchReportCanonicalAsync(ctx, bodyJson, {
      title: "Weekly scan",
      summary: "s",
      userLogin: "venus",
    });
    expect(stored).not.toBeNull();
    expect(objects.get(reportBodyR2Key(stored!.reportId))).toBe(bodyJson);
    const outcome = await deliverStoredReportEmail(ctx, stored!.reportId, "a@b.com", "venus");
    expect(outcome).toBe("sent");
    expect(sendReportEmail).toHaveBeenCalledWith("a@b.com", "Weekly scan", "weekly.xlsx", "QUJD", "venus");
  });

  it("delivery reports 'missing' when the R2 object behind the pointer is gone", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env();
    const { ctx } = makeCtx(env, bucket);
    const bodyJson = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "weekly.xlsx",
      attachmentBase64: "QUJD",
    });
    const stored = await storeResearchReportCanonicalAsync(ctx, bodyJson, {
      title: "Weekly scan",
      summary: "s",
      userLogin: "venus",
    });
    objects.clear();
    const outcome = await deliverStoredReportEmail(ctx, stored!.reportId, "a@b.com", "venus");
    expect(outcome).toBe("missing");
  });
});
