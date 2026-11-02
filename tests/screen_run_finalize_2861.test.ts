/**
 * Issue #2861 (Phase 2 Slice 3 under #2764) — pins for
 * persistThenDeliverAll, the one persist-then-deliver finalizer
 * for the two REST stock-screen routes.
 *
 * The E*TRADE ALL sharded path previously delivered every shard
 * before persisting any of them; this slice unifies all four
 * REST paths (E*TRADE single + sharded, market-data single +
 * sharded) on persist-first, per result, in list order.
 */
import { describe, expect, it } from "vitest";
import { persistThenDeliverAll } from "../src/workflows/screenRunFinalize";

describe("persistThenDeliverAll", () => {
  it("persists each result before delivering it, in list order", async () => {
    const order: string[] = [];
    await persistThenDeliverAll({
      results: ["a", "b"],
      persist: async (r) => {
        order.push(`persist:${r}`);
      },
      deliver: async (r) => {
        order.push(`deliver:${r}`);
      },
    });
    expect(order).toEqual([
      "persist:a",
      "deliver:a",
      "persist:b",
      "deliver:b",
    ]);
  });

  it("is persist-only when no deliver step is supplied (market-data)", async () => {
    const persisted: string[] = [];
    await persistThenDeliverAll({
      results: ["a"],
      persist: async (r) => {
        persisted.push(r);
      },
    });
    expect(persisted).toEqual(["a"]);
  });

  it("still persists then delivers a failed shard (shard behaviour preserved)", async () => {
    const order: string[] = [];
    const failed = { success: false, universe: "NASDAQ100" };
    await persistThenDeliverAll({
      results: [failed],
      persist: async () => {
        order.push("persist");
      },
      deliver: async () => {
        order.push("deliver");
      },
    });
    expect(order).toEqual(["persist", "deliver"]);
  });

  it("a persist failure propagates and the result is not delivered", async () => {
    const delivered: string[] = [];
    await expect(
      persistThenDeliverAll({
        results: ["a", "b"],
        persist: async (r) => {
          if (r === "a") throw new Error("persist failed");
        },
        deliver: async (r) => {
          delivered.push(r);
        },
      }),
    ).rejects.toThrow("persist failed");
    expect(delivered).toEqual([]);
  });

  it("handles an empty result list as a no-op", async () => {
    await expect(
      persistThenDeliverAll({
        results: [],
        persist: async () => {
          throw new Error("must not be called");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
