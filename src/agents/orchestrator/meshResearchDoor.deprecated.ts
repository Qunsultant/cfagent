/**
 * DEPRECATED (issue #6040, 2026-11-25) — retired in place; do not add
 * consumers. Superseded by `dispatchResearchEngineRun`
 * (`src/workflows/researchScreenEngine.ts`) for a whole run and by the
 * `run_research_job` MCP command's `(runId, stageId)` control for one stage.
 *
 * Why retired: this was the Copilot research door from #5123, but no
 * production module ever imported it and its deterministic `execute`
 * returned a literal `{mode: "deterministic"}` — a dispatched run that ran
 * nothing (#6040). The Copilot surface it was built for is the
 * `run_research_job` MCP command, which now dispatches through the one
 * service with a real six-stage target; a second door beside it would be a
 * second dispatcher. The HITL #277 deliver gate below stays here, frozen and
 * still tested, until a production deliver-stage gate supersedes it.
 *
 * Original header — Issue #5123 (#5109 Sub-issue 6: Agentic capabilities):
 * Copilot door for the nightly OODA research job (`research:<runId>`).
 */

import {
  isWithinResearchGuardWindow,
  RESEARCH_SCHEDULE_UTC_HOUR_SETTING_KEY,
  resolveResearchJobConfig,
  type ResearchStorageMode,
} from "../../config/researchJobConfig";
import { createSettingsPort } from "../../data/createSettingsPorts";
import type { SqlStorage } from "../../orm";
import type { JobPipelineDeps, JobRunRecorder } from "../../services/jobPipelineEngine";
import type { ResearchStepDeps } from "../../services/researchPipelineJobs";
import { codedMessage } from "../../outcomes/outcomeAspects";
import { RESEARCH_PIPELINE_STAGES, type ResearchPipelineStage } from "../../workflows/stageRuntimeIds";
import {
  controlResearchStage,
  dispatchResearchEngineRun,
  executeResearchStageControl,
} from "../../workflows/researchScreenEngine";

export interface ResearchDeliverGateResult {
  stage: "deliver";
  gateStatus: "held_for_approval" | "released";
  reason: string;
}

/**
 * Issue #5123 — HITL #277 deliver gate. KEPT (not deprecated): the retired
 * dispatch functions below consume it, and it is the only implementation of
 * the deliver hold; it stays frozen with this file until a production
 * deliver-stage gate replaces it. HITL #277 hold landed as a `deliver`-stage
 * gate (#5123):
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

/**
 * @deprecated Issue #6040 — retired in place. Superseded by
 * `dispatchResearchEngineRun` with a real `ResearchDispatchTarget`.
 */
export async function runDeterministicResearchViaDoor(input: {
  actingLogin: string | undefined;
  trigger: "manual" | "scheduled";
  runId?: string;
  hitlHold?: boolean;
  approved?: boolean;
  now?: Date;
  sql?: SqlStorage;
  d1?: D1Database;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
  env?: Record<string, string | undefined>;
  storageMode?: ResearchStorageMode;
  researchDeps?: ResearchStepDeps;
}) {
  const login = input.actingLogin?.trim() || "";
  if (!login || login === "default") {
    throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  }

  // Issue #6503 step 13 — the fire hour is a managed setting
  // (`research.scheduleUtcHour`): when the caller passes the
  // orchestrator's sql, a managed value wins over the env carrier,
  // which wins over the 21:00 default. Fail-safe: an unreadable
  // store reads as "no managed value", never a throw — the env /
  // default still apply.
  let managedHour: unknown;
  if (input.sql) {
    try {
      managedHour = createSettingsPort(input.sql as never).get(
        RESEARCH_SCHEDULE_UTC_HOUR_SETTING_KEY,
      );
    } catch {
      managedHour = undefined;
    }
  }
  const config = resolveResearchJobConfig(input.env, { scheduleUtcHour: managedHour });
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
    ...(input.sql ? { sql: input.sql } : {}),
    ...(input.d1 ? { d1: input.d1 } : {}),
    ...(input.stores ? { stores: input.stores } : {}),
    ...(input.runRecorder ? { runRecorder: input.runRecorder } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.storageMode ? { storageMode: input.storageMode } : {}),
    ...(input.researchDeps ? { researchDeps: input.researchDeps } : {}),
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
    storageMode: dispatched.storageMode,
    ephemeralFallback: dispatched.ephemeralFallback,
    ...(dispatched.ephemeralReason ? { ephemeralReason: dispatched.ephemeralReason } : {}),
  };
}

/**
 * @deprecated Issue #6040 — retired in place. Superseded by
 * `run_research_job` staged control over `(runId, stageId)`.
 */
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

/**
 * Production async agent-composed door path (#5287): executes real
 * `executeResearchStageControl` operations with explicit `researchDeps` and
 * durable store threading (unlike the synchronous validation-only planner above).
 */
/**
 * @deprecated Issue #6040 — retired in place. Superseded by
 * `executeResearchStageControl` over `(runId, stageId)`.
 */
export async function executeAgentComposedResearchViaDoor(input: {
  actingLogin: string | undefined;
  runId: string;
  stages?: readonly ResearchPipelineStage[];
  hitlHold?: boolean;
  approved?: boolean;
  sql?: SqlStorage;
  d1?: D1Database;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
  env?: Record<string, string | undefined>;
  storageMode?: ResearchStorageMode;
  researchDeps: ResearchStepDeps;
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

  const stageResults = [];
  for (const stageId of selectedStages) {
    if (stageId === "deliver" && deliverGate.gateStatus === "held_for_approval") {
      stageResults.push(
        await executeResearchStageControl({
          runId: input.runId,
          stageId,
          op: "stop",
          userLogin: login,
          ...(input.sql ? { sql: input.sql } : {}),
          ...(input.d1 ? { d1: input.d1 } : {}),
          ...(input.stores ? { stores: input.stores } : {}),
          ...(input.runRecorder ? { runRecorder: input.runRecorder } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.storageMode ? { storageMode: input.storageMode } : {}),
          researchDeps: input.researchDeps,
        }).catch(() => ({
          stageId,
          op: "stop" as const,
          gateStatus: deliverGate.gateStatus,
        })),
      );
      continue;
    }
    stageResults.push(
      await executeResearchStageControl({
        runId: input.runId,
        stageId,
        op: "run",
        userLogin: login,
        ...(input.sql ? { sql: input.sql } : {}),
        ...(input.d1 ? { d1: input.d1 } : {}),
        ...(input.stores ? { stores: input.stores } : {}),
        ...(input.runRecorder ? { runRecorder: input.runRecorder } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.storageMode ? { storageMode: input.storageMode } : {}),
        researchDeps: input.researchDeps,
      }),
    );
  }

  return {
    mode: "agent_composed" as const,
    runId: input.runId,
    deliverGate,
    stageResults,
  };
}
