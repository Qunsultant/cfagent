/**
 * Issue #2602 (slice 6, #2528; #2533 item 1) — canonical first-write-win
 * backfill, with the RCA v2b acceptance list as the pins:
 *   monotonic per format · generated never overwritten or downgraded ·
 *   owner re-checked · R2 fail-closed · identical replay a no-op ·
 *   artifact fields never truncated · parity across PDF/XLSX/CSV ·
 *   every record that cannot be backfilled is NAMED, never guessed.
 *
 * Issue #6101 (step 8): the seam reads/writes D1 agent_reports now —
 * the DO mas_reports table is frozen and receives no new writes. The
 * planArtifactBackfill pins are unchanged (pure function); the seam
 * tests go through the D1 seam over the shared MockD1Database, and
 * read back through getCanonicalReport. D1 rows are versioned: a
 * backfill merge lands as a new version, never an in-place rewrite.
 */
import { describe, expect, it } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  getCanonicalReport,
  listScheduledReports,
  planArtifactBackfill,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
} from "../src/services/scheduledReports";

type D1Database = any;

function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-2602",
    ...extra,
  };
  return { mock, env };
}

const base = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  generationId: "gen-1",
  userLogin: "alice",
  title: "Options scanner — bullish",
  source: "options_scanner",
  summary: "12 scanned",
  body: { trigger: "scheduled" },
  ...over,
});

async function bodyOf(env: Record<string, unknown>, reportId: string) {
  return JSON.parse((await getCanonicalReport(env as never, reportId))!.body) as Record<
    string,
    unknown
  >;
}

describe("backfill parity per format (#2602)", () => {
  it("fills key, status and error for PDF, XLSX and CSV alike", () => {
    const outcome = planArtifactBackfill(
      JSON.stringify({ trigger: "scheduled" }),
      {
        pdfKey: "options/pdf/1",
        pdfStatus: "generated",
        xlsxKey: "options/xlsx/1",
        xlsxStatus: "generated",
        xlsxError: "one sheet skipped",
        csvKey: "options/csv/1",
        csvStatus: "failed",
        csvError: "csv boom",
      },
    );
    expect(outcome.status).toBe("merged");
    if (outcome.status !== "merged") return;
    const body = JSON.parse(outcome.bodyJson);
    expect(body).toMatchObject({
      pdfKey: "options/pdf/1",
      pdfStatus: "generated",
      xlsxKey: "options/xlsx/1",
      xlsxStatus: "generated",
      xlsxError: "one sheet skipped",
      csvKey: "options/csv/1",
      csvStatus: "failed",
      csvError: "csv boom",
    });
    expect(outcome.filled).toEqual(
      expect.arrayContaining(["pdfKey", "xlsxKey", "xlsxError", "csvError"]),
    );
  });

  it("fills the nested report.result fields the same way", () => {
    const outcome = planArtifactBackfill(
      JSON.stringify({ report: { result: { pdfKey: "old" } } }),
      { report: { result: { pdfKey: "evil", xlsxKey: "nested-xlsx" } } },
    );
    expect(outcome.status).toBe("merged");
    if (outcome.status !== "merged") return;
    const nested = JSON.parse(outcome.bodyJson).report.result;
    expect(nested.pdfKey).toBe("old");
    expect(nested.xlsxKey).toBe("nested-xlsx");
  });
});

describe("first-write-win monotonicity (#2602)", () => {
  it("never overwrites a generated key with a later write", () => {
    const outcome = planArtifactBackfill(
      JSON.stringify({ pdfKey: "options/pdf/orig", pdfStatus: "generated" }),
      { pdfKey: "options/pdf/other", pdfStatus: "generated" },
    );
    expect(outcome.status).toBe("noop");
  });

  it("upgrades failed → generated, but never downgrades generated → failed", () => {
    const up = planArtifactBackfill(
      JSON.stringify({ pdfStatus: "failed", pdfKey: "keep" }),
      { pdfStatus: "generated", pdfKey: "new" },
    );
    expect(up.status).toBe("merged");
    if (up.status !== "merged") return;
    expect(JSON.parse(up.bodyJson).pdfStatus).toBe("generated");
    expect(JSON.parse(up.bodyJson).pdfKey).toBe("keep");

    const down = planArtifactBackfill(
      JSON.stringify({ pdfKey: "k", pdfStatus: "generated" }),
      { pdfStatus: "failed", pdfError: "late failure" },
    );
    expect(down.status).toBe("merged"); // pdfError fills, status does not
    if (down.status !== "merged") return;
    expect(JSON.parse(down.bodyJson).pdfStatus).toBe("generated");
    expect(JSON.parse(down.bodyJson).pdfError).toBe("late failure");
  });
});

describe("identity, replay and truncation (#2602)", () => {
  it("an identical replay is a no-op (no body write)", () => {
    const stored = JSON.stringify({ pdfKey: "k", pdfStatus: "generated", trigger: "scheduled" });
    expect(planArtifactBackfill(stored, JSON.parse(stored)).status).toBe("noop");
  });

  it("never truncates artifact fields or unrelated body content", () => {
    const longKey = "options/pdf/" + "x".repeat(4096);
    const rows = Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}`, score: i }));
    const outcome = planArtifactBackfill(
      JSON.stringify({ pdfKey: longKey, rows, trigger: "scheduled" }),
      { xlsxKey: "options/xlsx/1", rows: [] },
    );
    expect(outcome.status).toBe("merged");
    if (outcome.status !== "merged") return;
    const body = JSON.parse(outcome.bodyJson);
    expect(body.pdfKey).toBe(longKey);
    expect(body.rows).toHaveLength(50);
    expect(body.trigger).toBe("scheduled");
  });
});

describe("records that cannot be backfilled are named (#2602)", () => {
  it("names a stored body that is not JSON instead of guessing", () => {
    expect(planArtifactBackfill("not-json{", { pdfKey: "k" })).toEqual({
      status: "not-backfillable",
      reason: "stored-body-not-json",
    });
  });

  it("names a stored body that is not an object", () => {
    expect(planArtifactBackfill("[1,2,3]", { pdfKey: "k" })).toEqual({
      status: "not-backfillable",
      reason: "stored-body-not-object",
    });
  });

  it("names a redelivery body that is not an object", () => {
    expect(planArtifactBackfill(JSON.stringify({}), "nope")).toEqual({
      status: "not-backfillable",
      reason: "redelivery-body-not-object",
    });
  });

  it("refuses a write when the stored row's owner differs (owner re-checked)", () => {
    expect(
      planArtifactBackfill(JSON.stringify({}), { pdfKey: "k" }, {
        owner: "alice",
        storedOwner: "bob",
      }),
    ).toEqual({ status: "not-backfillable", reason: "owner-mismatch" });
  });
});

describe("storeReportAtGeneration: first-write-win on redelivery (#2602)", () => {
  it("fills a keyless row and keeps exactly one row", async () => {
    const { env } = d1Env();
    const first = await storeReportAtGeneration(base(), env as never);
    const second = await storeReportAtGeneration(
      base({ body: { trigger: "scheduled", pdfKey: "p", pdfStatus: "generated" } }),
      env as never,
    );
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    expect((await bodyOf(env, first!.reportId)).pdfKey).toBe("p");
    // D1 rows are versioned: the backfill is a new version of the
    // same report — exactly one reportId, not one row.
    expect(await listScheduledReports(env as never)).toHaveLength(1);
  });

  it("leaves the stored body untouched on an identical replay", async () => {
    const { env } = d1Env();
    const first = await storeReportAtGeneration(
      base({ body: { trigger: "scheduled", pdfKey: "p", pdfStatus: "generated" } }),
      env as never,
    );
    const before = (await getCanonicalReport(env as never, first!.reportId))!.body;
    await storeReportAtGeneration(
      base({ body: { trigger: "scheduled", pdfKey: "p", pdfStatus: "generated" } }),
      env as never,
    );
    expect((await getCanonicalReport(env as never, first!.reportId))!.body).toBe(before);
  });

  it("does not backfill an R2-pointer row (fail-closed, named)", async () => {
    const { env } = d1Env({
      REPORTS_BUCKET: { put: async () => undefined } as never,
    });
    const first = await storeReportAtGenerationWithR2(
      env as never,
      base({ body: { trigger: "scheduled" } }),
    );
    const stored = await getCanonicalReport(env as never, first!.reportId);
    expect(stored!.bodyR2Key).toBeTruthy();
    const before = stored!.body;
    await storeReportAtGenerationWithR2(
      env as never,
      base({ body: { trigger: "scheduled", pdfKey: "should-not-land" } }),
    );
    const after = await getCanonicalReport(env as never, first!.reportId);
    expect(after!.body).toBe(before);
    expect(after!.body).not.toContain("should-not-land");
  });
});
