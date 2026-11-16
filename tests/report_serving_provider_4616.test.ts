import { describe, it, expect } from "vitest";
import {
  toScheduledReportRecord,
  storeReportAtGeneration,
  readReportServingProvider,
} from "../src/services/scheduledReports";

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

  it("stamps servingProviderId on the canonical mas_reports row fanout_outcome JSON and leaves legacy rows null", () => {
    const executed: Array<{ query: string; params: unknown[] }> = [];
    const mockSql = {
      exec(query: string, ...params: unknown[]) {
        executed.push({ query, params });
        if (query.startsWith("PRAGMA table_info")) {
          return [
            { name: "id" },
            { name: "run_id" },
            { name: "title" },
            { name: "source" },
            { name: "summary" },
            { name: "body" },
            { name: "created_at" },
            { name: "generation_id" },
            { name: "user_login" },
            { name: "body_r2_key" },
            { name: "fanout_outcome" },
          ];
        }
        if (query.startsWith("PRAGMA index_info")) {
          return [{ name: "user_login" }, { name: "generation_id" }];
        }
        return [];
      },
    };

    const res = storeReportAtGeneration(mockSql as never, {
      runId: "run-4616",
      generationId: "gen-4616",
      userLogin: "alice",
      title: "Provider Stamped Report",
      source: "screener",
      servingProviderId: "alpaca",
      summary: "Stamped",
      body: { ok: true },
    });

    expect(res?.created).toBe(true);
    const insert = executed.find((e) => e.query.includes("INSERT INTO mas_reports"));
    expect(insert).toBeDefined();
    // body is param index 5 in INSERT INTO mas_reports (id, run_id, title, source, summary, body, ...)
    const bodyJson = insert!.params[5] as string;
    expect(readReportServingProvider(bodyJson)).toBe("alpaca");
    expect(readReportServingProvider("{}")).toBeNull();
    expect(readReportServingProvider(null)).toBeNull();
  });
});
