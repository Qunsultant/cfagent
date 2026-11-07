import { describe, expect, it, vi } from "vitest";
import { planServeJob } from "../src/services/shardJobs";
import { recordOptionsServeReport } from "../src/services/optionsServeRecord";
import { runSummaryFromScanRun } from "../src/services/runSummaries";
import type { ScanRunSummary } from "../src/trading/options/scanRunStore";

function chainBase(): Parameters<typeof planServeJob>[0] {
  return {
    chainId: "chain-1",
    screenType: "options",
    universe: "NASDAQ100",
    userLogin: "tester",
    trigger: "scheduled",
    timestamp: "2026-10-28T12:00:00.000Z",
    options: { symbols: ["NVDA", "AAPL"], thesis: "bullish", targetDate: "2026-11-27", riskProfile: "balanced" },
  } as Parameters<typeof planServeJob>[0];
}

function fakeOrm() {
  const rows: unknown[] = [];
  const byGeneration = new Map<string, string>();
  return {
    rows,
    storeCanonicalReport: vi.fn((input: Record<string, unknown>) => {
      const generationId = String(input.generationId ?? "");
      const existing = byGeneration.get(generationId);
      if (existing) return { reportId: existing, created: false };
      const reportId = `rep-${rows.length + 1}`;
      rows.push(input);
      byGeneration.set(generationId, reportId);
      return { reportId, created: true };
    }),
  };
}

function fakeStorage() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    store,
  };
}

describe("Options chain record wiring (#2091)", () => {
  it("serve outcome carries the run timestamp and symbols for the record step", () => {
    const rows = [
      { jobId: "a", stage: "generate", status: "completed", shardKey: "assemble", result: { scanned: 2, withTrades: 1, opportunities: [], coverage: { evaluated: 2, considered: 2 } } },
      { jobId: "p", stage: "generate", status: "completed", shardKey: "pdf", result: { format: "pdf", key: "report:pdf:abc", fileName: "options.pdf" } },
      { jobId: "x", stage: "generate", status: "completed", shardKey: "xlsx", result: { format: "xlsx", key: "report:xlsx:abc", fileName: "options.xlsx" } },
      { jobId: "c", stage: "generate", status: "completed", shardKey: "csv", result: { format: "csv", key: "report:csv:abc", fileName: "options.csv" } },
    ] as Parameters<typeof planServeJob>[2];
    const job = planServeJob(chainBase(), "assemble-job", rows, "2026-10-28T12:00:00.000Z");
    const outcome = (job.payload as { outcome: Record<string, unknown> }).outcome;
    expect(outcome.timestamp).toBe("2026-10-28T12:00:00.000Z");
    expect(outcome.symbols).toEqual(["NVDA", "AAPL"]);
    expect(outcome.xlsxKey).toBe("report:xlsx:abc");
    expect(outcome.csvKey).toBe("report:csv:abc");
  });

  it("record helper writes one canonical row with all three keys", async () => {
    const orm = fakeOrm();
    const storage = fakeStorage();
    const written = await recordOptionsServeReport(
      { orm: orm as never, storage: storage as never },
      {
        kind: "options", trigger: "scheduled", success: true,
        timestamp: "2026-10-28T12:00:00.000Z", thesis: "bullish",
        symbols: ["NVDA"], totalScanned: 1, matchedCount: 1,
        summary: "Options screen — bullish: 1 actionable setup.",
        pdfKeys: ["report:pdf:abc"], pdfStatus: "generated",
        xlsxKey: "report:xlsx:abc", xlsxStatus: "generated",
        csvKey: "report:csv:abc", csvStatus: "generated",
        reportUrl: "https://agent.openaimp.com/api/options/report.pdf?key=report%3Apdf%3Aabc",
        opportunities: [],
      } as never,
    );
    expect(written).toBe(true);
    expect(orm.rows).toHaveLength(1);
    const body = (orm.rows[0] as { body: Record<string, unknown> }).body;
    expect(body.pdfKey).toBe("report:pdf:abc");
    expect(body.xlsxKey).toBe("report:xlsx:abc");
    expect(body.csvKey).toBe("report:csv:abc");
  });

  it("record helper upserts the options history row by timestamp instead of duplicating it", async () => {
    const orm = fakeOrm();
    const storage = fakeStorage();
    const outcome = {
      kind: "options", trigger: "scheduled", success: true,
      timestamp: "2026-10-28T12:00:00.000Z", thesis: "bullish",
      symbols: ["NVDA"], totalScanned: 1, matchedCount: 1, summary: "s",
      pdfKeys: ["report:pdf:abc"], pdfStatus: "generated",
      xlsxKey: "report:xlsx:abc", xlsxStatus: "generated",
      csvKey: "report:csv:abc", csvStatus: "generated",
      opportunities: [],
    } as never;
    await recordOptionsServeReport({ orm: orm as never, storage: storage as never }, outcome);
    await recordOptionsServeReport({ orm: orm as never, storage: storage as never }, outcome);
    const runs = await storage.get("options:last_runs");
    expect(Array.isArray(runs)).toBe(true);
    const matching = (runs as Array<Record<string, unknown>>).filter((r) => r.timestamp === "2026-10-28T12:00:00.000Z");
    expect(matching).toHaveLength(1);
    expect(matching[0].pdfKey).toBe("report:pdf:abc");
    expect(matching[0].xlsxKey).toBe("report:xlsx:abc");
    expect(matching[0].csvKey).toBe("report:csv:abc");
    expect(orm.rows).toHaveLength(1);
  });

  it("record helper skips non-options outcomes and outcomes without a timestamp", async () => {
    const orm = fakeOrm();
    const storage = fakeStorage();
    const base = {
      trigger: "scheduled", success: true, thesis: "bullish", symbols: ["NVDA"],
      totalScanned: 1, matchedCount: 1, summary: "s",
      pdfKeys: ["report:pdf:abc"], pdfStatus: "generated", opportunities: [],
    };
    expect(await recordOptionsServeReport({ orm: orm as never, storage: storage as never }, { ...base, kind: "stock", timestamp: "2026-10-28T12:00:00.000Z" } as never)).toBe(false);
    expect(await recordOptionsServeReport({ orm: orm as never, storage: storage as never }, { ...base, kind: "options" } as never)).toBe(false);
    expect(orm.rows).toHaveLength(0);
  });

  it("record helper warns and continues when the canonical write fails", async () => {
    const orm = { storeCanonicalReport: vi.fn(() => { throw new Error("boom"); }) };
    const storage = fakeStorage();
    // #3515 S3: the canonical-write failure now travels as a structured
    // optionsServeRecord.canonical_write_failed event (level warn) on the
    // console-info JSON fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const written = await recordOptionsServeReport(
      { orm: orm as never, storage: storage as never },
      {
        kind: "options", trigger: "scheduled", success: true,
        timestamp: "2026-10-28T12:00:00.000Z", thesis: "bullish",
        symbols: ["NVDA"], totalScanned: 1, matchedCount: 1, summary: "s",
        pdfKeys: ["report:pdf:abc"], pdfStatus: "generated", opportunities: [],
      } as never,
    );
    expect(written).toBe(false);
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const failed = events.find((e) => e.operation === "optionsServeRecord.canonical_write_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(String(failed?.fields.error ?? "")).toContain("boom");
    expect(String(failed?.fields.message ?? "")).toContain("canonical write failed");
    infoSpy.mockRestore();
    const runs = await storage.get("options:last_runs");
    expect(Array.isArray(runs)).toBe(true);
    expect((runs as unknown[]).filter((r) => (r as { timestamp: string }).timestamp === "2026-10-28T12:00:00.000Z")).toHaveLength(1);
  });

  it("scan-run mapper carries workbook keys instead of hardcoded nulls", () => {
    const scan = {
      id: "scan-1", generatedAt: "2026-10-28T12:00:00.000Z", mode: "per_name_best",
      modelVersion: "v1", gate: { fit: 1, borderline: 0, noFit: 0 },
      coverage: { considered: 1, scanned: 1, evaluated: 1, errors: 0, withTrades: 1, eventCalendar: { covered: 1, total: 1, coveragePct: 100 } },
      profileRef: null, pdfKey: "report:pdf:abc", xlsxKey: "report:xlsx:abc", csvKey: "report:csv:abc",
      trigger: "scheduled",
    } as unknown as ScanRunSummary;
    const summary = runSummaryFromScanRun(scan);
    expect(summary.xlsxKey).toBe("report:xlsx:abc");
    expect(summary.csvKey).toBe("report:csv:abc");
    expect(summary.xlsxUrl).toMatch(/xlsx/);
    expect(summary.csvUrl).toMatch(/csv/);
    // Issue #3264: the recorded trigger reaches the Docs Run Type
    // instead of rendering "—".
    expect(summary.trigger).toBe("scheduled");
  });

  it("scan-run mapper keeps trigger null when the row records none (never guessed)", () => {
    const scan = {
      id: "scan-2", generatedAt: "2026-10-28T12:00:00.000Z", mode: "per_name_best",
      modelVersion: "v1", gate: { fit: 1, borderline: 0, noFit: 0 },
      coverage: { considered: 1, scanned: 1, evaluated: 1, errors: 0, withTrades: 1, eventCalendar: { covered: 1, total: 1, coveragePct: 100 } },
      profileRef: null, pdfKey: "report:pdf:abc",
    } as unknown as ScanRunSummary;
    expect(runSummaryFromScanRun(scan).trigger).toBeNull();
  });

  it("scan-run save with trigger persists it on the listed row (#3264)", async () => {
    const { InMemoryScanRunStore } = await import("../src/data/inMemoryScanRunAdapter");
    const store = new InMemoryScanRunStore({ idFactory: () => "scan-trigger-1" });
    const result = {
      generatedAt: "2026-10-28T12:00:00.000Z", mode: "per_name_best", modelVersion: "v1",
      gate: { fit: 1, borderline: 0, noFit: 0 },
      coverage: { considered: 1, scanned: 1, evaluated: 1, errors: 0, withTrades: 1, eventCalendar: { covered: 1, total: 1, coveragePct: 100 } },
      profileRef: null,
    } as unknown as Parameters<typeof store.save>[0];
    await store.save(result, { userLogin: "tester", trigger: "scheduled" });
    const rows = await store.list({ userLogin: "tester" });
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("scheduled");
  });
});
