/**
 * Issue #5524 — a chip must not promise what the system refuses.
 *
 * Two chip families in the Stock Copilot's registry outlived the truth:
 *  - `⚙️ Switch to Self-RSI mode` asks for a mode the gate refuses since
 *    #5056 (`resolveStockCopilotRsiModeState` keeps `governed` in effect;
 *    the door write is rejected and audited);
 *  - `⚡ Generate strategy code` / `🧪 Run sandboxed backtest` imply the §7
 *    synthesis pipeline, which is `specified_only` (#5056) and whose build
 *    is #5502. The generator behind them is dormant (no caller in `src/`).
 *
 * The replacement chips answer the real questions and route the user to the
 * governed proposal path (#5057), which is the capability that exists.
 */
import { describe, it, expect } from "vitest";
import { findCopilot } from "../src/client/chat/copilotRegistry";

function stockChips() {
  const chips = findCopilot("stock")?.quickChips ?? [];
  return {
    chips,
    prompts: chips.map((c) => c.prompt),
    labels: chips.map((c) => c.label),
    categories: chips.map((c) => c.category ?? ""),
  };
}

describe("Issue #5524 — Stock Copilot chips that promise what the system refuses", () => {
  it("has no chip that asks to switch to the gated self-RSI mode", () => {
    const { prompts, labels } = stockChips();
    expect(
      prompts.some((p) => /set rsi mode to self/i.test(p)),
      "a chip must not ask for a mode the door refuses (#5056)",
    ).toBe(false);
    expect(labels.some((l) => /switch to self-rsi mode/i.test(l))).toBe(false);
  });

  it("explains the gate instead of offering the switch", () => {
    const { prompts, labels } = stockChips();
    expect(labels.some((l) => /why is self-rsi unavailable/i.test(l))).toBe(true);
    expect(
      prompts.some((p) => /self-rsi.*(unavailable|not implemented)/i.test(p)),
    ).toBe(true);
  });

  it("stops implying the sandbox can synthesize and backtest a strategy", () => {
    const { prompts, labels } = stockChips();
    expect(labels.some((l) => /generate strategy code/i.test(l))).toBe(false);
    expect(labels.some((l) => /run sandboxed backtest/i.test(l))).toBe(false);
    expect(
      prompts.some((p) => /generate quantitative trading strategy code/i.test(p)),
    ).toBe(false);
  });

  it("routes the capability question to the governed proposal path", () => {
    const { prompts } = stockChips();
    expect(
      prompts.some((p) => /governed (github )?issue/i.test(p)),
    ).toBe(true);
  });

  it("keeps the chip set at least as large as it was (16)", () => {
    // Three chips are replaced, not deleted: a user who came for the old
    // affordances still finds an answer for each of them.
    expect(stockChips().chips.length).toBeGreaterThanOrEqual(16);
  });
});
