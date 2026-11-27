/**
 * Issue #338 S3: the coupled delete. The accepted design requires that
 * when a canonical report row is deleted, its R2 body object is deleted in
 * the same scope — otherwise every row deletion strands an object.
 * The row has NO pruning today (retention decision #786: KEEP —
 * pruning is a product decision), so S3 lands the primitive any future
 * deletion must use, plus the retention-record note pointing at it.
 *
 * Issue #6101 (step 8): the row is a D1 agent_reports row now (all
 * versions deleted) — deleteCanonicalReport takes (env, reportId);
 * the R2 coupling is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  getCanonicalReport,
  deleteCanonicalReport,
  reportBodyR2Key,
} from "../src/services/scheduledReports";

type D1Database = any;

function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-338-s3",
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
  runId: "run-338-s3",
  generationId: "gen-338-s3",
  title: "Delete probe",
  source: "research_report",
  summary: "Probe summary",
  body: { title: "Probe" },
  userLogin: "tenant@example.com",
};

describe("#338 S3 coupled delete", () => {
  it("deleting a pointer row removes the row AND its R2 object", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    const key = reportBodyR2Key(stored!.reportId);
    expect(objects.has(key)).toBe(true);
    const deleted = await deleteCanonicalReport(env as never, stored!.reportId);
    expect(deleted).toBe(true);
    expect(objects.has(key)).toBe(false);
    expect(await getCanonicalReport(env as never, stored!.reportId)).toBeNull();
  });

  it("deleting an inline row removes the row and touches no object", async () => {
    const { bucket } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGeneration(input, env as never);
    const deleted = await deleteCanonicalReport(env as never, stored!.reportId);
    expect(deleted).toBe(true);
    expect((bucket as any).delete).not.toHaveBeenCalled();
    expect(await getCanonicalReport(env as never, stored!.reportId)).toBeNull();
  });

  it("deleting a missing report returns false", async () => {
    const { bucket } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    expect(await deleteCanonicalReport(env as never, "nope")).toBe(false);
  });

  it("a failed R2 delete is logged and the row is still deleted (the orphan sweep owns stranded objects)", async () => {
    const { bucket, objects } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    (bucket as any).delete = vi.fn(async () => { throw new Error("R2 delete failed"); });
    const deleted = await deleteCanonicalReport(env as never, stored!.reportId);
    expect(deleted).toBe(true);
    expect(await getCanonicalReport(env as never, stored!.reportId)).toBeNull();
    // The object is stranded — exactly the case the design's orphan
    // sweep follow-up exists for.
    expect(objects.has(reportBodyR2Key(stored!.reportId))).toBe(true);
  });

  it("without a bucket bound, a pointer row is still deleted (object stranded, logged)", async () => {
    const { bucket } = createFakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGenerationWithR2(env as never, input);
    // Same D1 mock, no bucket bound.
    const deleted = await deleteCanonicalReport(
      { AGENT_DB: env.AGENT_DB, IAAA_TENANT_ID: "tenant-338-s3" } as never,
      stored!.reportId,
    );
    expect(deleted).toBe(true);
    expect(await getCanonicalReport(env as never, stored!.reportId)).toBeNull();
  });
});
