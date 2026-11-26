import { describe, it, expect } from "vitest";
import {
  toScheduledReportRecord,
  storeReportAtGeneration,
  getScheduledReportById,
  readReportServingProvider,
} from "../src/services/scheduledReports";
import { MockD1Database } from "./mock-d1";

describe("Canonical report serving provider provenance (#4616)", () => {
  it("stamps explicit servingProviderId or extracts it from report body without confusing it with producer source", () => {
    const explicit = toScheduledReportRecord({
      runId: "run-1",
      userLogin: "alice",
      title: "Screen Report",
      source: "screener",
      servingProviderId: "fmp",
      summary: "Summary",
      body: { rows: [] },
    });
    expect(explicit.source).toBe("screener");
    expect(explicit.servingProviderId).toBe("fmp");

    const fromBody = toScheduledReportRecord({
      runId: "run-2",
      userLogin: "alice",
      title: "IV Report",
      source: "iv_collection",
      summary: "Summary",
      body: { providerId: "polygon", tickers: ["AAPL"] },
    });
    expect(fromBody.source).toBe("iv_collection");
    expect(fromBody.servingProviderId).toBe("polygon");
  });

  // #6101 step 8: the DO mas_reports row (and its fanout_outcome
  // JSON column) is frozen — the serving provider now rides the D1
  // agent_reports body, stamped there by toScheduledReportRecord,
  // and reads back through the D1 read path. The fan-out column
  // itself is a named loss (fanoutOutcome is always null on D1).
  it("stamps servingProviderId on the canonical D1 row body and leaves rows without one null", async () => {
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as unknown as never };

    const res = await storeReportAtGeneration(
      {
        runId: "run-4616",
        generationId: "gen-4616",
        userLogin: "alice",
        title: "Provider Stamped Report",
        source: "screener",
        servingProviderId: "alpaca",
        summary: "Stamped",
        body: { ok: true },
      },
      env,
    );

    expect(res?.created).toBe(true);
    const hit = await getScheduledReportById(env, res!.reportId);
    expect(hit).not.toBeNull();
    expect(readReportServingProvider(hit!.body)).toBe("alpaca");

    // A row stored with no serving provider carries none in its
    // body (the legacy shape), so the reader returns null.
    const legacy = await storeReportAtGeneration(
      {
        runId: "run-4616-legacy",
        generationId: "gen-4616-legacy",
        userLogin: "alice",
        title: "Legacy Report",
        source: "screener",
        summary: "No provider",
        body: { ok: true },
      },
      env,
    );
    const legacyHit = await getScheduledReportById(env, legacy!.reportId);
    expect(readReportServingProvider(legacyHit!.body)).toBeNull();
    expect(readReportServingProvider("{}")).toBeNull();
    expect(readReportServingProvider(null)).toBeNull();
  });
});
