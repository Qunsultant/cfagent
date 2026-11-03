/**
 * Issue #2062: every stock screener run records a full document set.
 *
 * Pins the CSV leg of the stock document generation (persistRun calls
 * it; since #2911 G4 the leg itself lives in the one generation module,
 * src/services/stockReportArtifacts.ts):
 *  - the run records `csvKey` in the `screener:csv:` family and
 *    `csvStatus: "generated"`, plus the `screener:latest.csv` pointer;
 *  - the stored bytes ARE the run's CSV report (header + one row per
 *    screened stock), so the Docs and Reports link serves real content;
 *  - a blob-store failure is recorded on the run (`csvStatus: "failed"`,
 *    `csvError`) and never throws out of the run.
 */
import { describe, it, expect } from "vitest";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { generateStockReportArtifacts } from "../src/services/stockReportArtifacts";
import { SCREENER_CSV_COLUMNS, parseScreenerCsv } from "../src/trading";

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class FailingStorage extends FakeStorage {
  async put(): Promise<void> {
    throw new Error("blob store down");
  }
}

class XlsxFailingStorage extends FakeStorage {
  async put(key: string, value: unknown): Promise<void> {
    if (String(key).includes("xlsx")) throw new Error("r2 unavailable");
    return super.put(key, value);
  }
}

function makeAgent(storage: FakeStorage): ScreenerAgent {
  return new ScreenerAgent({ storage } as any, {} as any);
}

const RUN = {
  timestamp: "2026-10-27T13:05:29.000Z",
  trigger: "manual" as const,
  provider: "yahoo" as const,
  universe: "nasdaq100" as const,
  sector: "ALL",
  success: true,
  totalScanned: 2,
  matchedCount: 1,
  opportunities: [{ symbol: "NVDA", price: 180 }],
  allStocks: [
    { symbol: "NVDA", price: 180, matchScore: 88 },
    { symbol: "AMD", price: 210, matchScore: 71 },
  ],
  discoveryMessage: "",
};

describe("ScreenerAgent CSV artifact (#2062)", () => {
  it("stores a per-run CSV plus the latest pointer and records the key on the run", async () => {
    const storage = new FakeStorage();
    const run = { ...RUN } as any;

    await generateStockReportArtifacts({
      env: {} as any,
      storage: storage as any,
      result: run,
      userLogin: "owner",
      formats: ["csv"],
    });

    expect(run.csvStatus).toBe("generated");
    expect(run.csvKey).toMatch(/^screener:csv:[0-9a-f]{8}$/);
    expect(run.csvError).toBeUndefined();

    const stored = storage.map.get(run.csvKey) as { fileName: string; base64: string } | undefined;
    expect(stored?.fileName).toBe("screener-report-nasdaq100-2026-10-27.csv");
    const text = Buffer.from(stored!.base64, "base64").toString("utf8");
    expect(text.split("\n")[0]).toBe(SCREENER_CSV_COLUMNS.join(","));

    const parsed = parseScreenerCsv(text);
    expect(parsed).toHaveLength(3); // header + two screened stocks
    expect(parsed[1]).toContain("NVDA");
    expect(parsed[2]).toContain("AMD");

    const latest = storage.map.get("screener:latest.csv") as { fileName: string } | undefined;
    expect(latest?.fileName).toBe("screener-report-nasdaq100-2026-10-27.csv");
  });

  it("records a blob-store failure on the run instead of throwing", async () => {
    const run = { ...RUN } as any;

    const out = await generateStockReportArtifacts({
      env: {} as any,
      storage: new FailingStorage() as any,
      result: run,
      userLogin: "owner",
      formats: ["csv"],
    });
    expect(out.csv.status).toBe("failed");
    expect(run.csvStatus).toBe("failed");
    expect(run.csvKey).toBeUndefined();
    expect(run.csvError).toContain("blob store down");
    expect(run.csvError).toContain("FAILURE_REPORT_CSV_GENERATION");
  });

  it("records a blob-store failure on the XLSX leg from the catalog (#2262)", async () => {
    const storage = new XlsxFailingStorage();
    storage.map.set("screener:owner-login", "owner");
    const agent = makeAgent(storage);
    // generateScreenerXlsx calls lastPrice/changePercent.toFixed on every
    // row, so the run rows carry those fields (the shared RUN does not).
    const run = {
      ...RUN,
      allStocks: [
        { symbol: "NVDA", price: 180, matchScore: 88, lastPrice: 180, changePercent: 1.2 },
        { symbol: "AMD", price: 210, matchScore: 71, lastPrice: 210, changePercent: -0.5 },
      ],
    } as any;

    await expect((agent as any).persistRun(run)).resolves.toBeUndefined();
    expect(run.xlsxStatus).toBe("failed");
    expect(run.xlsxKey).toBeUndefined();
    expect(run.xlsxError).toContain("r2 unavailable");
    expect(run.xlsxError).toContain("FAILURE_REPORT_XLSX_GENERATION");
  });
});
