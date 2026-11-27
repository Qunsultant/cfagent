/**
 * Options screener consolidation, slice 1 (issue #2528).
 *
 * Canonical artifact-key backfill on redelivery, and the single
 * canonical recorder wrapper. A keyless first write must not freeze
 * a row forever, and a redelivery must never overwrite an existing
 * key/status. TDD red→green for the backfill behaviour.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getCanonicalReport,
  planArtifactBackfill,
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import { recordUnifiedOptionsRun } from "../src/services/optionsServeRecord";
import { MockD1Database } from "./mock-d1";

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

// #6101 step 8: backfillArtifactKeys is deleted; the same
// first-write-win merge now lives in planArtifactBackfill
// (pinned in full by tests/canonical_backfill_2602.test.ts).
// These tests keep the #2528 slice-1 pins on the successor:
// merged -> { status: "merged", bodyJson }, nothing to fill
// (or a refused downgrade) -> { status: "noop" }.
describe("planArtifactBackfill (ex-backfillArtifactKeys)", () => {
  it("fills missing keys/statuses and never overwrites existing ones", () => {
    const outcome = planArtifactBackfill(
      JSON.stringify({ pdfKey: "options/pdf/old", pdfStatus: "generated" }),
      { xlsxKey: "options/xlsx/new", xlsxStatus: "generated", pdfKey: "options/pdf/evil" },
    );
    expect(outcome.status).toBe("merged");
    const body = JSON.parse((outcome as { bodyJson: string }).bodyJson);
    expect(body.pdfKey).toBe("options/pdf/old");
    expect(body.xlsxKey).toBe("options/xlsx/new");
    expect(body.xlsxStatus).toBe("generated");
  });

  it("upgrades failed to generated but never downgrades generated", () => {
    const upgraded = planArtifactBackfill(
      JSON.stringify({ pdfStatus: "failed" }),
      { pdfKey: "k", pdfStatus: "generated" },
    );
    expect(upgraded.status).toBe("merged");
    expect(JSON.parse((upgraded as { bodyJson: string }).bodyJson).pdfStatus).toBe("generated");
    expect(JSON.parse((upgraded as { bodyJson: string }).bodyJson).pdfKey).toBe("k");
    const notDowngraded = planArtifactBackfill(
      JSON.stringify({ pdfKey: "k", pdfStatus: "generated" }),
      { pdfStatus: "failed" },
    );
    expect(notDowngraded.status).toBe("noop");
  });

  it("returns noop when nothing is missing", () => {
    expect(
      planArtifactBackfill(
        JSON.stringify({ pdfKey: "k", pdfStatus: "generated" }),
        { pdfKey: "k2" },
      ).status,
    ).toBe("noop");
  });

  it("fills nested report.result fields the same way", () => {
    const merged = planArtifactBackfill(
      JSON.stringify({ report: { result: {} } }),
      { report: { result: { pdfKey: "nested-k" } } },
    );
    expect(merged.status).toBe("merged");
    expect(JSON.parse((merged as { bodyJson: string }).bodyJson).report.result.pdfKey).toBe("nested-k");
  });
});

describe("storeReportAtGeneration backfill on redelivery", () => {
  // #6101 step 8: the seam is async over D1; a redelivery backfill
  // lands as a NEW version (v2) of the same reportId, never an
  // in-place rewrite — "keeps one row" becomes "keeps one reportId".
  it("fills a keyless row on redelivery and keeps one row", async () => {
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as unknown as never };
    const first = await storeReportAtGeneration(base(), env);
    expect(first?.created).toBe(true);
    const second = await storeReportAtGeneration(
      base({ body: { trigger: "scheduled", pdfKey: "options/pdf/r1", pdfStatus: "generated", xlsxKey: "options/xlsx/r1", xlsxStatus: "generated", csvKey: "options/csv/r1", csvStatus: "generated" } }),
      env,
    );
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    const hit = await getCanonicalReport(env, first!.reportId);
    const body = JSON.parse(hit!.body);
    expect(body.pdfKey).toBe("options/pdf/r1");
    expect(body.xlsxKey).toBe("options/xlsx/r1");
    expect(body.csvKey).toBe("options/csv/r1");
  });

  it("never overwrites an existing key on redelivery", async () => {
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as unknown as never };
    const first = await storeReportAtGeneration(
      base({ body: { pdfKey: "options/pdf/orig", pdfStatus: "generated" } }),
      env,
    );
    await storeReportAtGeneration(
      base({ body: { pdfKey: "options/pdf/other" } }),
      env,
    );
    const body = JSON.parse((await getCanonicalReport(env, first!.reportId))!.body);
    expect(body.pdfKey).toBe("options/pdf/orig");
  });
});

describe("recordUnifiedOptionsRun", () => {
  it("records one canonical row with trigger, mode, and artifact keys", async () => {
    const orm = { storeCanonicalReport: vi.fn(async () => ({ reportId: "u1", created: true })) };
    const out = await recordUnifiedOptionsRun(orm, {
      runId: "options:2026-10-31T09:20:56.666Z",
      generationId: "options:2026-10-31T09:20:56.666Z",
      title: "Options scanner — bullish",
      source: "options_scanner",
      summary: "scheduled",
      trigger: "scheduled",
      strategyMode: "all",
      userLogin: "alice",
      pdfKey: "options/pdf/r1",
      pdfStatus: "generated",
      xlsxStatus: "failed",
      xlsxError: "xlsx failed",
    });
    expect(out).toEqual({ reportId: "u1", created: true });
    const call = orm.storeCanonicalReport.mock.calls[0][0];
    expect(call.userLogin).toBe("alice");
    expect(call.body.trigger).toBe("scheduled");
    expect(call.body.strategyMode).toBe("all");
    expect(call.body.pdfKey).toBe("options/pdf/r1");
    expect(call.body.xlsxStatus).toBe("failed");
    expect(call.body).not.toHaveProperty("csvKey");
  });
});
