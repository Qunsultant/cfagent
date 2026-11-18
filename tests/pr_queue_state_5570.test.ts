/**
 * Issue #5570 — a queued PR reads BEHIND, and the doc must say so.
 *
 * The failure this pins is a reading error, not a code defect: `mergeStateStatus`
 * reports BEHIND for a PR waiting in the queue and for a PR that was never
 * enrolled, so "BEHIND → rebase" loses the queue slot. `isInMergeQueue` is the
 * discriminating signal; the classifier from #5569 must separate the two, and
 * §9 must carry the rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DELIVERY_STATES,
  classifyDeliveryState,
  deliveryAdvice,
} from "../scripts/prDeliveryState.mjs";

const doc = () => readFileSync("docs/agents/gitops.md", "utf8");

describe("Issue #5570 — queued versus stuck", () => {
  it("separates queued-while-BEHIND from un-queued-while-BEHIND", () => {
    const base = {
      number: 5536,
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "BEHIND",
      checksGreen: true,
    };

    const queued = classifyDeliveryState({ ...base, isInMergeQueue: true });
    const stuck = classifyDeliveryState({ ...base, isInMergeQueue: false });

    expect(queued).toBe(DELIVERY_STATES.QUEUED);
    expect(stuck).toBe(DELIVERY_STATES.NOT_QUEUED);
    expect(deliveryAdvice(queued, 5536)).toContain("do not push");
    expect(deliveryAdvice(stuck, 5536)).toContain("enqueuePullRequest");
  });

  it("states the rule in §9 with the helper it points at", () => {
    const text = doc();
    expect(text).toContain('`BEHIND` does **not** mean "not queued"');
    expect(text).toContain("isInMergeQueue");
    expect(text).toContain("scripts/pr-delivery-state.mjs");
    expect(text).toContain("issue #5570");
  });
});
