/**
 * Issue #2869 slice 1 follow-up (under #2764) — refresh a
 * canonical report row's PDF fields after a queued
 * consume generates them. Pins: update-only (never
 * creates a row), monotonic (missing fills, failed may
 * upgrade, generated never overwritten), owner re-checked,
 * R2-pointer rows refreshed at the same pointer, and a
 * missing row reported, never written.
 *
 * Issue #6101 (step 8): the row is a D1 agent_reports row
 * now — the seam reads/writes D1 over the shared
 * MockD1Database; refreshCanonicalReportPdfFields takes
 * (env, input) with AGENT_DB (+ REPORTS_BUCKET for pointer
 * rows). Inline refreshes land as a new D1 version.
 */
import { describe, expect, it } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  getCanonicalReport,
  refreshCanonicalReportPdfFields,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
} from "../src/services/scheduledReports";

type D1Database = any;

function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-2869",
    ...extra,
  };
  return { mock, env };
}

/** Fake R2 bucket: objects carry text(), like the #338 S2 fake. */
function fakeBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    async put(key: string, value: unknown) {
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array));
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { text: async () => value, httpMetadata: { contentType: "application/json" } };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

const base = (over: Record<string, unknown> = {}) => ({
  runId: "screener:2026-01-01T00:00:00.000Z",
  generationId: "screener:2026-01-01T00:00:00.000Z",
  userLogin: "alice",
  title: "Market screen — ALL (manual)",
  source: "screener",
  summary: "10 scanned",
  body: { trigger: "manual" },
  ...over,
});

async function bodyOf(env: Record<string, unknown>, reportId: string) {
  return JSON.parse((await getCanonicalReport(env as never, reportId))!.body) as Record<
    string,
    unknown
  >;
}

describe("canonical PDF refresh #2869 follow-up", () => {
  it("fills a missing pdfKey on an inline row and reports the fill", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration(base(), env as never);
    expect(stored).toBeTruthy();
    const out = await refreshCanonicalReportPdfFields(env as never, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "alice",
      pdfKey: "screener:pdf:abc",
      pdfStatus: "generated",
    });
    expect(out.status).toBe("refreshed");
    expect(out.filled).toContain("pdfKey");
    const body = await bodyOf(env, stored!.reportId);
    expect(body.pdfKey).toBe("screener:pdf:abc");
    expect(body.pdfStatus).toBe("generated");
    expect(body.reportUrl).toContain("screener%3Apdf%3Aabc");
  });

  it("never overwrites an already-generated pdfKey (duplicate-suppressed safety)", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration(
      base({ body: { trigger: "manual", pdfKey: "screener:pdf:old", pdfStatus: "generated" } }),
      env as never,
    );
    const out = await refreshCanonicalReportPdfFields(env as never, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "alice",
      pdfKey: "screener:pdf:new",
      pdfStatus: "generated",
    });
    // reportUrl legitimately fills (it was missing), but
    // the generated pdfKey itself must never move.
    expect(out.filled).not.toContain("pdfKey");
    expect((await bodyOf(env, stored!.reportId)).pdfKey).toBe("screener:pdf:old");
  });

  it("upgrades a failed status to generated, like the backfill rule", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration(
      base({ body: { trigger: "manual", pdfStatus: "failed", pdfError: "renderer down" } }),
      env as never,
    );
    const out = await refreshCanonicalReportPdfFields(env as never, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "alice",
      pdfKey: "screener:pdf:recovered",
      pdfStatus: "generated",
    });
    expect(out.status).toBe("refreshed");
    const body = await bodyOf(env, stored!.reportId);
    expect(body.pdfKey).toBe("screener:pdf:recovered");
    expect(body.pdfStatus).toBe("generated");
  });

  it("reports a missing row and writes nothing", async () => {
    const { env } = d1Env();
    const out = await refreshCanonicalReportPdfFields(env as never, {
      generationId: "screener:nope",
      userLogin: "alice",
      pdfKey: "screener:pdf:x",
    });
    expect(out.status).toBe("missing-row");
    expect(await getCanonicalReport(env as never, "anything")).toBeNull();
  });

  it("refreshes an R2-pointer row at the same pointer, never a new object", async () => {
    const bucket = fakeBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket as never });
    const stored = await storeReportAtGenerationWithR2(
      env as never,
      base(),
    );
    expect(stored).toBeTruthy();
    const keysBefore = [...bucket.objects.keys()];
    expect(keysBefore.length).toBe(1);
    const out = await refreshCanonicalReportPdfFields(
      env as never,
      {
        generationId: "screener:2026-01-01T00:00:00.000Z",
        userLogin: "alice",
        pdfKey: "screener:pdf:r2",
        pdfStatus: "generated",
      },
    );
    expect(out.status).toBe("refreshed");
    expect([...bucket.objects.keys()]).toEqual(keysBefore);
    const merged = JSON.parse(bucket.objects.get(keysBefore[0])!) as Record<string, unknown>;
    expect(merged.pdfKey).toBe("screener:pdf:r2");
    expect(merged.trigger).toBe("manual");
  });

  it("refuses another owner's row", async () => {
    const { env } = d1Env();
    await storeReportAtGeneration(base(), env as never);
    const out = await refreshCanonicalReportPdfFields(env as never, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "mallory",
      pdfKey: "screener:pdf:evil",
    });
    expect(out.status).toBe("missing-row");
  });
});
