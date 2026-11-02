/**
 * Issue #2599 (F2): sharded publish-nothing gates must surface a
 * coded reason instead of a silent empty result.
 *
 * Planner-level pins (no executor, no storage): an options chain
 * whose generate/store legs are per-format outcomes advances past
 * a failed leg once every leg of the stage is terminal, and the
 * serve outcome carries the failed leg's error with no fabricated
 * link. Stock chains keep the C3 stop semantics byte for byte.
 */
import { describe, expect, it } from "vitest";
import {
  planServeJob,
  planShardAdvance,
  type ShardChainContext,
  type ShardRow,
} from "../src/services/shardJobs";

const chain = (over: Partial<ShardChainContext> = {}): ShardChainContext => ({
  chainId: "chain-1",
  screenType: "options",
  universe: "symbols",
  userLogin: "u1",
  trigger: "scheduled",
  timestamp: "2026-10-24T12:00:00.000Z",
  channels: ["slack"],
  options: { symbols: ["AAPL"], thesis: "bullish" },
  ...over,
});

const stockChain = (): ShardChainContext => ({
  chainId: "chain-stock",
  screenType: "stock",
  universe: "NASDAQ100",
  userLogin: "u1",
  trigger: "scheduled",
  timestamp: "2026-10-24T12:00:00.000Z",
  channels: ["slack"],
});

const row = (over: Partial<ShardRow> & { jobId: string }): ShardRow => ({
  stage: "generate",
  status: "completed",
  createdAt: "2026-10-24T12:00:00.000Z",
  ...over,
});

const gen = (format: string, key: string) =>
  row({
    jobId: `gen-${format}`,
    stage: "generate",
    shardKey: format,
    result: { format, key, fileName: `${format}.bin` },
  });

const assembleRow = () =>
  row({
    jobId: "gen-assemble",
    stage: "generate",
    shardKey: "assemble",
    result: { scanned: 1, withTrades: 1, opportunities: [], coverage: { evaluated: 1, considered: 1 } },
  });

const advance = (c: ShardChainContext, rows: ShardRow[], completedKey = "csv") =>
  planShardAdvance({
    chain: c,
    rows,
    completedStage: "generate",
    completedKey,
    rootJobId: "root",
    nowIso: "2026-10-24T12:00:00.000Z",
  });

const outcomeOf = (sub: unknown) => (sub as { payload: { outcome: Record<string, unknown> } }).payload.outcome;

describe("F2 options generate gate (planShardAdvance)", () => {
  it("advances completed formats to store when a sibling leg failed", () => {
    const specs = advance(chain(), [
      assembleRow(),
      row({ jobId: "gen-pdf", stage: "generate", shardKey: "pdf", status: "failed", error: "PDF renderer boom" }),
      gen("xlsx", "options:xlsx:1"),
      gen("csv", "options:csv:1"),
    ]);
    const keys = specs.map((s) => (s.payload as { shard: { key: string } }).shard.key).sort();
    expect(keys).toEqual(["csv", "xlsx"]);
    expect(specs.every((s) => s.stage === "store")).toBe(true);
  });

  it("waits while any format is still running (no strand-behind-store)", () => {
    const specs = advance(chain(), [
      assembleRow(),
      row({ jobId: "gen-pdf", stage: "generate", shardKey: "pdf", status: "failed", error: "PDF renderer boom" }),
      gen("xlsx", "options:xlsx:1"),
    ]);
    expect(specs).toEqual([]);
  });

  it("plans serve (not a stall) when every format failed", () => {
    const specs = advance(chain(), [
      assembleRow(),
      row({ jobId: "gen-pdf", stage: "generate", shardKey: "pdf", status: "failed", error: "PDF renderer boom" }),
      row({ jobId: "gen-xlsx", stage: "generate", shardKey: "xlsx", status: "failed", error: "XLSX boom" }),
      row({ jobId: "gen-csv", stage: "generate", shardKey: "csv", status: "failed", error: "CSV boom" }),
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].stage).toBe("serve");
    const outcome = outcomeOf(specs[0]);
    expect(outcome.pdfStatus).toBe("failed");
    expect(outcome.pdfError).toBe("PDF renderer boom");
    expect(outcome.xlsxError).toBe("XLSX boom");
    expect(outcome.csvError).toBe("CSV boom");
    expect(outcome.pdfKeys).toEqual([]);
  });

  it("still blocks on a failed assemble shard (a blocker, not a leg)", () => {
    const specs = advance(chain(), [
      row({ jobId: "gen-assemble", stage: "generate", shardKey: "assemble", status: "failed", error: "assemble boom" }),
      gen("pdf", "options:pdf:1"),
      gen("xlsx", "options:xlsx:1"),
      gen("csv", "options:csv:1"),
    ]);
    expect(specs).toEqual([]);
  });

  it("stock chains keep the C3 stop: any failed generate leg halts", () => {
    const specs = planShardAdvance({
      chain: stockChain(),
      rows: [
        row({ jobId: "gen-assemble", stage: "generate", shardKey: "assemble", result: {} }),
        row({ jobId: "gen-pdf", stage: "generate", shardKey: "pdf", status: "failed", error: "PDF boom" }),
        gen("xlsx", "screener:xlsx:1"),
        gen("csv", "screener:csv:1"),
      ],
      completedStage: "generate",
      completedKey: "csv",
      rootJobId: "root",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs).toEqual([]);
  });
});

describe("F2 options store gate (planShardAdvance)", () => {
  it("advances to serve when a stored format exists and the rest are terminal", () => {
    const specs = planShardAdvance({
      chain: chain(),
      rows: [
        assembleRow(),
        gen("pdf", "options:pdf:1"),
        gen("xlsx", "options:xlsx:1"),
        row({ jobId: "store-pdf", stage: "store", shardKey: "pdf", status: "failed", error: "blob unreadable" }),
        row({ jobId: "store-xlsx", stage: "store", shardKey: "xlsx", result: { format: "xlsx", key: "options:xlsx:1", reportId: "r1" } }),
      ],
      completedStage: "store",
      completedKey: "xlsx",
      rootJobId: "root",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].stage).toBe("serve");
  });

  it("waits while a planned store leg is still running", () => {
    const specs = planShardAdvance({
      chain: chain(),
      rows: [
        assembleRow(),
        gen("pdf", "options:pdf:1"),
        gen("xlsx", "options:xlsx:1"),
        row({ jobId: "store-pdf", stage: "store", shardKey: "pdf", status: "running" }),
        row({ jobId: "store-xlsx", stage: "store", shardKey: "xlsx", result: { format: "xlsx", key: "options:xlsx:1", reportId: "r1" } }),
      ],
      completedStage: "store",
      completedKey: "xlsx",
      rootJobId: "root",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs).toEqual([]);
  });
});

describe("F2 serve outcome overlay (planServeJob)", () => {
  it("drops a store-failed PDF from the links and carries its error", () => {
    const sub = planServeJob(
      chain(),
      "assemble-1",
      [
        assembleRow(),
        gen("pdf", "options:pdf:1"),
        gen("xlsx", "options:xlsx:1"),
        row({ jobId: "store-pdf", stage: "store", shardKey: "pdf", status: "failed", error: "blob options:pdf:1 is not readable." }),
        row({ jobId: "store-xlsx", stage: "store", shardKey: "xlsx", result: { format: "xlsx", key: "options:xlsx:1", reportId: "r1" } }),
      ],
      "2026-10-24T12:00:00.000Z",
    );
    const outcome = outcomeOf(sub);
    expect(outcome.pdfStatus).toBe("failed");
    expect(outcome.pdfKeys).toEqual([]);
    expect(outcome.pdfError).toBe("blob options:pdf:1 is not readable.");
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.xlsxKey).toBe("options:xlsx:1");
    expect(outcome.reportUrl).toBeUndefined();
  });

  it("carries a generate-failed leg's error with no fabricated link", () => {
    const sub = planServeJob(
      chain(),
      "assemble-1",
      [
        assembleRow(),
        row({ jobId: "gen-pdf", stage: "generate", shardKey: "pdf", status: "failed", error: "PDF renderer boom" }),
        gen("xlsx", "options:xlsx:1"),
        gen("csv", "options:csv:1"),
      ],
      "2026-10-24T12:00:00.000Z",
    );
    const outcome = outcomeOf(sub);
    expect(outcome.pdfStatus).toBe("failed");
    expect(outcome.pdfError).toBe("PDF renderer boom");
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.csvStatus).toBe("generated");
  });

  it("stock serve mapping is untouched (no error overlay)", () => {
    const sub = planServeJob(
      stockChain(),
      "assemble-1",
      [
        row({ jobId: "gen-assemble", stage: "generate", shardKey: "assemble", result: { totalScanned: 5, matchedCount: 1 } }),
        row({ jobId: "gen-pdf", stage: "generate", shardKey: "pdf", status: "failed", error: "PDF boom" }),
        gen("xlsx", "screener:xlsx:1"),
      ],
      "2026-10-24T12:00:00.000Z",
    );
    const outcome = outcomeOf(sub);
    expect(outcome.pdfStatus).toBe("failed");
    expect("pdfError" in outcome).toBe(false);
    expect(outcome.xlsxKey).toBe("screener:xlsx:1");
  });
});
