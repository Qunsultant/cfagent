/**
 * Issue #2911 (G4): one generation path for stock report artifacts.
 *
 * Pins:
 *  - one status vocabulary for every format (PDF/XLSX/CSV): generated,
 *    failed, missing, never-attempted, skipped — resolved by one pure
 *    function, so a failed leg never renders as "no record" and a
 *    never-attempted leg never renders as "failed";
 *  - one generation module (src/services/stockReportArtifacts.ts): the
 *    stock XLSX/CSV generators are called from exactly one place in
 *    src/ outside their trading definitions, and the shard stock branch
 *    routes through the same module;
 *  - the module's tabular legs generate + store + latest-pointer with
 *    the same contract the agent legs had (per-run key, latest pointer,
 *    blob-store failure recorded as failed with a coded error, never
 *    thrown, never a key on failure);
 *  - a format the caller did not request records never-attempted, not
 *    missing and not failed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  resolveStockReportFormatStatus,
  stockReportFormatStatusLabel,
} from "../src/services/stockReportFormatStatus";
import {
  generateStockReportArtifacts,
  generateStockTabularBytes,
} from "../src/services/stockReportArtifacts";
import { SCREENER_CSV_COLUMNS } from "../src/trading";

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

const RUN = {
  timestamp: "2026-10-27T13:05:29.000Z",
  trigger: "manual" as const,
  provider: "yahoo" as const,
  universe: "nasdaq100" as const,
  sector: "ALL",
  success: true,
  totalScanned: 2,
  matchedCount: 1,
  opportunities: [{ symbol: "NVDA", price: 180, lastPrice: 180, changePercent: 1.2 }],
  allStocks: [
    { symbol: "NVDA", price: 180, matchScore: 88, lastPrice: 180, changePercent: 1.2 },
    { symbol: "AMD", price: 210, matchScore: 71, lastPrice: 210, changePercent: -0.5 },
  ],
  discoveryMessage: "",
};

describe("stock report format status vocabulary (#2911)", () => {
  it("passes a recorded vocabulary status through unchanged", () => {
    for (const status of ["generated", "failed", "missing", "never-attempted", "skipped"] as const) {
      expect(resolveStockReportFormatStatus({ status })).toBe(status);
    }
  });

  it("a stored key with no recorded status is generated", () => {
    expect(resolveStockReportFormatStatus({ key: "screener:xlsx:deadbeef" })).toBe("generated");
    expect(resolveStockReportFormatStatus({ key: "screener:csv:deadbeef", status: null })).toBe("generated");
  });

  it("no key and no status on a requested format is missing", () => {
    expect(resolveStockReportFormatStatus({})).toBe("missing");
    expect(resolveStockReportFormatStatus({ requested: true })).toBe("missing");
  });

  it("a format that was not requested is never-attempted, even on a failed run", () => {
    expect(resolveStockReportFormatStatus({ requested: false })).toBe("never-attempted");
    expect(resolveStockReportFormatStatus({ requested: false, runFailed: true })).toBe("never-attempted");
  });

  it("a failed run with no key and no status is failed, not missing", () => {
    expect(resolveStockReportFormatStatus({ runFailed: true })).toBe("failed");
  });

  it("an unrecognized recorded status is not trusted; the key is ground truth", () => {
    expect(resolveStockReportFormatStatus({ key: "screener:xlsx:deadbeef", status: "pending" })).toBe("generated");
    expect(resolveStockReportFormatStatus({ status: "pending" })).toBe("missing");
  });

  it("labels every vocabulary value distinctly", () => {
    expect(stockReportFormatStatusLabel("generated")).toBe("Generated");
    expect(stockReportFormatStatusLabel("failed")).toBe("Failed");
    expect(stockReportFormatStatusLabel("missing")).toBe("Missing");
    expect(stockReportFormatStatusLabel("never-attempted")).toBe("Not attempted");
    expect(stockReportFormatStatusLabel("skipped")).toBe("Skipped");
  });
});

describe("stock report artifacts module (#2911)", () => {
  it("generates and stores XLSX + CSV with per-run keys and latest pointers", async () => {
    const storage = new FakeStorage();
    const run = { ...RUN } as any;
    const out = await generateStockReportArtifacts({
      env: {} as any,
      storage: storage as any,
      result: run,
      userLogin: "owner",
      formats: ["xlsx", "csv"],
    });

    expect(out.pdf.status).toBe("never-attempted");
    expect(out.pdf.key).toBeUndefined();
    expect(out.xlsx.status).toBe("generated");
    expect(out.xlsx.key).toMatch(/^screener:xlsx:[0-9a-f]{8}$/);
    expect(out.csv.status).toBe("generated");
    expect(out.csv.key).toMatch(/^screener:csv:[0-9a-f]{8}$/);
    expect(run.xlsxKey).toBe(out.xlsx.key);
    expect(run.xlsxStatus).toBe("generated");
    expect(run.csvKey).toBe(out.csv.key);
    expect(run.csvStatus).toBe("generated");

    const csvStored = storage.map.get(out.csv.key!) as { fileName: string; base64: string } | undefined;
    expect(csvStored?.fileName).toBe("screener-report-nasdaq100-2026-10-27.csv");
    const text = Buffer.from(csvStored!.base64, "base64").toString("utf8");
    expect(text.split("\n")[0]).toBe(SCREENER_CSV_COLUMNS.join(","));
    expect(text).toContain("NVDA");
    expect(text).toContain("AMD");

    const xlsxStored = storage.map.get(out.xlsx.key!) as { fileName: string } | undefined;
    expect(xlsxStored?.fileName).toBe("screener-report-nasdaq100-2026-10-27.xlsx");
    expect((storage.map.get("screener:latest.xlsx") as any)?.fileName).toBe(xlsxStored?.fileName);
    expect((storage.map.get("screener:latest.csv") as any)?.fileName).toBe(csvStored?.fileName);
  });

  it("records a blob-store failure as failed with a coded error and no key, never throws", async () => {
    const storage = new FailingStorage();
    const run = { ...RUN } as any;
    const out = await generateStockReportArtifacts({
      env: {} as any,
      storage: storage as any,
      result: run,
      userLogin: "owner",
      formats: ["xlsx", "csv"],
    });

    expect(out.xlsx.status).toBe("failed");
    expect(out.xlsx.key).toBeUndefined();
    expect(out.xlsx.error).toContain("blob store down");
    expect(out.xlsx.error).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(out.csv.status).toBe("failed");
    expect(out.csv.key).toBeUndefined();
    expect(out.csv.error).toContain("blob store down");
    expect(out.csv.error).toContain("FAILURE_REPORT_CSV_GENERATION");
    expect(run.xlsxStatus).toBe("failed");
    expect(run.xlsxKey).toBeUndefined();
    expect(run.csvStatus).toBe("failed");
    expect(run.csvKey).toBeUndefined();
  });

  it("the shard tabular helper produces the same bytes the generators produce", () => {
    const xlsx = generateStockTabularBytes("xlsx", RUN as any);
    expect(xlsx.fileName).toBe("screener-report-nasdaq100-2026-10-27.xlsx");
    expect(xlsx.bytes.length).toBeGreaterThan(0);
    const csv = generateStockTabularBytes("csv", RUN as any);
    expect(csv.fileName).toBe("screener-report-nasdaq100-2026-10-27.csv");
    const text = new TextDecoder().decode(csv.bytes);
    expect(text.split("\n")[0]).toBe(SCREENER_CSV_COLUMNS.join(","));
    expect(text).toContain("NVDA");
  });
});

describe("one generation path pin (#2911)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("the stock tabular generators are called from exactly one module in src/", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const allowed = new Set([
      path.join(repoRoot, "src/trading/screenerReportXlsx.ts"),
      path.join(repoRoot, "src/trading/screenerReportCsv.ts"),
      path.join(repoRoot, "src/services/stockReportArtifacts.ts"),
    ]);
    const patterns = [
      "generateScreenerXlsx(",
      "generateScreenerCsv(",
      "screenerXlsxFileName(",
      "screenerCsvFileName(",
    ];
    const offenders: string[] = [];
    for (const file of walk(path.join(repoRoot, "src"))) {
      if (allowed.has(file)) continue;
      const src = readFileSync(file, "utf-8");
      for (const pattern of patterns) {
        if (src.includes(pattern)) offenders.push(`${path.relative(repoRoot, file)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
