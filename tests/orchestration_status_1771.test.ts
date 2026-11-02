/**
 * #1771 (parent #1717) slice A: per-orchestration status registry.
 *
 * RED pins (written BEFORE the implementation; the first run
 * must fail on the missing src/orchestrations/orchestrationStatus.ts
 * module).
 *
 * Pins:
 * - Every orchestration in the issue's scope has exactly one
 *   registry entry, with non-empty evidence (file paths on main)
 *   and tradeApprovalBypass === false. No entry may ever claim
 *   a trade-approval bypass: enabling anything in #1771 must
 *   NOT bypass human approval for trades, nor any other control.
 * - A deliberately-unenabled entry MUST name its blocker; an
 *   enabled entry MUST NOT carry a blocker (a blocker on an
 *   enabled entry would be a contradiction the registry hides).
 * - The reflection decision is developer-mediated, with a
 *   rationale naming the change-control path self-mutation
 *   would bypass (branch + PR + gate). No code/prompt
 *   mutation path is built in #1771.
 * - Slice-B update (pin rule): slice B flipped swarm-consensus
 *   to enabled, so the slice-A pin below was updated in the
 *   same PR; rebalance proposals and the social digest builder
 *   are still NOT yet enabled — slices C/D flip exactly those
 *   entries, and this test pins the current values so a
 *   premature "enabled" claim fails here first.
 */
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_STATUS,
  REFLECTION_DECISION_1771,
} from "../src/orchestrations/orchestrationStatus";

const EXPECTED_IDS = [
  "portfolio-rebalancing",
  "x402-p2p",
  "spread-repair",
  "cross-venue-arbitrage",
  "swarm-consensus",
  "volatility-darkpool-monitor",
  "social-feed-digest",
  "goal-chaining",
  "screener-to-trade-loop",
] as const;

describe("orchestration status registry (#1771 slice A)", () => {
  it("covers exactly the issue scope, one entry each", () => {
    expect(ORCHESTRATION_STATUS.map((e) => e.id).sort()).toEqual(
      [...EXPECTED_IDS].sort(),
    );
  });

  it("no entry bypasses the trade-approval gate or any control", () => {
    for (const e of ORCHESTRATION_STATUS) {
      expect(e.tradeApprovalBypass).toBe(false);
    }
  });

  it("every entry carries evidence; unenabled entries name a blocker, enabled entries carry none", () => {
    for (const e of ORCHESTRATION_STATUS) {
      expect(e.evidence.length).toBeGreaterThan(0);
      for (const ev of e.evidence) expect(ev.length).toBeGreaterThan(0);
      if (e.status === "deliberately-unenabled") {
        expect(e.blocker).toBeTruthy();
      } else {
        expect(e.blocker).toBeNull();
      }
    }
  });

  it("slice-B state: swarm is enabled; rebalance still unenabled, social digest still decided", () => {
    const byId = new Map(ORCHESTRATION_STATUS.map((e) => [e.id, e]));
    expect(byId.get("swarm-consensus")!.status).toBe("enabled");
    expect(byId.get("swarm-consensus")!.blocker).toBeNull();
    expect(byId.get("portfolio-rebalancing")!.status).toBe(
      "deliberately-unenabled",
    );
    expect(byId.get("social-feed-digest")!.status).toBe("decided");
    expect(byId.get("social-feed-digest")!.blocker).toBeNull();
  });

  it("goal-chaining and the gated screener-to-trade loop are already enabled, not rebuilt", () => {
    const byId = new Map(ORCHESTRATION_STATUS.map((e) => [e.id, e]));
    expect(byId.get("goal-chaining")!.status).toBe("enabled");
    expect(byId.get("screener-to-trade-loop")!.status).toBe("enabled-gated");
  });

  it("reflection stays developer-mediated, with the change-control rationale", () => {
    expect(REFLECTION_DECISION_1771.decision).toBe("developer-mediated");
    expect(REFLECTION_DECISION_1771.mutatesCodeOrPrompts).toBe(false);
    expect(REFLECTION_DECISION_1771.rationale).toMatch(/branch/i);
    expect(REFLECTION_DECISION_1771.rationale).toMatch(/gate/i);
  });
});
