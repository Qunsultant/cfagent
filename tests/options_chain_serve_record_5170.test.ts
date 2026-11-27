import { describe, it, expect, vi } from "vitest";
import { persistOptionsServeReport } from "../src/agents/orchestrator/reportDispatch";
import {
  createOptionsChainStepRegistry,
  type OptionsChainStepDeps,
} from "../src/services/optionsChainPipelineJobs";
import { OPTIONS_CHAIN_SERVE_STEP } from "../src/services/optionsChainJobDefinition";
import * as optionsServeRecord from "../src/services/optionsServeRecord";

describe("#5170 — engine options chain writes the serve-record summary row", () => {
  it("persistOptionsServeReport delegates to recordOptionsServeReport with DatabaseORM + storage", async () => {
    const spy = vi
      .spyOn(optionsServeRecord, "recordOptionsServeReport")
      .mockResolvedValue(true);
    const orm = { reports: {} } as never;
    const storage = { get: vi.fn(), put: vi.fn() } as never;
    const ok = await persistOptionsServeReport(
      {
        env: {} as never,
        ensureTables: vi.fn() as never,
        getOrm: () => orm,
        storage,
        reportDispatchHitlKey: "hitl",
        reportConfirmationTtlMs: 1000,
        sendReportEmail: vi.fn(),
        sendReportWebhook: vi.fn(),
      },
      {
        kind: "options",
        success: true,
        trigger: "scheduled",
        timestamp: "2026-11-19T19:00:00.000Z",
        userLogin: "alice",
        symbols: ["AAPL"],
        matchedCount: 1,
        pdfKeys: ["report:pdf:chain-1"],
      },
    );
    expect(ok).toBe(true);
    // #6101: persistOptionsServeReport threads ctx.env through to
    // recordOptionsServeReport (the D1 fold needs it).
    expect(spy).toHaveBeenCalledWith(
      { orm, storage, env: {} },
      expect.objectContaining({
        kind: "options",
        timestamp: "2026-11-19T19:00:00.000Z",
        userLogin: "alice",
      }),
    );
    spy.mockRestore();
  });

  it("runOptionsChainServe calls deps.recordServeReport after artifact verification", async () => {
    const recordServeReport = vi.fn().mockResolvedValue(true);
    const deps: OptionsChainStepDeps = {
      env: {} as never,
      engineStores: {} as never,
      queue: null,
      chainSourceFor: () => undefined,
      blobPut: async () => undefined,
      blobGet: async (key) => ({ bytes: new Uint8Array([1, 2, 3]), fileName: `${key}.bin` }),
      storeReport: async () => null,
      recordServeReport,
      deliverOutcome: async () => undefined,
    };
    const registry = createOptionsChainStepRegistry(deps);
    const handler = registry.resolve(OPTIONS_CHAIN_SERVE_STEP);

    const dataset = {
      thesis: "bullish",
      symbols: ["NVDA", "AAPL"],
      withTrades: 2,
      opportunities: [{ symbol: "NVDA" }],
      summary: "2 setups found",
    };

    const result = await handler({
      jobId: "options-chain:chain-5170",
      runId: "run-5170",
      stepId: "serve",
      params: {
        chain: {
          chainId: "chain-5170",
          userLogin: "alice",
          trigger: "scheduled",
          timestamp: "2026-11-19T19:05:00.000Z",
          symbols: ["NVDA", "AAPL"],
        },
      },
      input: {
        pdf: {
          status: "stored",
          canonicalReportId: "rep-pdf",
          generate: { status: "generated", key: "report:pdf:5170", fileName: "r.pdf", dataset },
        },
        xlsx: {
          status: "stored",
          canonicalReportId: "rep-xlsx",
          generate: { status: "generated", key: "report:xlsx:5170", fileName: "r.xlsx", dataset },
        },
        csv: {
          status: "stored",
          canonicalReportId: "rep-csv",
          generate: { status: "generated", key: "report:csv:5170", fileName: "r.csv", dataset },
        },
      },
    } as never);

    expect(result.descriptor).toContain("chain-5170");
    expect(recordServeReport).toHaveBeenCalledTimes(1);
    expect(recordServeReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "options",
        success: true,
        trigger: "scheduled",
        timestamp: "2026-11-19T19:05:00.000Z",
        userLogin: "alice",
        symbols: ["NVDA", "AAPL"],
        matchedCount: 2,
        pdfKeys: ["report:pdf:5170"],
        xlsxKey: "report:xlsx:5170",
        csvKey: "report:csv:5170",
        pdfStatus: "generated",
        xlsxStatus: "generated",
        csvStatus: "generated",
      }),
    );
  });
});
