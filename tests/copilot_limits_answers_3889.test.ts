/**
 * Issue #3889 — the copilot answers limits and refusals from configuration.
 *
 * What these pins defend (the golden questions from the issue):
 *   1. "what are my limits" is answered from the `trading_limits` payload, with
 *      the source of every value and an explicit "not configured" for unset.
 *   2. "why was rung 3 refused" quotes the code plus the limit, its value, the
 *      usage and the requested amount.
 *   3. When the limits read fails, the answer says the read failed and names
 *      the setting — it never guesses a cap.
 *   4. No answer invents a cap that is absent from configuration (the negative
 *      pin: an unset key never renders a number).
 *   5. "what did you stop" answers from the cancel receipt, and says so when
 *      no receipt came back.
 *   6. The prompt states the same rules, so the model is asked to do what the
 *      deterministic builder does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { answerTradingLimitQuestion } from "../src/agents/copilotLimitsAnswers";
import {
  TRADING_LIMITS_SETTING_KEY,
  evaluateTradingLimit,
  resolveTradingLimits,
} from "../src/trading";

function snapshot(values: Record<string, number> | null, symbol: string | null = "MSFT") {
  const store: Record<string, string> = {};
  if (values) store[TRADING_LIMITS_SETTING_KEY] = JSON.stringify(values);
  return resolveTradingLimits({ symbol, readSetting: (key) => store[key] ?? null });
}

describe("#3889 — the golden questions, answered from tool output", () => {
  it("“what are my limits” quotes every key with its source", () => {
    const limits = snapshot({ maxRungsPerLadder: 4, maxNotionalPerTicker: 5000, cancelMaxCount: 10 });
    const answer = answerTradingLimitQuestion({ question: "what_are_my_limits", limits });

    expect(answer.source).toBe("tool_output");
    expect(answer.answer).toContain("maxRungsPerLadder: 4 — setting (trading:limits)");
    expect(answer.answer).toContain("maxNotionalPerTicker: $5,000");
    expect(answer.answer).toContain("maxOpenOrdersTotal: not configured (TRADING_LIMIT_MAX_OPEN_ORDERS_TOTAL unset)");
    expect(answer.answer).toContain("session window");
    expect(answer.usedLimitKeys).toContain("cancelMaxCount");
  });

  it("“how much budget is left” states the budget and refuses to invent usage", () => {
    const limits = snapshot({ maxNotionalPerTicker: 5000 });
    const answer = answerTradingLimitQuestion({ question: "budget_left", limits });
    expect(answer.answer).toContain("$5,000");
    expect(answer.answer).toContain("cannot state what is left");
  });

  it("“how much budget is left” computes the remainder when a receipt carries the usage", () => {
    const limits = snapshot({ maxNotionalPerTicker: 5000 });
    const verdict = evaluateTradingLimit(limits, { key: "maxNotionalPerTicker", requested: 1200, used: 4980 });
    const answer = answerTradingLimitQuestion({
      question: "budget_left",
      limits,
      refusal: { code: "budget_exhausted", verdict },
    });
    expect(answer.answer).toContain("used $4,980");
    expect(answer.answer).toContain("remaining $20");
  });

  it("“why was MSFT rung 3 refused” quotes the code, limit, used and requested", () => {
    const limits = snapshot({ maxNotionalPerTicker: 5000, maxRungsPerLadder: 4 });
    const verdict = evaluateTradingLimit(limits, { key: "maxNotionalPerTicker", requested: 1200, used: 4980 });
    const answer = answerTradingLimitQuestion({
      question: "why_refused",
      limits,
      refusal: { code: "budget_exhausted", verdict },
    });

    expect(answer.answer).toContain("budget_exhausted (maxNotionalPerTicker @ $5,000; used $4,980; requested $1,200)");
    expect(answer.answer).toContain("setting (trading:limits)");
    expect(answer.usedLimitKeys).toEqual(["maxNotionalPerTicker"]);
  });

  it("a refusal with no limit detail lists the configured limits instead of naming a cap", () => {
    const limits = snapshot({ maxRungsPerLadder: 4 });
    const answer = answerTradingLimitQuestion({
      question: "why_refused",
      limits,
      refusal: { code: "order_type_unsupported" },
    });
    expect(answer.answer).toContain("carried no limit detail");
    expect(answer.answer).toContain("maxRungsPerLadder: 4");
  });

  it("“cancel everything and tell me what you stopped” answers from the receipt", () => {
    const answer = answerTradingLimitQuestion({
      question: "what_did_you_stop",
      cancelReceipt: {
        action: "cancel_all",
        targeted: 2,
        cancelled: [{ orderId: "ord-1", symbol: "MSFT" }],
        refused: [{ orderId: "ord-2", message: "already filled" }],
      },
    });
    expect(answer.answer).toContain("targeted 2, cancelled 1, refused 1");
    expect(answer.answer).toContain("ord-1 (MSFT)");
    expect(answer.answer).toContain("Still live: ord-2 — already filled");
  });

  it("with no receipt it says it has no receipt", () => {
    const answer = answerTradingLimitQuestion({ question: "what_did_you_stop" });
    expect(answer.source).toBe("no_receipt");
    expect(answer.answer).toContain("no cancel receipt");
  });
});

describe("#3889 — a failed read is a failed read", () => {
  it("names the setting and never guesses a cap", () => {
    const answer = answerTradingLimitQuestion({
      question: "what_are_my_limits",
      limits: null,
      limitsError: "settings store unavailable",
    });
    expect(answer.source).toBe("read_failed");
    expect(answer.answer).toContain("will not guess");
    expect(answer.answer).toContain("trading:limits");
    expect(answer.answer).toContain("settings store unavailable");
    expect(answer.usedLimitKeys).toEqual([]);
    // The negative: no dollar figure and no count can appear.
    expect(answer.answer).not.toMatch(/\$\d/);
  });

  it("an unset limit never renders a number", () => {
    const limits = snapshot(null);
    const answer = answerTradingLimitQuestion({ question: "what_are_my_limits", limits });
    for (const line of answer.answer.split("\n")) {
      if (line.startsWith("maxNotionalPerTicker")) {
        expect(line).toContain("not configured");
        expect(line).not.toMatch(/\$\d/);
      }
    }
    const budget = answerTradingLimitQuestion({ question: "budget_left", limits });
    expect(budget.answer).toContain("no budget to report");
    expect(budget.answer).not.toMatch(/\$\d/);
  });

  it("a refusal with no code says so instead of inventing one", () => {
    const limits = snapshot({ maxRungsPerLadder: 4 });
    const answer = answerTradingLimitQuestion({ question: "why_refused", limits, refusal: null });
    expect(answer.answer).toContain("will not invent one");
    expect(answer.usedLimitKeys).toEqual([]);
  });
});

describe("#3889 — the prompt asks for the same behaviour", () => {
  const prompt = readFileSync("src/agents/prompts/stockCopilotPrompt.ts", "utf8");

  it("states the never-invent rule and names the tool", () => {
    expect(prompt).toContain("LIMITS AND REFUSALS COME FROM CONFIGURATION (#3889)");
    expect(prompt).toContain("tool_openaimp_trading_limits");
    expect(prompt).toContain("NEVER state a limit the tool did not return");
    expect(prompt).toContain("never estimated");
  });

  it("quotes the refusal shape the builder produces", () => {
    expect(prompt).toContain("budget_exhausted (maxNotionalPerTicker @ $5,000; used $4,980; requested $1,200)");
    const limits = snapshot({ maxNotionalPerTicker: 5000 });
    const verdict = evaluateTradingLimit(limits, { key: "maxNotionalPerTicker", requested: 1200, used: 4980 });
    const answer = answerTradingLimitQuestion({ question: "why_refused", limits, refusal: { code: "budget_exhausted", verdict } });
    expect(answer.answer).toContain("budget_exhausted (maxNotionalPerTicker @ $5,000; used $4,980; requested $1,200)");
  });
});
