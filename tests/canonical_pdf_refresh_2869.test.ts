/**
 * Issue #2869 slice 1 follow-up (under #2764) — refresh a
 * canonical mas_reports row's PDF fields after a queued
 * consume generates them. Pins: update-only (never
 * creates a row), monotonic (missing fills, failed may
 * upgrade, generated never overwritten), owner re-checked,
 * R2-pointer rows refreshed at the same pointer, and a
 * missing row reported, never written.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  getCanonicalReport,
  refreshCanonicalReportPdfFields,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
} from "../src/services/scheduledReports";

/** Minimal SqlStorage shim over node:sqlite (same shape as the #2602 harness). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
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

function bodyOf(sql: never, reportId: string) {
  return JSON.parse(getCanonicalReport(sql, reportId)!.body) as Record<string, unknown>;
}

describe("canonical PDF refresh #2869 follow-up", () => {
  it("fills a missing pdfKey on an inline row and reports the fill", async () => {
    const sql = new SqliteTestStorage() as never;
    const stored = storeReportAtGeneration(sql, base());
    expect(stored).toBeTruthy();
    const out = await refreshCanonicalReportPdfFields(sql, {}, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "alice",
      pdfKey: "screener:pdf:abc",
      pdfStatus: "generated",
    });
    expect(out.status).toBe("refreshed");
    expect(out.filled).toContain("pdfKey");
    const body = bodyOf(sql, stored!.reportId);
    expect(body.pdfKey).toBe("screener:pdf:abc");
    expect(body.pdfStatus).toBe("generated");
    expect(body.reportUrl).toContain("screener%3Apdf%3Aabc");
  });

  it("never overwrites an already-generated pdfKey (duplicate-suppressed safety)", async () => {
    const sql = new SqliteTestStorage() as never;
    const stored = storeReportAtGeneration(
      sql,
      base({ body: { trigger: "manual", pdfKey: "screener:pdf:old", pdfStatus: "generated" } }),
    );
    const out = await refreshCanonicalReportPdfFields(sql, {}, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "alice",
      pdfKey: "screener:pdf:new",
      pdfStatus: "generated",
    });
    // reportUrl legitimately fills (it was missing), but
    // the generated pdfKey itself must never move.
    expect(out.filled).not.toContain("pdfKey");
    expect(bodyOf(sql, stored!.reportId).pdfKey).toBe("screener:pdf:old");
  });

  it("upgrades a failed status to generated, like the backfill rule", async () => {
    const sql = new SqliteTestStorage() as never;
    const stored = storeReportAtGeneration(
      sql,
      base({ body: { trigger: "manual", pdfStatus: "failed", pdfError: "renderer down" } }),
    );
    const out = await refreshCanonicalReportPdfFields(sql, {}, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "alice",
      pdfKey: "screener:pdf:recovered",
      pdfStatus: "generated",
    });
    expect(out.status).toBe("refreshed");
    const body = bodyOf(sql, stored!.reportId);
    expect(body.pdfKey).toBe("screener:pdf:recovered");
    expect(body.pdfStatus).toBe("generated");
  });

  it("reports a missing row and writes nothing", async () => {
    const sql = new SqliteTestStorage() as never;
    const out = await refreshCanonicalReportPdfFields(sql, {}, {
      generationId: "screener:nope",
      userLogin: "alice",
      pdfKey: "screener:pdf:x",
    });
    expect(out.status).toBe("missing-row");
    expect(getCanonicalReport(sql, "anything")).toBeNull();
  });

  it("refreshes an R2-pointer row at the same pointer, never a new object", async () => {
    const sql = new SqliteTestStorage() as never;
    const bucket = fakeBucket();
    const stored = await storeReportAtGenerationWithR2(
      sql,
      { REPORTS_BUCKET: bucket as never },
      base(),
    );
    expect(stored).toBeTruthy();
    const keysBefore = [...bucket.objects.keys()];
    expect(keysBefore.length).toBe(1);
    const out = await refreshCanonicalReportPdfFields(
      sql,
      { REPORTS_BUCKET: bucket as never },
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
    const sql = new SqliteTestStorage() as never;
    storeReportAtGeneration(sql, base());
    const out = await refreshCanonicalReportPdfFields(sql, {}, {
      generationId: "screener:2026-01-01T00:00:00.000Z",
      userLogin: "mallory",
      pdfKey: "screener:pdf:evil",
    });
    expect(out.status).toBe("missing-row");
  });
});
