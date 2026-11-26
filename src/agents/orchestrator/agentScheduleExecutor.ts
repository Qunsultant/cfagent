import type { AgentContext } from "agents";
import { createD1UnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import {
  createAgentScheduleExecutorDepsForDo,
  nlqPortToAgentSdkAdapter,
  nlqPortToScheduleAlarms,
  type AgentScheduleExecutorDeps,
} from "../../services/agentScheduleCapability";
import {
  createWorkflowStageScheduleAdapter,
  type WorkflowStageRegistry,
} from "../../services/workflowStageSchedule";
import {
  resolveEffectiveScheduleFloor,
  resolveEffectiveScheduleStartPaused,
} from "../../services/scheduleControls";
import type { Env } from "../../types";
import type { AgentScheduleLoopSettings } from "../../services/agentScheduleLoopSettings";
import { getScheduledAgentDoor } from "./meshDoors";
import { makeRunScheduleCallback, makeScheduleAlarmsPort } from "../routes/schedules";

type ScheduleActionAudit = (
  type: string,
  payload: Record<string, unknown>,
) => void;

export interface AgentScheduleExecutorInput {
  env: Env;
  sql: AgentContext["storage"]["sql"];
  storage: AgentContext["storage"];
  audit: ScheduleActionAudit;
  schedulingPort: Parameters<typeof nlqPortToAgentSdkAdapter>[0];
  alarms: ReturnType<typeof makeScheduleAlarmsPort>;
  runCallback: ReturnType<typeof makeRunScheduleCallback>;
  resolveAgentScheduleLoopSettings?: (
    login: string,
  ) => Promise<AgentScheduleLoopSettings | null>;
}

export function createOrchestratorAgentScheduleExecutorDeps(
  context: AgentScheduleExecutorInput,
): AgentScheduleExecutorDeps {
  // Issue #6503 — the one unified schedule store is D1 only (owner
  // direction 2026-11-25): the executor's sdk + stages adapters both
  // read/write the D1 store, fail-closed when AGENT_DB is unbound.
  // The DO port (createUnifiedSchedulePorts) is legacy/retained-unused.
  const unifiedStore = createD1UnifiedSchedulePorts({
    d1: context.env.AGENT_DB,
  });
  const stageRegistry: WorkflowStageRegistry = {
    getDefinition: async (jobId) => {
      try {
        const view = await getScheduledAgentDoor(context.env).getPipelineJobStatus(jobId);
        return view.definition ?? null;
      } catch {
        return null;
      }
    },
  };
  const scheduledAgent = () => getScheduledAgentDoor(context.env);

  const deps = createAgentScheduleExecutorDepsForDo(
    context.env,
    context.sql,
    context.audit,
    {
      sdk: nlqPortToAgentSdkAdapter(
        context.schedulingPort,
        unifiedStore.unifiedSchedules,
        {
          // Issue #6503 — the start-paused control, resolved here so
          // a schedule created through chat/NLQ starts active when
          // the control is off (resume arms it through the NLQ
          // port's alarms).
          startPaused: resolveEffectiveScheduleStartPaused(context.sql, context.env).paused,
          alarms: nlqPortToScheduleAlarms(context.schedulingPort, () =>
            resolveEffectiveScheduleFloor(context.sql, context.env).seconds,
          ),
        },
        {
          alarms: context.alarms,
          runCallback: context.runCallback,
          nowIso: () => new Date().toISOString(),
          nowMs: () => Date.now(),
        },
      ),
      goals: {
        list: async () => (await scheduledAgent().listGoals()) as unknown as Array<Record<string, unknown>>,
        add: async (goal, actor) => {
          if (
            typeof goal.id !== "string" ||
            typeof goal.name !== "string" ||
            typeof goal.cron !== "string" ||
            typeof goal.operation !== "string" ||
            typeof goal.budgetCents !== "number"
          ) {
            throw new Error("Goal schedules require id, name, cron, operation, and budgetCents.");
          }
          return (await scheduledAgent().addGoal({
            id: goal.id,
            name: goal.name,
            cron: goal.cron,
            operation: goal.operation,
            budgetCents: goal.budgetCents,
            ...(typeof goal.enabled === "boolean" ? { enabled: goal.enabled } : {}),
            ...(goal.executionMode === "deterministic" || goal.executionMode === "agentic-loop"
              ? { executionMode: goal.executionMode }
              : {}),
            ...(typeof goal.timeZone === "string" ? { timeZone: goal.timeZone } : {}),
            ...(goal.provenance !== undefined ? { provenance: goal.provenance } : {}),
            ...(goal.subDailyOptIn === true ? { subDailyOptIn: true } : {}),
            ...(actor ? { actor } : {}),
          })) as unknown as Record<string, unknown>;
        },
        remove: (id, actor) => scheduledAgent().removeGoal(id, actor),
        setEnabled: (id, enabled, actor) =>
          scheduledAgent().setGoalEnabled(id, enabled, actor),
        trigger: (id, actor) =>
          scheduledAgent().triggerGoal(id, context.env, actor),
      },
      stages: createWorkflowStageScheduleAdapter({
        // Issue #6503 — the stages adapter reads the same D1 store
        // the sdk adoptions write (one store, not the DO sync store).
        store: unifiedStore.unifiedSchedules,
        alarms: context.alarms,
        registry: stageRegistry,
        runCallback: context.runCallback,
        nowIso: () => new Date().toISOString(),
      }),
    },
  );
  if (context.resolveAgentScheduleLoopSettings) {
    deps.resolveAgentScheduleLoopSettings = context.resolveAgentScheduleLoopSettings;
  }
  return deps;
}
