import type { AgentContext } from "agents";
import { createUnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import {
  createAgentScheduleExecutorDepsForDo,
  nlqPortToAgentSdkAdapter,
  type AgentScheduleExecutorDeps,
} from "../../services/agentScheduleCapability";
import {
  createWorkflowStageScheduleAdapter,
  type WorkflowStageRegistry,
} from "../../services/workflowStageSchedule";
import type { Env } from "../../types";
import { getScheduledAgentDoor } from "./meshDoors";
import { makeRunScheduleCallback, makeScheduleAlarmsPort } from "../routes/schedules";

type ScheduleActionAudit = (
  type: string,
  payload: Record<string, unknown>,
) => void;

export interface AgentScheduleExecutorContext {
  env: Env;
  sql: AgentContext["storage"]["sql"];
  storage: AgentContext["storage"];
  audit: ScheduleActionAudit;
  schedulingPort: Parameters<typeof nlqPortToAgentSdkAdapter>[0];
  alarms: ReturnType<typeof makeScheduleAlarmsPort>;
  runCallback: ReturnType<typeof makeRunScheduleCallback>;
}

export function createOrchestratorAgentScheduleExecutorDeps(
  context: AgentScheduleExecutorContext,
): AgentScheduleExecutorDeps {
  const unifiedStore = createUnifiedSchedulePorts({
    sql: context.sql,
    storage: context.storage,
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

  return createAgentScheduleExecutorDepsForDo(
    context.env,
    context.sql,
    context.audit,
    {
      sdk: nlqPortToAgentSdkAdapter(
        context.schedulingPort,
        unifiedStore.unifiedSchedules,
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
        store: unifiedStore.unifiedSchedulesSync,
        alarms: context.alarms,
        registry: stageRegistry,
        runCallback: context.runCallback,
        nowIso: () => new Date().toISOString(),
      }),
    },
  );
}
