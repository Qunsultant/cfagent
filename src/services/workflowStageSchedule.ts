/**
 * Issue #3121 #3310 — per-stage workflow scheduling: the pure
 * stage-schedule domain + the stages adapter factory.
 *
 * A stage-schedule is a unified-store record (kind `workflow-stage`)
 * whose firing is an SDK alarm on the internal-only callback
 * `runWorkflowStage`. The record is the single source of truth for
 * user/agent-created stage-schedules; the job definition (the #1972
 * stage registry) is READ for validation and never written by this
 * path — writing `schedule.registrationId` onto the node config
 * would make `registerSchedules` double-register the node through
 * the Think host on every boot (a duplicate firing). The engine's
 * `scheduleStage` stays the Think-host control-plane operation.
 *
 * This module is pure domain code plus injected ports: no DO access,
 * no fetch, no direct env reads. The stages adapter composes the
 * one management service (unified store + alarms port) with a
 * registry port (the ScheduledAgent door in production).
 */
import { jobStageId } from "../workflows/stageRunnerPorts";
import type { JobDefinition, JobNodeConfig } from "../data/jobPipelinePorts";
import type { ScheduleProvenance } from "../schedule";
import {
  createWorkflowStageSchedule as createManagedWorkflowStageSchedule,
  deleteUnifiedSchedule,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
  type ResolvedScheduleTiming,
  type ScheduleAlarms,
  type UnifiedManagementDeps,
  type UnifiedStoreLike,
} from "./unifiedScheduleManagement";
import type {
  AgentSdkTiming,
  AgentWorkflowStageScheduleAdapter,
} from "./agentScheduleCapability";

/** The firing callback: internal-only (never user-creatable), recorded. */
export const WORKFLOW_STAGE_CALLBACK = "runWorkflowStage";

/** The stage id for a node path — the engine's own `job:<nodePath>` vocabulary. */
export function workflowStageId(nodePath: string): string {
  return jobStageId(nodePath);
}

/**
 * Resolve a node by its child-index path ("" = the root). Throws a
 * named refusal when the path names no node — a schedule can never
 * be armed against a stage that does not exist.
 */
export function resolveStageNode(root: JobNodeConfig, nodePath: string): JobNodeConfig {
  if (nodePath === "") return root;
  const parts = nodePath.split("/");
  let node: JobNodeConfig = root;
  for (const part of parts) {
    const index = Number(part);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error(`no stage at node path "${nodePath}": "${part}" is not a child index.`);
    }
    const children = node.children ?? [];
    const next = children[index];
    if (!next) {
      throw new Error(`no stage at node path "${nodePath}" in this job.`);
    }
    node = next;
  }
  return node;
}

/**
 * True when firing the stage sends outside the platform: a deliver
 * stage, or any stage with output channels. Derived from the node
 * definition — the caller (capability classifier) receives it, never
 * guesses it.
 */
export function isExternalSendStage(node: JobNodeConfig): boolean {
  if (node.kind === "deliver") return true;
  const channels = node.outputs?.channels;
  return Array.isArray(channels) && channels.length > 0;
}

/** The create input, as the route / capability / A2A layers supply it. */
export interface WorkflowStageScheduleInput {
  jobId: string;
  nodePath: string;
  scheduleType: "cron" | "interval";
  cron?: string;
  intervalSeconds?: number;
  reason?: string;
}

/** The validated definition a stage-schedule record carries. */
export interface WorkflowStageScheduleDefinition {
  jobId: string;
  nodePath: string;
  stageId: string;
  type: "cron" | "interval";
  cron?: string;
  intervalSeconds?: number;
}

export type WorkflowStageScheduleValidation =
  | { ok: true; value: WorkflowStageScheduleDefinition }
  | { ok: false; error: string };

/** Validate a stage-schedule create/update input (fail-closed, named refusals). */
export function validateWorkflowStageScheduleInput(
  input: WorkflowStageScheduleInput,
): WorkflowStageScheduleValidation {
  const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
  if (!jobId) return { ok: false, error: "A stage-schedule requires a non-empty jobId." };
  // The root ("") is the whole job — scheduled as a whole-workflow
  // schedule, not a stage-schedule — so a stage-schedule names a
  // stage below the root with a non-empty node path.
  const nodePath = typeof input.nodePath === "string" ? input.nodePath.trim() : "";
  if (!nodePath) {
    return { ok: false, error: "A stage-schedule requires a non-empty nodePath naming its stage." };
  }
  const stageId = workflowStageId(nodePath);
  if (input.scheduleType === "cron") {
    const cron = typeof input.cron === "string" ? input.cron.trim() : "";
    if (cron.split(/\s+/).filter(Boolean).length !== 5) {
      return {
        ok: false,
        error: `Invalid cron expression '${input.cron ?? ""}': expected 5 fields (minute hour day-of-month month day-of-week).`,
      };
    }
    return { ok: true, value: { jobId, nodePath, stageId, type: "cron", cron } };
  }
  if (input.scheduleType === "interval") {
    const seconds = Number(input.intervalSeconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return { ok: false, error: "intervalSeconds must be a positive whole number of seconds." };
    }
    return { ok: true, value: { jobId, nodePath, stageId, type: "interval", intervalSeconds: seconds } };
  }
  return { ok: false, error: "A stage-schedule requires scheduleType \"cron\" or \"interval\"." };
}

/** The firing payload an alarm carries: stage address + schedule identity. */
export interface WorkflowStageFiringPayload {
  jobId: string;
  nodePath: string;
  stageId: string;
  /** The schedule owner's login: the firing's run-as identity. */
  userLogin?: string;
  reason?: string;
  provenance?: ScheduleProvenance;
}

/** The registry port: the stage registry (#1972) read, never written. */
export interface WorkflowStageRegistry {
  getDefinition(jobId: string): Promise<JobDefinition | null>;
}

/** One resolved stage: the definition it belongs to and the node itself. */
export interface ResolvedWorkflowStage {
  jobId: string;
  nodePath: string;
  stageId: string;
  definition: JobDefinition;
  node: JobNodeConfig;
}

/**
 * Resolve a stage against the registry. Returns null when the job
 * does not exist; throws a named refusal when the node path names no
 * stage or the stage is retired (a retired stage never runs again).
 */
export async function resolveWorkflowStage(
  registry: WorkflowStageRegistry,
  jobId: string,
  nodePath: string,
): Promise<ResolvedWorkflowStage | null> {
  const definition = await registry.getDefinition(jobId);
  if (!definition) return null;
  const node = resolveStageNode(definition.root, nodePath);
  if (node.retired === true) {
    throw new Error(
      `Stage "${workflowStageId(nodePath)}" of job "${jobId}" is retired; a retired stage never runs again.`,
    );
  }
  return { jobId, nodePath, stageId: workflowStageId(nodePath), definition, node };
}

/** The stages adapter's deps: the one store, the alarms port, the registry, the firing port. */
export interface WorkflowStageScheduleAdapterDeps {
  store: UnifiedStoreLike;
  alarms: ScheduleAlarms;
  registry: WorkflowStageRegistry;
  /** Dispatch one schedule callback now (the trigger path's firing). */
  runCallback: (callback: string, payload: unknown) => Promise<void>;
  nowIso: () => string;
}

/**
 * The capability's stages adapter over the one management service:
 * every operation resolves through the unified store + the alarms
 * port, so a stage-schedule is managed exactly like any other
 * schedule kind — no second management path.
 */
export function createWorkflowStageScheduleAdapter(
  deps: WorkflowStageScheduleAdapterDeps,
): AgentWorkflowStageScheduleAdapter {
  const management: UnifiedManagementDeps = { store: deps.store, alarms: deps.alarms };
  const timingOf = (timing: AgentSdkTiming): ResolvedScheduleTiming => {
    if (timing.type === "cron") return { type: "cron", cron: timing.cron };
    if (timing.type === "interval") return { type: "interval", intervalSeconds: timing.intervalSeconds };
    if (timing.type === "scheduled") return { type: "scheduled", time: timing.time };
    // Delayed timings never reach the validator (cron/interval only);
    // the mapping stays total so the type does not lie.
    return { type: "delayed", time: Math.floor(new Date(deps.nowIso()).getTime() / 1000) + timing.delayInSeconds };
  };
  return {
    resolveStage: (jobId, nodePath) => resolveWorkflowStage(deps.registry, jobId, nodePath),
    list: async () => deps.store.listByKind("workflow-stage"),
    get: async (id) => {
      const record = await deps.store.get(id);
      return record && record.kind === "workflow-stage" ? record : undefined;
    },
    create: async (input) => {
      const validated = validateWorkflowStageScheduleInput({
        jobId: input.jobId,
        nodePath: input.nodePath,
        scheduleType: input.timing.type === "cron" ? "cron" : "interval",
        ...(input.timing.type === "cron" ? { cron: input.timing.cron } : {}),
        ...(input.timing.type === "interval" ? { intervalSeconds: input.timing.intervalSeconds } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      if (!validated.ok) throw new Error(validated.error);
      const stage = await resolveWorkflowStage(deps.registry, input.jobId, input.nodePath);
      if (!stage) throw new Error(`Job "${input.jobId}" has no stage registry; nothing was scheduled.`);
      const timing = timingOf(input.timing);
      const payload: WorkflowStageFiringPayload = {
        jobId: input.jobId,
        nodePath: input.nodePath,
        stageId: stage.stageId,
        // The owner login rides the firing payload: the delegate's
        // dispatch gate resolves the run-as identity from it.
        ...(input.ownerLogin ? { userLogin: input.ownerLogin } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      };
      const created = await createManagedWorkflowStageSchedule(management, {
        jobId: input.jobId,
        nodePath: input.nodePath,
        stageId: stage.stageId,
        callback: WORKFLOW_STAGE_CALLBACK,
        timing,
        payload,
        ownerLogin: input.ownerLogin ?? null,
      }, deps.nowIso());
      if (!created.ok) throw new Error(created.error);
      return created.record;
    },
    cancel: async (id) => {
      const result = await deleteUnifiedSchedule(management, id);
      return result.cancelled;
    },
    pause: async (id) => {
      const result = await pauseUnifiedSchedule(management, id, deps.nowIso());
      if (!result.ok) throw new Error(result.error);
      return result.record;
    },
    resume: async (id) => {
      const result = await resumeUnifiedSchedule(management, id, deps.nowIso());
      if (!result.ok) throw new Error(result.error);
      return result.record;
    },
    trigger: async (id) => {
      const result = await triggerUnifiedSchedule(management, id, (callback, payload) =>
        deps.runCallback(callback, payload),
      );
      if (!result.ok) throw new Error(result.error);
      return { scheduleId: result.scheduleId, callback: result.callback };
    },
    update: async (id, input) => {
      const result = await updateUnifiedSchedule(management, id, {
        ...(input.timing !== undefined
          ? input.timing.type === "cron"
            ? { cron: input.timing.cron }
            : input.timing.type === "interval"
              ? { intervalSeconds: input.timing.intervalSeconds }
              : {}
          : {}),
      }, Date.now());
      if (!result.ok) throw new Error(result.error);
      return result.record;
    },
  };
}
