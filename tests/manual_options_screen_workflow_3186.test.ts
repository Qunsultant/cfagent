/**
 * Issue #3186 step 3d - manual entry migration pin: the manual
 * options screen (executeOptionsScreen) runs the one options
 * pipeline instead of the registry provider, with the SAME
 * Response, the SAME canonical row, and the SAME job outcome.
 * Only the path changes. The pin runs the handler end to end with
 * stubbed report/delivery seams (PDF generation fails in the test
 * env exactly as it does on the registry path - the handler records
 * the failure, never throws it).
 *
 * The pipeline's run id IS the route's generation id
 * (options_scanner:manual:<iso>), so the pipeline's canonical row
 * is the route's row - no duplicate. The #3072 end-of-run emitter
 * retires for this entry: the pipeline publishes per-stage
 * messages instead.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { executeOptionsScreen } from "../src/agents/routes/etradeOptionsScreen";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import { listJobOutcomes } from "../src/services/jobOutcomes";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("manual options screen through the one pipeline (#3186 step 3d)", () => {
  it("returns the same Response, canonical row and job outcome as the registry path", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const storage = memoryStorage();
    const fakeAgent = {
      generateAndStoreOptionsXlsx: async () => ({ key: "xlsx-key-1", fileName: "options.xlsx" }),
      generateAndStoreOptionsCsv: async () => ({ key: "csv-key-1", fileName: "options.csv" }),
      getPdfByKey: async () => null,
      getOptionsXlsxByKey: async () => ({ bytes: new Uint8Array([1]), fileName: "options.xlsx" }),
      getOptionsCsvByKey: async () => ({ bytes: new Uint8Array([1]), fileName: "options.csv" }),
    };
    const ctx = {
      env: {},
      getOrm: () => orm,
      agentCtx: { storage: { ...storage, sql } },
      ensureTables: () => sql,
      getScreenerAgent: () => fakeAgent,
      requestedEnv: undefined,
    } as never;

    const res = await executeOptionsScreen({
      ctx,
      userLogin: "owner@example.com",
      screener,
      screenFilter: { underlyingSymbols: ["AAPL"] },
      screenPushToSlack: false,
      screenSlackChannel: undefined,
      screenUniverseLabel: undefined,
      screenEmailTo: undefined,
      deferDelivery: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["matchedCount"]).toBe(2);
    expect((body["contracts"] as unknown[]).length).toBe(2);
    expect(body["pdfKey"]).toBeUndefined();
    expect(body["reportUrl"]).toBeUndefined();
    expect(body["xlsxKey"]).toBe("xlsx-key-1");
    expect(body["xlsxUrl"]).toBe("/api/options/report.xlsx?key=xlsx-key-1");
    expect(body["csvKey"]).toBe("csv-key-1");
    expect(body["csvUrl"]).toBe("/api/options/report.csv?key=csv-key-1");

    const rows = Array.from(sql.exec("SELECT * FROM mas_reports")) as any[];
    expect(rows).toHaveLength(1);
    expect(String(rows[0].run_id)).toMatch(/^options_scanner:manual:/);
    expect(rows[0].source).toBe("options_scanner");
    const rowBody = JSON.parse(String(rows[0].body));
    expect(rowBody.xlsxKey).toBe("xlsx-key-1");
    expect(rowBody.csvKey).toBe("csv-key-1");
    expect(rowBody.filter.underlyingSymbols).toEqual(["AAPL"]);
    expect(rowBody.result.matchedCount).toBe(2);

    const outcomes = listJobOutcomes(sql as never);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe("options");
    expect(outcomes[0].status).toBe("completed");
    expect(outcomes[0].origin).toBe("manual-options-inline");

    // The migration's additions: the pipeline left its evidence -
    // all eight stage artifacts under the run's generation id, and
    // the canonical row is the pipeline's row (one row, not two -
    // the shapeReport re-record backfilled the keys onto it).
    expect(storage.keys()).toHaveLength(8);
    const runId = String(rows[0].run_id);
    expect(storage.keys().every((key) => key.startsWith(`options:${runId}:`))).toBe(true);
    const screenArtifact = await storage.get<{ result: Record<string, unknown> }>(
      `options:${runId}:screen`,
    );
    expect(screenArtifact?.result["matchedCount"]).toBe(2);
  });
});
