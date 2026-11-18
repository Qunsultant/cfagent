/**
 * Issue #5523 — chips for the signals the loop now produces.
 *
 * After #5055 the plan carries a learnings policy, after #5058 low judge
 * scores become review findings, after #5060 durable memory facts become
 * learnings, and after #5061 the autopilot exposes a verdict trend. The chip
 * set had no affordance for any of them, so a user had to invent the prompt.
 *
 * Each chip must be answerable from data the chat already fetches — a chip
 * whose answer would be "I don't have that" is a defect, not a chip.
 */
import { describe, it, expect } from "vitest";
import { findCopilot } from "../src/client/chat/copilotRegistry";

const chips = () => findCopilot("stock")?.quickChips ?? [];
const byLabel = (needle: RegExp) =>
  chips().find((c) => needle.test(c.label));

describe("Issue #5523 — chips for the new learning, verdict and memory signals", () => {
  it("asks why the last cycle did not trade", () => {
    const chip = byLabel(/why didn't you trade/i);
    expect(chip).toBeDefined();
    expect(chip!.prompt).toMatch(/learning policy/i);
    expect(chip!.category).toBe("Learning & Memory");
  });

  it("asks what the loop has learned", () => {
    const chip = byLabel(/what have you learned/i);
    expect(chip).toBeDefined();
    expect(chip!.prompt).toMatch(/learnings/i);
    expect(chip!.prompt).toMatch(/quality|review/i);
    expect(chip!.category).toBe("Learning & Memory");
  });

  it("asks whether a policy rule keeps blocking", () => {
    const chip = byLabel(/repeated risk blocks/i);
    expect(chip).toBeDefined();
    expect(chip!.prompt).toMatch(/verdict trend|binding rule/i);
    expect(chip!.category).toBe("Policy & Verdicts");
  });

  it("asks what the copilot remembers about the user", () => {
    const chip = byLabel(/remember about me/i);
    expect(chip).toBeDefined();
    expect(chip!.prompt).toMatch(/preference|fact/i);
    expect(chip!.prompt).toMatch(/learning/i);
    expect(chip!.category).toBe("Learning & Memory");
  });

  it("keeps every chip's prompt distinct", () => {
    const prompts = chips().map((c) => c.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});
