import { describe, expect, it } from "vitest";
import {
  assembleOptionsResult,
  assembleOptionsResultForServe,
} from "../src/services/unifiedReportPipeline";

const dataset = { scanned: 2, withTrades: 1, coverage: { considered: 2, evaluated: 2 } };

// Sharded rows: PDF renderer failed (completed job carrying a failed
// outcome), XLSX and CSV generated with keys, stores verified.
const rows = [
  { stage: "generate", shardKey: "pdf", status: "completed", result: { format: "pdf", status: "failed", error: "PDF renderer failed" } },
  { stage: "generate", shardKey: "xlsx", status: "completed", result: { format: "xlsx", key: "options:xlsx:run1", fileName: "run1.xlsx" } },
  { stage: "generate", shardKey: "csv", status: "completed", result: { format: "csv", key: "options:csv:run1", fileName: "run1.csv" } },
  { stage: "store", shardKey: "xlsx", status: "completed", result: {} },
  { stage: "store", shardKey: "csv", status: "completed", result: {} },
] as const;

describe("P0 artifact contract (#2621)", () => {
  it("serve assembly: a failed PDF contributes no key/link but XLSX+CSV still ship", () => {
    const assembled = assembleOptionsResultForServe(rows as never, dataset);
    expect(assembled.links.pdfStatus).toBe("failed");
    expect(assembled.links.pdfKey).toBeUndefined();
    expect(assembled.links.pdfError).toBe("PDF renderer failed");
    expect(assembled.links.xlsxStatus).toBe("generated");
    expect(assembled.links.xlsxKey).toBe("options:xlsx:run1");
    expect(assembled.links.csvStatus).toBe("generated");
    expect(assembled.links.csvKey).toBe("options:csv:run1");
    expect(assembled.anyGenerated).toBe(true);
    expect(assembled.allFailed).toBe(false);
  });

  it("sync and sharded assemblies agree on links for the same outcomes", () => {
    const sharded = assembleOptionsResultForServe(rows as never, dataset);
    const sync = assembleOptionsResult({
      dataset,
      artifacts: {
        pdf: { format: "pdf", status: "failed", error: "PDF renderer failed" },
        xlsx: { format: "xlsx", status: "generated", key: "options:xlsx:run1", fileName: "run1.xlsx" },
        csv: { format: "csv", status: "generated", key: "options:csv:run1", fileName: "run1.csv" },
      },
    });
    expect(sync.links).toEqual(sharded.links);
    expect(sync.coverage).toEqual(sharded.coverage);
  });
});
