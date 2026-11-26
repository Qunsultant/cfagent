import { describe, expect, it } from "vitest";
import {
  evaluateResearchDeliverHitlGate,
  runAgentComposedResearchViaDoor,
  runDeterministicResearchViaDoor,
} from "../src/agents/orchestrator/meshResearchDoor.deprecated";
import { codedMessage } from "../src/outcomes/outcomeAspects";

describe("Issue #5123 (Sub-issue 6 of #5109) — Agentic Capabilities", () => {
  it("supports deterministic research:<runId> execution with schedule guard and deliver HITL gate", async () => {
    const skipped = await runDeterministicResearchViaDoor({
      actingLogin: "trader@example.com",
      trigger: "scheduled",
      now: new Date("2026-11-17T20:00:00.000Z"),
    });
    expect(skipped).toMatchObject({ skipped: true, reason: "outside_guard_window" });

    const ran = await runDeterministicResearchViaDoor({
      actingLogin: "trader@example.com",
      trigger: "scheduled",
      runId: "r-det-1",
      hitlHold: true,
      now: new Date("2026-11-17T21:15:00.000Z"),
    });
    expect(ran).toMatchObject({
      mode: "deterministic",
      skipped: false,
      engineJobId: "research:r-det-1",
      deliverGate: { stage: "deliver", gateStatus: "held_for_approval" },
    });

    await expect(
      runDeterministicResearchViaDoor({
        actingLogin: undefined,
        trigger: "manual",
      }),
    ).rejects.toThrow(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  });

  it("supports agent-composed per-stage MCP execution and releases deliver gate on approval", () => {
    expect(evaluateResearchDeliverHitlGate({ hitlHold: true, approved: false }).gateStatus).toBe(
      "held_for_approval",
    );
    expect(evaluateResearchDeliverHitlGate({ hitlHold: true, approved: true }).gateStatus).toBe(
      "released",
    );

    const held = runAgentComposedResearchViaDoor({
      actingLogin: "trader@example.com",
      runId: "r-comp-1",
      stages: ["feed", "analyze", "deliver", "evaluate"],
      hitlHold: true,
    });
    expect(held.deliverGate.gateStatus).toBe("held_for_approval");
    expect(held.stageResults.find((s) => s.stageId === "deliver")).toMatchObject({
      stageId: "deliver",
      op: "stop",
      gateStatus: "held_for_approval",
    });
  });
});
