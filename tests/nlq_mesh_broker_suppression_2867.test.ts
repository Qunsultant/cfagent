/**
 * Issue #2867 (Phase 2 Slice 7 under #2764) — pins for the
 * broker policies NLQ + mesh now share, and for (runId,
 * destination) delivery suppression.
 *
 * - shardsForUniverse: the one shard policy previously
 *   written out in the REST broker, the NLQ chat-screen
 *   builder, and the mesh door builder.
 * - NLQ fallback planning: the direct fallback path plans
 *   through planStockScreenRun (universe from the filters,
 *   else the planner default — identical to runScreenInner).
 * - Suppression: first claim sends, second claim suppresses;
 *   email recipients distinguish destinations; a failed send
 *   releases its claim so a retry may send.
 */
import { describe, expect, it } from "vitest";
import { shardsForUniverse } from "../src/workflows/screenExecutionBroker";
import { planStockScreenRun } from "../src/workflows/stockScreenPlanner";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
  deliverySuppressionKey,
} from "../src/workflows/screenDeliverySuppression";
import { shardableUniverses } from "../src/trading";

describe("shardsForUniverse (broker shard policy)", () => {
  it("fans ALL out to every shardable universe", () => {
    expect(shardsForUniverse("ALL")).toEqual(
      shardableUniverses().map((u) => ({ shardId: u, universe: u })),
    );
    expect(shardsForUniverse("ALL").length).toBeGreaterThan(1);
  });

  it("keeps a single universe as its own single shard", () => {
    expect(shardsForUniverse("NASDAQ100")).toEqual([
      { shardId: "NASDAQ100", universe: "NASDAQ100" },
    ]);
  });
});

describe("NLQ fallback planning", () => {
  it("defaults an absent universe to TECH, like runScreenInner", () => {
    const plan = planStockScreenRun(
      { trigger: "manual", filters: {} },
      "2026-11-02T13:00:00.000Z",
    );
    expect(plan.universe).toBe("TECH");
  });

  it("carries an explicit universe through unchanged", () => {
    const plan = planStockScreenRun(
      { trigger: "manual", filters: {}, universe: "ALL" as never },
      "2026-11-02T13:00:00.000Z",
    );
    expect(plan.universe).toBe("ALL");
  });
});

describe("delivery suppression (runId, destination)", () => {
  it("builds a trimmed canonical key", () => {
    expect(deliverySuppressionKey(" run-1 ", " slack ")).toBe("run-1::slack");
  });

  it("distinguishes email recipients, lowercased", () => {
    expect(deliveryDestinationFor("email", "User@Example.com")).toBe("email:user@example.com");
    expect(deliveryDestinationFor("slack")).toBe("slack");
    expect(deliveryDestinationFor("webhook")).toBe("webhook");
  });

  it("sends on first claim and suppresses the second for the same pair", () => {
    const suppressor = createDeliverySuppressor();
    expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(suppressor.tryClaim("run-1", "slack")).toBe(false);
    expect(suppressor.wasClaimed("run-1", "slack")).toBe(true);
    // A different destination for the same run is a different delivery.
    expect(suppressor.tryClaim("run-1", "email:a@example.com")).toBe(true);
    // A different run to the same destination is a different delivery.
    expect(suppressor.tryClaim("run-2", "slack")).toBe(true);
  });

  it("releases a failed send so a retry may send", () => {
    const suppressor = createDeliverySuppressor();
    expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
    suppressor.release("run-1", "slack");
    expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
  });

  it("keeps distinct email recipients distinct", () => {
    const suppressor = createDeliverySuppressor();
    expect(suppressor.tryClaim("run-1", deliveryDestinationFor("email", "a@example.com"))).toBe(true);
    expect(suppressor.tryClaim("run-1", deliveryDestinationFor("email", "b@example.com"))).toBe(true);
    expect(suppressor.tryClaim("run-1", deliveryDestinationFor("email", "A@EXAMPLE.COM"))).toBe(false);
  });
});
