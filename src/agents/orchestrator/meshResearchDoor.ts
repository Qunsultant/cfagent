/**
 * Issue #5123 (#5109 Sub-issue 6: Agentic capabilities) — Copilot door for the
 * nightly OODA research job (`research:<runId>`), supporting BOTH paths:
 *   1. Deterministic workflow (`runDeterministicResearchViaDoor`): runs the
 *      fixed `research:<runId>` pipeline with the 21:00–21:30 UTC schedule guard.
 *   2. Agent-composed MCP path (`runAgentComposedResearchViaDoor`): sequences
 *      individual per-stage controls over `(runId, stageId)`.
 *   3. HITL #277 hold as a `deliver`-stage gate (`evaluateResearchDeliverHitlGate`).
 */
import {
  isWithinResearchGuardWindow,
  resolveResearchJobConfig,
} from "../../config/researchJobConfig";
import { codedMessage } from "../../outcomes/outcomeAspects";
import { RESEARCH_PIPELINE_STAGES, type ResearchPipelineStage } from "../../workflows/stageRuntimeIds";
import {
  controlResearchStage,
  dispatchResearchEngineRun,
} from "../../workflows/researchScreenEngine";

export interface ResearchDeliverGateResult {
  stage: "deliver";
  gateStatus: "held_for_approval" | "released";
  reason: string;
}

/**
 * HITL #277 hold landed as a `deliver`-stage gate (#5123):
 * when `hitlHold` is enabled and `approved !== true`, delivery is held for
 * human confirmation instead of dispatching channels.
 */
export function evaluateResearchDeliverHitlGate(input: {
  hitlHold: boolean;
  approved?: boolean;
}): ResearchDeliverGateResult {
  if (input.hitlHold && input.approved !== true) {
    return {
      stage: "deliver",
      gateStatus: "held_for_approval",
      reason: "HITL #277 hold active on deliver stage; awaiting explicit approval.",
    };
  }
  return {
    stage: "deliver",
    gateStatus: "released",
    reason: input.hitlHold ? "HITL approval confirmed." : "HITL hold disabled.",
  };
}

export async function runDeterministicResearchViaDoor(input: {
  actingLogin: string | undefined;
  trigger: "manual" | "scheduled";
  runId?: string;
  hitlHold?: boolean;
  approved?: boolean;
  now?: Date;
}) {
  const login = input.actingLogin?.trim() || "";
  if (!login || login === "default") {
    throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  }

  const config = resolveResearchJobConfig();
  if (input.trigger === "scheduled") {
    const now = input.now ?? new Date();
    if (!isWithinResearchGuardWindow(now, config)) {
      return {
        mode: "deterministic" as const,
        skipped: true,
        reason: "outside_guard_window",
        scheduleUtcHour: config.scheduleUtcHour,
        scheduleWindowMinutes: config.scheduleWindowMinutes,
      };
    }
  }

  const deliverGate = evaluateResearchDeliverHitlGate({
    hitlHold: Boolean(input.hitlHold),
    approved: input.approved,
  });

  const dispatched = await dispatchResearchEngineRun({
    runId: input.runId,
    userLogin: login,
    trigger: input.trigger,
    execute: async () => ({
      mode: "deterministic",
      deliverGate,
    }),
  });

  return {
    mode: "deterministic" as const,
    skipped: false,
    engineJobId: dispatched.engineJobId,
    runId: dispatched.runId,
    deliverGate,
    stages: dispatched.stages,
  };
}

export function runAgentComposedResearchViaDoor(input: {
  actingLogin: string | undefined;
  runId: string;
  stages?: readonly ResearchPipelineStage[];
  hitlHold?: boolean;
  approved?: boolean;
}) {
  const login = input.actingLogin?.trim() || "";
  if (!login || login === "default") {
    throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  }

  const selectedStages = input.stages?.length ? input.stages : RESEARCH_PIPELINE_STAGES;
  const deliverGate = evaluateResearchDeliverHitlGate({
    hitlHold: Boolean(input.hitlHold),
    approved: input.approved,
  });

  const stageResults = selectedStages.map((stageId) => {
    if (stageId === "deliver" && deliverGate.gateStatus === "held_for_approval") {
      return {
        stageId,
        op: "stop" as const,
        gateStatus: deliverGate.gateStatus,
      };
    }
    return controlResearchStage({
      runId: input.runId,
      stageId,
      op: "run",
      userLogin: login,
    });
  });

  return {
    mode: "agent_composed" as const,
    runId: input.runId,
    deliverGate,
    stageResults,
  };
}
