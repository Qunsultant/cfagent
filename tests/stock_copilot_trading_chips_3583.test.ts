import { describe, it, expect } from "vitest";
import {
  findCopilot,
  getRegisteredCopilots,
} from "../src/client/chat/copilotRegistry";

describe("Issue #3583 — Stock Copilot Trading & Core Capability Quick-Chips", () => {
  it("registers 8 trading and advanced capability chips alongside loop controls", () => {
    const copilot = findCopilot("stock");
    expect(copilot).toBeDefined();
    expect(copilot?.mode).toBe("chat");

    const chips = copilot?.quickChips || [];
    expect(chips.length).toBeGreaterThanOrEqual(16);

    const prompts = chips.map((c) => c.prompt);
    const labels = chips.map((c) => c.label);
    const categories = chips.map((c) => c.category);

    // 1. Order Execution with Brackets
    expect(prompts).toContain(
      "Draft a limit buy order for 10 AAPL with +4% take-profit and -2% stop-loss bracket exits",
    );
    expect(labels.some((l) => l.includes("Buy AAPL Bracket"))).toBe(true);
    expect(categories).toContain("Order Execution");

    // 2. Extended-Hours & Overnight Execution
    expect(prompts).toContain(
      "Place an extended-hours limit order for TSLA with session-specific bracket exits",
    );
    expect(labels.some((l) => l.includes("Extended-Hours Limit Order"))).toBe(true);
    expect(categories).toContain("Extended-Hours Trading");

    // 3. Pattern Screening & Setup Detection
    expect(prompts).toContain(
      "Scan the active stock universe for Momentum Breakout and Gap & Go setups",
    );
    expect(labels.some((l) => l.includes("Screen Momentum Breakouts"))).toBe(true);
    expect(categories).toContain("Pattern Screening");

    // 4. On-Demand Strategy Evaluation
    expect(prompts).toContain(
      "Evaluate NVDA against all active trading strategies without placing orders",
    );
    expect(labels.some((l) => l.includes("Evaluate NVDA vs Strategies"))).toBe(true);
    expect(categories).toContain("Strategy Evaluation");

    // 5. Portfolio Risk & CVaR Sizing
    expect(prompts).toContain(
      "Analyze portfolio risk and calculate CVaR position sizing for $10,000 buying power",
    );
    expect(labels.some((l) => l.includes("Portfolio CVaR & Sizing"))).toBe(true);
    expect(categories).toContain("Risk Management");

    // 6. Universe & Market Feed Selection
    expect(prompts).toContain(
      "Set the trading universe to S&P 500 and top pre-market volume movers",
    );
    expect(labels.some((l) => l.includes("Universe: S&P 500 & Movers"))).toBe(true);
    expect(categories).toContain("Universe Selection");

    // 7. Performance & Audit Reporting
    expect(prompts).toContain(
      "Generate a comprehensive trading and cycle audit report in Markdown format",
    );
    expect(labels.some((l) => l.includes("Generate Trade Performance Report"))).toBe(true);
    expect(categories).toContain("Performance Reports");

    // 8. Refusal & Skip Diagnosis
    expect(prompts).toContain(
      "Show recent cycle refusal reasons and explain why trades were skipped",
    );
    expect(labels.some((l) => l.includes("Audit Refusals & Skipped Trades"))).toBe(true);
    expect(categories).toContain("Cycle Audit");
  });

  it("ensures all quick-chips have non-empty prompt, label, and category", () => {
    const copilot = findCopilot("stock");
    expect(copilot?.quickChips).toBeDefined();
    for (const chip of copilot!.quickChips!) {
      expect(chip.label.trim().length).toBeGreaterThan(0);
      expect(chip.prompt.trim().length).toBeGreaterThan(0);
      expect(chip.category?.trim().length).toBeGreaterThan(0);
    }
  });
});

