/**
 * Issue #5569 — the delivery-state classifier and its CLI contract.
 *
 * The two states that `mergeStateStatus` cannot express: a dead SQUASH
 * auto-merge request under a rebase-only ruleset, and "queued but reading
 * BEHIND". Fixtures are the real payload shapes observed on 2026-11-18.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DELIVERY_STATES,
  classifyDeliveryState,
  deliveryAdvice,
  deliveryExitCode,
} from "../scripts/prDeliveryState.mjs";

describe("Issue #5569 — PR delivery state", () => {
  it("flags a SQUASH auto-merge request as dead under the rebase-only ruleset", () => {
    // The payload `gh pr view 5531 --json autoMergeRequest` returned after the
    // CLI call, with mergeStateStatus BLOCKED while the checks ran.
    const state = classifyDeliveryState({
      number: 5531,
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "BLOCKED",
      checksGreen: false,
      autoMergeRequest: { mergeMethod: "SQUASH" },
    });
    expect(state).toBe(DELIVERY_STATES.DEAD_AUTO_MERGE);
    expect(deliveryAdvice(state, 5531)).toContain("enqueuePullRequest");
    expect(deliveryExitCode(state)).toBe(1);
  });

  it("treats a queued PR as queued even when it reads BEHIND", () => {
    // #5536 answered "already in the queue" while `gh pr view` said BEHIND.
    const state = classifyDeliveryState({
      number: 5536,
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "BEHIND",
      isInMergeQueue: true,
      checksGreen: true,
    });
    expect(state).toBe(DELIVERY_STATES.QUEUED);
    expect(deliveryAdvice(state, 5536)).toContain("do not push");
    expect(deliveryExitCode(state)).toBe(0);
  });

  it("says a green, unqueued PR needs the explicit enqueue", () => {
    const state = classifyDeliveryState({
      number: 5531,
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "BEHIND",
      isInMergeQueue: false,
      checksGreen: true,
      autoMergeRequest: null,
    });
    expect(state).toBe(DELIVERY_STATES.NOT_QUEUED);
    expect(deliveryAdvice(state, 5531)).toContain("enqueuePullRequest");
  });

  it("keeps a draft out of the queue path", () => {
    const state = classifyDeliveryState({
      state: "OPEN",
      isDraft: true,
      mergeStateStatus: "CLEAN",
      isInMergeQueue: false,
    });
    expect(state).toBe(DELIVERY_STATES.DRAFT);
    expect(deliveryAdvice(state)).toContain("never enrolled");
  });

  it("reports red before suggesting an enqueue", () => {
    const state = classifyDeliveryState({
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "BLOCKED",
      isInMergeQueue: false,
      checksGreen: false,
    });
    expect(state).toBe(DELIVERY_STATES.RED);
    expect(deliveryExitCode(state)).toBe(1);
  });

  it("is quiet for a merged or closed PR", () => {
    const state = classifyDeliveryState({ state: "MERGED" });
    expect(state).toBe(DELIVERY_STATES.CLOSED);
    expect(deliveryExitCode(state)).toBe(0);
  });

  it("accepts the GraphQL wrapper shape", async () => {
    // The CLI unwraps `.data.repository.pullRequest`; the classifier itself is
    // shape-agnostic, so this pins the documented payload keys only.
    const pr = {
      number: 1,
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "UNKNOWN",
      isInMergeQueue: false,
      checksGreen: true,
      autoMergeRequest: { mergeMethod: "REBASE" },
    };
    expect(classifyDeliveryState(pr)).toBe(DELIVERY_STATES.NOT_QUEUED);
  });

  it("pins the §11 queue-entry instruction in the delivery doc", () => {
    const doc = readFileSync("docs/agents/gitops.md", "utf8");
    expect(doc).toContain("enqueuePullRequest(input: { pullRequestId: $id })");
    expect(doc).toContain("`gh pr merge <n>` without flags is **not** equivalent");
    expect(doc).toContain("scripts/pr-delivery-state.mjs");
  });
});
