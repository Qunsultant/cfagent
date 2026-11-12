// @vitest-environment node
/**
 * Issue #3121 #3310 — per-stage workflow scheduling, evidenced:
 *  - the stage-schedule domain: stage addressing, external-send
 *    derivation, input validation, record projection;
 *  - the #3122 capability classifier gains the workflow-stage kind
 *    (schedulable, approval-bound when consequential, fail-closed);
 *  - the capability executor serves workflow-stage actions through
 *    the stages adapter (PDP, approval gate, ledger audit, ownership);
 *  - the unified management service serves the workflow-stage kind
 *    (create/list/pause/resume/trigger/delete/update) on the one
 *    store + the alarms port;
 *  - the engine threads the schedule id into the terminal run record
 *    (scheduleId + workflowId joinable), and a scoped firing runs
 *    only its stage;
 *  - the firing callback dispatches the scoped run through the
 *    ScheduledAgent door and reports the run id.
 */
import { describe, expect, it } from "vitest";
import { jobStageId } from "../src/workflows/stageRunnerPorts";
import {
  WORKFLOW_STAGE_CALLBACK,
  isExternalSendStage,
  resolveStageNode,
  validateWorkflowStageScheduleInput,
  workflowStageId,
  type WorkflowStageScheduleInput,
} from "../src/services/workflowStageSchedule";
import {
  classifyAgentScheduleRequest,
  type AgentScheduleApprovalConfig,
} from "../src/services/agentScheduleCapability";
import { dispatchOrchestratorA2A } from "../src/agents/orchestrator/a2aDispatch";
import { categorizeSchedule, scheduleDisplayName } from "../src/client/SchedulesPanel";

const CONFIG: AgentScheduleApprovalConfig = {
  budgetCentsThreshold: 10_000,
  minIntervalSeconds: 3_600,
};

const DEFINITION = {
  jobId: "two-child",
  name: "two-child",
  root: {
    kind: "pipeline",
    steps: [{ step: "stepA" }],
    children: [
      { kind: "feed", steps: [{ step: "stepB" }] },
      { kind: "deliver", steps: [{ step: "stepC" }], outputs: { channels: ["slack"] } },
    ],
  },
  rawConfig: {},
  config: {
    inputs: { sources: [], datasets: [], items: [] },
    processing: { inMemory: false, checkpointEverySteps: 1, shards: [] },
    outputs: { reports: [], formats: [], channels: [] },
    executionMode: { concurrency: "sequential", pacing: "batch", delivery: "async", shape: "monolith" },
    schedule: { enabled: false },
  },
  version: 1,
  updatedAt: "2026-11-12T00:00:00.000Z",
} as const;

describe("3310-D1 stage addressing is the engine's own vocabulary", () => {
  it("workflowStageId is the engine's job:<nodePath> stage id", () => {
    expect(workflowStageId("")).toBe(jobStageId(""));
    expect(workflowStageId("0")).toBe(jobStageId("0"));
    expect(workflowStageId("0/2")).toBe(jobStageId("0/2"));
    expect(workflowStageId("0")).toBe("job:0");
  });

  it("the firing callback is the internal-only stage callback", () => {
    expect(WORKFLOW_STAGE_CALLBACK).toBe("runWorkflowStage");
  });

  it("resolveStageNode walks the child-index path; the root is \"\"", () => {
    expect(resolveStageNode(DEFINITION.root, "")).toBe(DEFINITION.root);
    expect(resolveStageNode(DEFINITION.root, "0")).toBe(DEFINITION.root.children[0]);
    expect(resolveStageNode(DEFINITION.root, "1")).toBe(DEFINITION.root.children[1]);
    expect(() => resolveStageNode(DEFINITION.root, "2")).toThrow(/no stage at node path "2"/);
    expect(() => resolveStageNode(DEFINITION.root, "0/0")).toThrow(/no stage at node path "0\/0"/);
    expect(() => resolveStageNode(DEFINITION.root, "x")).toThrow(/no stage at node path "x"/);
  });

  it("a deliver stage — or any stage with output channels — is an external send", () => {
    expect(isExternalSendStage(DEFINITION.root.children[1])).toBe(true);
    expect(isExternalSendStage(DEFINITION.root.children[0])).toBe(false);
    expect(isExternalSendStage(DEFINITION.root)).toBe(false);
    expect(
      isExternalSendStage({ kind: "feed", outputs: { channels: ["email"] } }),
    ).toBe(true);
  });
});

describe("3310-D2 stage-schedule input validation (fail-closed, named refusals)", () => {
  const base: WorkflowStageScheduleInput = {
    jobId: "two-child",
    nodePath: "0",
    scheduleType: "cron",
    cron: "0 21 * * *",
  };

  it("accepts a 5-field cron and a positive interval", () => {
    expect(validateWorkflowStageScheduleInput(base)).toEqual({
      ok: true,
      value: { jobId: "two-child", nodePath: "0", stageId: "job:0", type: "cron", cron: "0 21 * * *" },
    });
    expect(
      validateWorkflowStageScheduleInput({ ...base, scheduleType: "interval", intervalSeconds: 3600 }),
    ).toEqual({
      ok: true,
      value: { jobId: "two-child", nodePath: "0", stageId: "job:0", type: "interval", intervalSeconds: 3600 },
    });
  });

  it("refuses a missing job id, node path, or timing by name", () => {
    expect(validateWorkflowStageScheduleInput({ ...base, jobId: "  " }).ok).toBe(false);
    expect(validateWorkflowStageScheduleInput({ ...base, nodePath: "" }).ok).toBe(false);
    const badCron = validateWorkflowStageScheduleInput({ ...base, cron: "0 21 * *" });
    expect(badCron.ok).toBe(false);
    if (!badCron.ok) expect(badCron.error).toContain("cron");
    const badInterval = validateWorkflowStageScheduleInput({
      ...base,
      scheduleType: "interval",
      intervalSeconds: 0,
    });
    expect(badInterval.ok).toBe(false);
    if (!badInterval.ok) expect(badInterval.error).toContain("intervalSeconds");
  });
});

describe("3310-C1 classifier: the workflow-stage kind", () => {
  it("a plain stage-schedule is schedulable with no approval", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "workflow-stage", jobId: "two-child", nodePath: "0", cron: "0 21 * * *" },
      CONFIG,
    );
    expect(out).toEqual({ schedulable: true, requiresApproval: false, approvalReasons: [] });
  });

  it("an external-send stage is approval-bound and names the reason", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "workflow-stage", jobId: "two-child", nodePath: "1", cron: "0 21 * * *", isExternalSend: true },
      CONFIG,
    );
    expect(out.schedulable).toBe(true);
    if (out.schedulable) {
      expect(out.requiresApproval).toBe(true);
      expect(out.approvalReasons.join("; ")).toContain("external send");
    }
  });

  it("a fast interval / fast cron is approval-bound; an unparsable cron binds fail-closed", () => {
    const fast = classifyAgentScheduleRequest(
      { kind: "workflow-stage", jobId: "two-child", nodePath: "0", intervalSeconds: 60 },
      CONFIG,
    );
    expect(fast.schedulable).toBe(true);
    if (fast.schedulable) expect(fast.requiresApproval).toBe(true);
    const unparsable = classifyAgentScheduleRequest(
      { kind: "workflow-stage", jobId: "two-child", nodePath: "0", cron: "not a cron" },
      CONFIG,
    );
    expect(unparsable.schedulable).toBe(true);
    if (unparsable.schedulable) expect(unparsable.requiresApproval).toBe(true);
  });

  it("a missing job id or node path is denied by name, never merely approval-bound", () => {
    for (const input of [
      { kind: "workflow-stage", jobId: "", nodePath: "0" },
      { kind: "workflow-stage", jobId: "two-child", nodePath: "" },
    ] as const) {
      const out = classifyAgentScheduleRequest(input, CONFIG);
      expect(out.schedulable).toBe(false);
      if (!out.schedulable) expect(out.denialReason).toMatch(/jobId|nodePath/);
    }
  });
});

// --- 3310-D4: the engine threads the schedule id into the terminal run record ---

import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";

interface EngineHarness {
  control: JobPipelineControl;
  counts: Map<string, number>;
  runStore: InMemoryJobRunRecordStore;
}

function makeEngineHarness(): EngineHarness {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const counts = new Map<string, number>();
  const steps = createBuiltinStepRegistry();
  for (const name of ["stepA", "stepB", "stepC"]) {
    steps.register(name, async (ctx: JobStepContext) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return { output: { from: name, input: ctx.input ?? null } };
    });
  }
  let tick = 0;
  const base = Date.parse("2026-11-12T12:00:00.000Z");
  let runCounter = 0;
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    now: () => new Date(base + tick++ * 1000),
    newRunId: () => `run-${++runCounter}`,
  };
  return { control: createJobPipelineControl(deps), counts, runStore };
}

const ENGINE_TWO_CHILD_JOB = {
  jobId: "two-child",
  root: {
    kind: "pipeline",
    steps: [{ step: "stepA" }],
    executionMode: { delivery: "sync" },
    children: [
      { kind: "feed", steps: [{ step: "stepB" }] },
      { kind: "enrich", steps: [{ step: "stepC" }] },
    ],
  },
};

describe("3310-D4 a scoped firing threads the schedule id into the terminal run record", () => {
  it("a scheduled scoped run stamps scheduleId + workflowId; only its stage runs", async () => {
    const h = makeEngineHarness();
    await h.control.defineJob(ENGINE_TWO_CHILD_JOB);
    const outcome = await h.control.runJob("two-child", {
      trigger: "scheduled",
      scopePath: "0",
      scheduleId: "sched-123",
    });
    expect(outcome.state).toBe("completed");
    expect(outcome.runId).toBe("run-1");
    // Only the scoped stage ran: the root's stepA and the sibling's stepC never fired.
    expect(h.counts.get("stepB")).toBe(1);
    expect(h.counts.get("stepA") ?? 0).toBe(0);
    expect(h.counts.get("stepC") ?? 0).toBe(0);
    // The terminal run record joins to the schedule and to the workflow instance.
    const record = h.runStore.latestByJob("two-child");
    expect(record?.scheduleId).toBe("sched-123");
    expect(record?.workflowId).toBe("run-1");
    expect(record?.asyncJobId).toBeNull();
    expect(record?.triggeredBy).toBe("scheduled");
  });

  it("a run with no schedule stamps explicit nulls — never a laundered id", async () => {
    const h = makeEngineHarness();
    await h.control.defineJob(ENGINE_TWO_CHILD_JOB);
    await h.control.runJob("two-child");
    const record = h.runStore.latestByJob("two-child");
    expect(record?.scheduleId).toBeNull();
    expect(record?.workflowId).toBe("run-1");
    expect(record?.asyncJobId).toBeNull();
  });
});

// --- 3310-D3: the firing callback dispatches the scoped run through the door ---

import {
  runWorkflowStage,
  type ScheduledCallbacksContext,
} from "../src/agents/orchestrator/scheduledCallbacks";

describe("3310-D3 the firing callback dispatches the scoped run through the door", () => {
  interface FakeDoor {
    calls: Array<{ jobId: string; opts: unknown }>;
    runPipelineStage: (
      jobId: string,
      opts?: { nodePath?: string; userLogin?: string; scheduleId?: string; trigger?: string },
    ) => Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  }

  function makeDoor(outcome?: { runId: string; state: string }): FakeDoor {
    const calls: FakeDoor["calls"] = [];
    return {
      calls,
      runPipelineStage: async (jobId, opts) => {
        calls.push({ jobId, opts });
        return { jobId, runId: outcome?.runId ?? "run-1", state: outcome?.state ?? "completed" };
      },
    };
  }

  function makeCallbackCtx(door: FakeDoor): ScheduledCallbacksContext {
    const env = {
      SCHEDULED_AGENT: {
        idFromName: (name: string) => name,
        get: () => door,
      },
    };
    return {
      env,
      getScreenerExecutionContext: async () => undefined,
      audit: () => {},
    } as unknown as ScheduledCallbacksContext;
  }

  it("dispatches the scoped run and reports the run id as the descriptor", async () => {
    const door = makeDoor();
    const ctx = makeCallbackCtx(door);
    const outcome = await runWorkflowStage(ctx, {
      jobId: "two-child",
      nodePath: "0",
      stageId: "job:0",
      scheduleId: "sched-1",
      userLogin: "owner-login",
    });
    expect(outcome.outcome).toBe("success");
    expect(outcome.descriptor).toBe("run-1");
    expect(door.calls).toHaveLength(1);
    expect(door.calls[0]).toEqual({
      jobId: "two-child",
      opts: { nodePath: "0", userLogin: "owner-login", scheduleId: "sched-1", trigger: "scheduled" },
    });
  });

  it("a manual trigger fires with trigger manual, not scheduled", async () => {
    const door = makeDoor();
    const ctx = makeCallbackCtx(door);
    await runWorkflowStage(ctx, {
      jobId: "two-child",
      nodePath: "0",
      stageId: "job:0",
      scheduleId: "sched-1",
      trigger: "manual",
      userLogin: "owner-login",
    });
    expect(door.calls[0]?.opts).toMatchObject({ trigger: "manual" });
  });

  it("a retired stage fails the firing with the named refusal, never a silent skip", async () => {
    const door = makeDoor();
    door.runPipelineStage = async () => {
      throw new Error('Stage "job:0" of job "two-child" is retired; a retired stage never runs again.');
    };
    const ctx = makeCallbackCtx(door);
    const outcome = await runWorkflowStage(ctx, {
      jobId: "two-child",
      nodePath: "0",
      stageId: "job:0",
      scheduleId: "sched-1",
      userLogin: "owner-login",
    });
    expect(outcome.outcome).toBe("failure");
    expect(outcome.error).toContain("retired");
  });

  it("a firing with no identity is skipped, never run", async () => {
    const door = makeDoor();
    const ctx = makeCallbackCtx(door);
    const outcome = await runWorkflowStage(ctx, {
      jobId: "two-child",
      nodePath: "0",
      stageId: "job:0",
      scheduleId: "sched-1",
    });
    expect(outcome.outcome).toBe("skipped");
    expect(outcome.detail).toContain("dispatch denied");
    expect(door.calls).toHaveLength(0);
  });

  it("a payload with no stage address fails closed, never dispatches", async () => {
    const door = makeDoor();
    const ctx = makeCallbackCtx(door);
    const outcome = await runWorkflowStage(ctx, {
      jobId: "",
      nodePath: "0",
      stageId: "job:0",
      userLogin: "owner-login",
    });
    expect(outcome.outcome).toBe("failure");
    expect(outcome.error).toContain("jobId");
    expect(door.calls).toHaveLength(0);
  });
});

// --- 3310-E/M: the capability executor + the one management service over the real store ---

import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import {
  createWorkflowStageScheduleAdapter,
  type WorkflowStageRegistry,
} from "../src/services/workflowStageSchedule";
import {
  executeAgentScheduleAction,
  type AgentWorkflowStageScheduleAdapter,
  type PendingScheduleApproval,
} from "../src/services/agentScheduleCapability";
import type { ScheduleAlarmLike, UnifiedManagementDeps } from "../src/services/unifiedScheduleManagement";
import { listUnifiedScheduleItems } from "../src/services/unifiedScheduleManagement";

const RETIRED_DEFINITION = {
  ...DEFINITION,
  jobId: "retired-job",
  name: "retired-job",
  root: {
    ...DEFINITION.root,
    children: [{ kind: "feed", steps: [{ step: "stepB" }], retired: true }],
  },
} as unknown as (typeof DEFINITION);

interface StageHarness {
  store: InMemoryUnifiedScheduleStore;
  alarms: Map<string, ScheduleAlarmLike>;
  runs: Array<{ callback: string; payload: unknown }>;
  adapter: AgentWorkflowStageScheduleAdapter;
  management: UnifiedManagementDeps;
}

function makeStageHarness(): StageHarness {
  const store = new InMemoryUnifiedScheduleStore();
  const alarms = new Map<string, ScheduleAlarmLike>();
  const runs: Array<{ callback: string; payload: unknown }> = [];
  let seq = 0;
  const alarmsPort = {
    list: async () => [...alarms.values()],
    get: async (id: string) => alarms.get(id),
    cancel: async (id: string) => alarms.delete(id),
    arm: async (timing: { type: string; cron?: string; intervalSeconds?: number; time?: number }, callback: string, payload: unknown) => {
      const alarm: ScheduleAlarmLike = {
        id: `alarm-${++seq}`,
        callback,
        type: timing.type,
        ...(timing.cron !== undefined ? { cron: timing.cron } : {}),
        ...(timing.intervalSeconds !== undefined ? { intervalSeconds: timing.intervalSeconds } : {}),
        payload,
      };
      alarms.set(alarm.id, alarm);
      return alarm;
    },
  };
  const registry: WorkflowStageRegistry = {
    getDefinition: async (jobId: string) => {
      if (jobId === "two-child") return DEFINITION as never;
      if (jobId === "retired-job") return RETIRED_DEFINITION as never;
      return null;
    },
  };
  const adapter = createWorkflowStageScheduleAdapter({
    store,
    alarms: alarmsPort,
    registry,
    runCallback: async (callback, payload) => {
      runs.push({ callback, payload });
    },
    nowIso: () => "2026-11-12T12:00:00.000Z",
  });
  return { store, alarms, runs, adapter, management: { store, alarms: alarmsPort } };
}

describe("3310-E executor: workflow-stage actions through the stages adapter", () => {
  const principal = { login: "OpenAIMP", agentId: "agent-1" };

  function executorHarness(h: StageHarness, pdpAllowed = true) {
    const ledger: unknown[] = [];
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let pending: PendingScheduleApproval[] = [];
    return {
      deps: {
        pdp: async () => ({ enforced: true as const, allowed: pdpAllowed as const }),
        config: CONFIG,
        nowMs: () => 1_700_000_000_000,
        nowIso: () => "2026-11-12T12:00:00.000Z",
        recordLedger: (record: unknown) => {
          ledger.push(record);
        },
        audit: (type: string, payload: Record<string, unknown>) => {
          audits.push({ type, payload });
        },
        pendingApprovals: {
          load: async () => pending,
          save: async (list: PendingScheduleApproval[]) => {
            pending = list;
          },
        },
        stores: { stages: h.adapter },
      },
      ledger,
      audits,
      getPending: () => pending,
    };
  }

  it("E1 creates a plain stage-schedule: armed with agent provenance + ledger row + audit", async () => {
    const h = makeStageHarness();
    const { deps, ledger, audits } = executorHarness(h);
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
    });
    expect(out.ok).toBe(true);
    expect(out.scheduleId).toBe("alarm-1");
    const record = await h.store.get("alarm-1");
    expect(record?.kind).toBe("workflow-stage");
    expect(record?.ownerLogin).toBe("OpenAIMP");
    expect((record?.definition as Record<string, unknown>).stageId).toBe("job:0");
    expect(ledger.length).toBeGreaterThan(0);
    expect(audits.some((a) => a.type === "schedule.created" && a.payload.jobId === "two-child")).toBe(true);
  });

  it("E2 an external-send stage is approval-bound; the approved arming then succeeds", async () => {
    const h = makeStageHarness();
    const { deps, getPending } = executorHarness(h);
    const create = {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "two-child",
      nodePath: "1",
      timing: { type: "cron", cron: "0 21 * * *" },
    } as const;
    const refused = await executeAgentScheduleAction(deps as never, create);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("approval-required");
    const pending = getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("workflow-stage");
    expect(pending[0]?.definition).toMatchObject({ jobId: "two-child", nodePath: "1" });
    expect(h.alarms.size).toBe(0);
    const armed = await executeAgentScheduleAction(deps as never, {
      ...create,
      approvedPendingId: pending[0]?.id,
    });
    expect(armed.ok).toBe(true);
    expect(h.alarms.size).toBe(1);
  });

  it("E3 a retired stage is denied by name; a job with no registry is denied by name", async () => {
    const h = makeStageHarness();
    const { deps } = executorHarness(h);
    const retired = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "retired-job",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
    });
    expect(retired.ok).toBe(false);
    if (!retired.ok) {
      expect(retired.code).toBe("denied");
      expect(retired.reason).toContain("retired");
    }
    const missing = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "no-such-job",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("no-such-job");
    expect(h.alarms.size).toBe(0);
  });

  it("E4 a PDP denial never arms", async () => {
    const h = makeStageHarness();
    const { deps } = executorHarness(h, false);
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("denied");
    expect(h.alarms.size).toBe(0);
  });

  it("E5 ownership: another login cannot pause a stage-schedule it does not own", async () => {
    const h = makeStageHarness();
    const { deps } = executorHarness(h);
    const created = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
    });
    expect(created.ok).toBe(true);
    const denied = await executeAgentScheduleAction(deps as never, {
      action: "pause",
      kind: "workflow-stage",
      principal: { login: "someone-else", agentId: "agent-2" },
      tenantId: "primary",
      scheduleId: "alarm-1",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("belongs to");
    const allowed = await executeAgentScheduleAction(deps as never, {
      action: "pause",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      scheduleId: "alarm-1",
    });
    expect(allowed.ok).toBe(true);
  });

  it("E6 pause / resume / trigger / delete / list round-trip through the executor", async () => {
    const h = makeStageHarness();
    const { deps } = executorHarness(h);
    await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "interval", intervalSeconds: 3600 },
    });
    const listed = await executeAgentScheduleAction(deps as never, {
      action: "list",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect((listed.schedule as unknown[]).length).toBe(1);
    const paused = await executeAgentScheduleAction(deps as never, {
      action: "pause",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      scheduleId: "alarm-1",
    });
    expect(paused.ok).toBe(true);
    expect(h.alarms.size).toBe(0);
    const resumed = await executeAgentScheduleAction(deps as never, {
      action: "resume",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      scheduleId: "alarm-1",
    });
    expect(resumed.ok).toBe(true);
    expect(h.alarms.size).toBe(1);
    const triggered = await executeAgentScheduleAction(deps as never, {
      action: "trigger",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      scheduleId: "alarm-1",
    });
    expect(triggered.ok).toBe(true);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.callback).toBe("runWorkflowStage");
    expect(h.runs[0]?.payload).toMatchObject({ jobId: "two-child", nodePath: "0", trigger: "manual", scheduleId: "alarm-1" });
    const deleted = await executeAgentScheduleAction(deps as never, {
      action: "delete",
      kind: "workflow-stage",
      principal,
      tenantId: "primary",
      scheduleId: "alarm-1",
    });
    expect(deleted.ok).toBe(true);
    expect(await h.store.get("alarm-1")).toBeUndefined();
  });
});

describe("3310-M the one management service serves the workflow-stage kind", () => {
  it("M1 create / list / pause / resume / trigger / delete on the one store + alarms port", async () => {
    const h = makeStageHarness();
    const created = await h.adapter.create({
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
      ownerLogin: "OpenAIMP",
    });
    expect(created.id).toBe("alarm-1");
    expect(created.kind).toBe("workflow-stage");
    const items = await listUnifiedScheduleItems(h.management);
    const row = items.find((i) => i.id === "alarm-1");
    expect(row?.kind).toBe("workflow-stage");
    expect(row?.jobId).toBe("two-child");
    expect(row?.stageId).toBe("job:0");
    const paused = await h.adapter.pause!("alarm-1");
    expect(paused.state).toBe("paused");
    expect(h.alarms.size).toBe(0);
    const resumed = await h.adapter.resume!("alarm-1");
    expect(resumed.state).toBe("active");
    expect(resumed.id).toBe("alarm-1");
    expect(h.alarms.size).toBe(1);
    await h.adapter.trigger!("alarm-1");
    expect(h.runs[0]?.payload).toMatchObject({ jobId: "two-child", nodePath: "0", trigger: "manual", scheduleId: "alarm-1" });
    const cancelled = await h.adapter.cancel("alarm-1");
    expect(cancelled).toBe(true);
    expect(await h.store.get("alarm-1")).toBeUndefined();
  });

  it("M2 a paused stage-schedule re-times in place, keeping its stage address", async () => {
    const h = makeStageHarness();
    await h.adapter.create({
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "cron", cron: "0 21 * * *" },
      ownerLogin: "OpenAIMP",
    });
    await h.adapter.pause!("alarm-1");
    const updated = await h.adapter.update!("alarm-1", { timing: { type: "interval", intervalSeconds: 7200 } });
    expect(updated.id).toBe("alarm-1");
    expect((updated.definition as Record<string, unknown>).jobId).toBe("two-child");
    expect((updated.definition as Record<string, unknown>).nodePath).toBe("0");
    expect((updated.definition as Record<string, unknown>).intervalSeconds).toBe(7200);
  });
});

describe("A2A schedule.* ops with kind workflow-stage (issue #3121 #3310)", () => {
  // The A2A dispatch harness, mirrored from the #3122 A2A tests: a
  // fake capability that records the request it receives.
  const principal = { login: "OpenAIMP", agentId: "a2a-test" };
  const ENV = { IAAA_TENANT_ID: "primary" } as never;

  function makeScheduleDeps() {
    const requests: Array<Record<string, unknown>> = [];
    const deps: Record<string, unknown> = {
      sessionId: "sess-a2a-stage",
      sql: { exec: (_q: string, ..._a: unknown[]) => [] as unknown[] },
      audit: () => {},
      agentScheduleExecute: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { ok: true, scheduleId: "stage-1", schedule: { id: "stage-1" } };
      },
      schedulePrincipal: principal,
    };
    return { deps, requests };
  }

  it("3310-A2A1 schedule.create with kind workflow-stage delegates with jobId + nodePath", async () => {
    const { deps, requests } = makeScheduleDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      {
        operation: "schedule.create",
        kind: "workflow-stage",
        jobId: "two-child",
        nodePath: "0",
        timing: { type: "interval", intervalSeconds: 3600 },
      },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: "create",
      kind: "workflow-stage",
      jobId: "two-child",
      nodePath: "0",
      timing: { type: "interval", intervalSeconds: 3600 },
      principal,
      tenantId: "primary",
    });
  });

  it("3310-A2A2 schedule.create with kind workflow-stage but no nodePath refuses and never calls the capability", async () => {
    const { deps, requests } = makeScheduleDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      {
        operation: "schedule.create",
        kind: "workflow-stage",
        jobId: "two-child",
        timing: { type: "interval", intervalSeconds: 3600 },
      },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(requests).toHaveLength(0);
  });

  it("3310-A2A3 schedule.list / pause with kind workflow-stage carry the kind through", async () => {
    const { deps, requests } = makeScheduleDeps();
    const list = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.list", kind: "workflow-stage" },
      deps as never,
    );
    expect(list.ok).toBe(true);
    const pause = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.pause", kind: "workflow-stage", scheduleId: "stage-1" },
      deps as never,
    );
    expect(pause.ok).toBe(true);
    expect(requests.map((r) => [r.action, r.kind])).toEqual([
      ["list", "workflow-stage"],
      ["pause", "workflow-stage"],
    ]);
  });
});

describe("Schedules home stage-schedule rows (issue #3121 #3310)", () => {
  it("3310-U1 a stage-schedule row names its workflow + stage, not the firing callback", () => {
    expect(
      scheduleDisplayName({
        id: "stage-1",
        type: "cron",
        callback: "runWorkflowStage",
        kind: "workflow-stage",
        jobId: "two-child",
        stageId: "job:0",
      }),
    ).toBe("two-child · job:0");
    expect(
      scheduleDisplayName({ id: "s-1", type: "cron", callback: "autonomousMarketScreen" }),
    ).toBe("autonomousMarketScreen");
    expect(categorizeSchedule({ id: "stage-1", type: "cron", callback: "runWorkflowStage", kind: "workflow-stage", jobId: "two-child", stageId: "job:0" })).toBe("system");
  });
});

describe("D1 migration v59 — run_schedule_id (issue #3121 #3310)", () => {
  it("3310-M1 v59 is registered and alters job_pipeline_instances", async () => {
    const { ALL_MIGRATIONS, MIGRATION_0061_JOB_PIPELINE_RUN_SCHEDULE_ID } = await import(
      "../src/data/migrationRunner"
    );
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0061_JOB_PIPELINE_RUN_SCHEDULE_ID);
    expect(MIGRATION_0061_JOB_PIPELINE_RUN_SCHEDULE_ID.version).toBe(61);
    expect(MIGRATION_0061_JOB_PIPELINE_RUN_SCHEDULE_ID.sql).toContain(
      "ALTER TABLE job_pipeline_instances ADD COLUMN run_schedule_id TEXT",
    );
    // DDL/schema parity: the drizzle table carries the same column.
    const { jobPipelineInstances } = await import("../src/data/drizzleSchema");
    expect(jobPipelineInstances.runScheduleId).toBeDefined();
  });
});
