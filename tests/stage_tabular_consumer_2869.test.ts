/**
 * Issue #2869 slice 3 (under #2764) — the tabular-aware
 * stage consumer for the chain generate leg. Pins the
 * consumer discipline, not the shard executor's dispatch:
 * persisted dataset only, format-specific claims with
 * release-on-failure, poison dead-lettered, injected
 * generate/store, and no live fetch anywhere.
 */
import { describe, expect, it, vi } from "vitest";
import {
  consumeTabularGenerate,
  tabularClaimKey,
} from "../src/workflows/stageTabularConsumer";

function claimsStore() {
  const seen = new Set<string>();
  return {
    has: (key: string) => seen.has(key),
    add: (key: string) => {
      seen.add(key);
    },
    delete: (key: string) => {
      seen.delete(key);
    },
  };
}

describe("stage tabular consumer #2869 slice 3", () => {
  it("generates one format from a persisted dataset and stores it", async () => {
    const generate = vi.fn(async () => ({
      fileName: "screen.xlsx",
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const store = vi.fn(async () => {});
    const out = await consumeTabularGenerate({
      runId: "screener:chain-1",
      format: "xlsx",
      dataset: { totalScanned: 10, matchedCount: 2 },
      keyPrefix: "screener:xlsx:",
      generate,
      store,
    });
    expect(out.status).toBe("generated");
    expect(out.key).toMatch(/^screener:xlsx:/);
    expect(out.fileName).toBe("screen.xlsx");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0].contentType).toContain("spreadsheetml");
  });

  it("uses a format-specific claim key and duplicate-suppresses a redelivery", async () => {
    expect(tabularClaimKey("screener:chain-1", "csv")).toBe(
      "screener:chain-1::generate:csv",
    );
    const claims = claimsStore();
    const generate = vi.fn(async () => ({
      fileName: "screen.csv",
      bytes: new Uint8Array([4]),
    }));
    const store = vi.fn(async () => {});
    const args = {
      runId: "screener:chain-1",
      format: "csv" as const,
      dataset: { totalScanned: 10 },
      keyPrefix: "screener:csv:",
      claims,
      generate,
      store,
    };
    const first = await consumeTabularGenerate(args);
    expect(first.status).toBe("generated");
    const second = await consumeTabularGenerate(args);
    expect(second.status).toBe("duplicate-suppressed");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when generation throws, so a retry may generate", async () => {
    const claims = claimsStore();
    let attempts = 0;
    const generate = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return { fileName: "screen.xlsx", bytes: new Uint8Array([1]) };
    });
    const store = vi.fn(async () => {});
    const args = {
      runId: "screener:chain-2",
      format: "xlsx" as const,
      dataset: { totalScanned: 5 },
      keyPrefix: "screener:xlsx:",
      claims,
      generate,
      store,
    };
    await expect(consumeTabularGenerate(args)).rejects.toThrow("boom");
    const retry = await consumeTabularGenerate(args);
    expect(retry.status).toBe("generated");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("refuses a missing dataset loudly instead of fabricating one", async () => {
    const generate = vi.fn(async () => ({
      fileName: "screen.csv",
      bytes: new Uint8Array([1]),
    }));
    const store = vi.fn(async () => {});
    await expect(
      consumeTabularGenerate({
        runId: "screener:chain-3",
        format: "csv",
        dataset: null,
        keyPrefix: "screener:csv:",
        generate,
        store,
      }),
    ).rejects.toThrow(/missing/);
    expect(generate).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("dead-letters a poison format without generating or storing", async () => {
    const generate = vi.fn(async () => ({
      fileName: "x",
      bytes: new Uint8Array([1]),
    }));
    const store = vi.fn(async () => {});
    const dead = vi.fn(async () => {});
    const out = await consumeTabularGenerate({
      runId: "screener:chain-4",
      format: "pdf" as never,
      dataset: { totalScanned: 1 },
      keyPrefix: "screener:xlsx:",
      generate,
      store,
      deadLetter: dead,
    });
    expect(out.status).toBe("dead-lettered");
    expect(dead).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("the chain tabular leg delegates to the consumer (source pin)", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(
      "src/services/shardExecutors.ts",
      "utf8",
    );
    const start = text.indexOf("async function generateTabular");
    const end = text.indexOf("async function storeFormat", start);
    const body = text.slice(start, end);
    expect(body).toContain("consumeTabularGenerate");
    expect(body).toContain("stageTabularConsumer");
    // The one generation module still supplies the bytes,
    // but only as the consumer's injected generate fn —
    // never as a direct leg bypassing the consumer.
    expect(body).toContain("generateStockTabularBytes");
  });
});
