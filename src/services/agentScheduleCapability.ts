/**
 * Issue #3121 Phase 3 (#3122) — the one agent-facing schedule-management
 * capability.
 *
 * An agent, acting for a tenant (per-login instance — F4, #2457 dependency
 * recorded, no tenant mapping invented), can create, update, pause, resume,
 * trigger, delete, and list a schedule for any task the tenant may run —
 * through this module only. It operates on the #3123 unified schedule
 * store through injected adapters (SDK alarms + goal records + stage
 * records, #3310): the SDK adapter adopts each armed alarm into the
 * store (record id = alarm id, #3123's adoption precedent), the goals
 * adapter reads the store through the ScheduledAgent's
 * getGoals/saveGoals, and the stages adapter arms one pipeline stage
 * through the SDK alarm substrate with the internal-only
 * `runWorkflowStage` callback — no second schedule path is built here.
 *
 * Layering (each layer is independently testable, and no layer trusts the
 * one above it):
 *  1. Task registry — which tasks are agent-schedulable, which are
 *     excluded, which are approval-bound (S0 §8 boundary, recorded in
 *     #3122's build spec; the owner amends it, this module does not).
 *  2. Classifier — pure: allow-list, F2 exclusions, consequential
 *     classes (external send / spend / frequency / trading).
 *  3. PDP — every action evaluated through the same compiled policy +
 *     membership PIP as `evaluateRoutePep` (see `evaluateAgentSchedulePdp`;
 *     the session precondition of `evaluateRoutePep` cannot be met inside
 *     the DO routes — Worker headers carry login/environment only — so the
 *     capability calls the same PDP decision via `authorize()` with the
 *     alias-resolved principal).
 *  4. Approval binding — a consequential schedule that is not approved is
 *     refused and recorded as a pending approval; it never arms.
 *  5. Audit — every action (allowed or refused) writes a consolidated
 *     run-ledger row with agent identity / tenant / schedule, plus the
 *     existing `ctx.audit` event for SDK actions (goal mutations audit
 *     themselves through the DO-side sink, #3312).
 *
 * This module is pure domain code plus injected ports: no DO access, no
 * fetch, no direct env reads (thresholds arrive as a resolved config
 * object — see `AgentScheduleApprovalConfig`).
 */
import {
  CREATABLE_SCHEDULE_CALLBACKS,
  INTERNAL_RECORDED_SCHEDULE_CALLBACKS,
} from "../agents/orchestrator/scheduleCallbacks";
import type { ScheduleProvenance } from "../schedule";
import type { Permission } from "../security/authorization";
import {
  authorize,
  type AuthorizationDecision,
} from "../security/authorization";
import { isPdpEnabled, resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { lookupInternalUserIdByLogin } from "../security/iaaaMigration";
import { createKvMembershipStore } from "../security/iaaaMembershipStore";
import { createKvPermissionDenialStore } from "../security/iaaaPermissionDenialStore";
import { sessionStore } from "../security/session";
import { buildJobRunRecord, type JobRunRecord } from "./jobRunRecords";
import type { AgentScheduleItem } from "../types";
import type { Env } from "../types";
import { SqlJobRunRecordStore } from "../data/doSqliteJobRunRecordAdapter";
import { createPendingScheduleApprovalPort } from "../data/doSqlitePendingScheduleApprovalsAdapter";
import type { UnifiedStoreLike } from "./unifiedScheduleManagement";
import type { UnifiedScheduleRecord } from "../data/unifiedSchedulePorts";
import type { JobNodeConfig } from "../data/jobPipelinePorts";
import { isExternalSendStage } from "./workflowStageSchedule";
import type { ResolvedWorkflowStage } from "./workflowStageSchedule";
import { screenScheduleToRecord } from "./unifiedScheduleManagement";
import { resolveEnvironmentConfig } from "../config/environment";
import type { SqlStorage } from "../orm";
import type { NLQSchedulingPort } from "../agents/nlq/types";

/* =====================================================================
 * Task registry (S0 §8 boundary, recorded in #3122's build spec)
 * ===================================================================== */

/** The reminder callback: NLQ-only today, agent-schedulable on the same terms. */
export const AGENT_SCHEDULABLE_REMINDER_CALLBACK = "sendScheduledReminder";

/** Agent-schedulable SDK callbacks: exactly the four creatable callbacks (re-exported, never copied). */
export const AGENT_SCHEDULABLE_CALLBACKS: readonly string[] = CREATABLE_SCHEDULE_CALLBACKS;

/**
 * Excluded SDK callbacks: the four internal-only callbacks (REST already
 * refuses them with 400; NLQ must match — F1) plus the code-armed system
 * duties no agent may ever arm.
 */
export const AGENT_EXCLUDED_CALLBACKS: readonly string[] = [
  ...INTERNAL_RECORDED_SCHEDULE_CALLBACKS,
  "sweepStaleLedgerTasks",
  "watchdogMissedSchedules",
  "sweepStaleAsyncJobs",
  "pushTicks",
];

/**
 * Agent-schedulable goal operations: the families that EXECUTE at firing
 * (S0 §3, F2). `pipeline:*` is a prefix: every pipeline goal executes its
 * stages at firing.
 */
export const AGENT_SCHEDULABLE_GOAL_OPERATIONS: readonly string[] = [
  "social.publish",
  "resource.rollup_daily",
  "resource.cap_alert",
  "resource.dashboard_comparison",
  "index.refresh_wikipedia",
  "index.refresh_holdings",
  "chain.execute",
  "pipeline:*",
  // Issue #4411: the monthly Autopilot evaluation executes at firing
  // (dry-run policy-envelope check through the evaluate endpoint).
  "autopilot.evaluate",
];

/**
 * Excluded goal operations (F2): descriptor-only — `createJob` mints a
 * pending descriptor and executes nothing, so an agent scheduling one
 * would get a success row and no work. Excluded until their execution
 * path is wired (a separate capability, never folded silently into #3122).
 */
export const AGENT_EXCLUDED_GOAL_OPERATIONS: readonly {
  operation: string;
  reason: string;
}[] = [
  { operation: "search.query", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "payments.draft", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "tasks.create", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "memory.remember", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "nlq.execute", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "qa.supervised_fix", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "qa.run_sweep", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "trading.screen_stocks", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "trading.screen_options", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "trading.trade_stock", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
  { operation: "trading.trade_options", reason: "descriptor-only: fires mint a pending descriptor and execute nothing (F2)" },
];

/**
 * Always approval-bound goal operations (external send): the firing sends
 * outside the platform. `pipeline:social-daily` publishes, so it binds
 * too; other `pipeline:*` goals are data pipelines whose stages are
 * governed by their own gates at firing.
 */
export const AGENT_APPROVAL_BOUND_GOAL_OPERATIONS: readonly string[] = [
  "social.publish",
  "pipeline:social-daily",
];

/** True when the callback is one an agent may schedule. */
export function isAgentSchedulableCallback(callback: unknown): boolean {
  return (
    typeof callback === "string" &&
    (AGENT_SCHEDULABLE_CALLBACKS as readonly string[]).includes(callback)
  );
}

/** True when the NLQ path may arm the callback (F1): the reminder plus the creatable four. */
export function isNlqScheduleCallbackAllowed(callback: unknown): boolean {
  return (
    callback === AGENT_SCHEDULABLE_REMINDER_CALLBACK ||
    isAgentSchedulableCallback(callback)
  );
}

function goalOperationMatches(entry: string, operation: string): boolean {
  if (entry.endsWith(":*")) return operation.startsWith(entry.slice(0, -1));
  return entry === operation;
}

/** True when the goal operation is one an agent may schedule (executes at firing). */
export function isAgentSchedulableGoalOperation(operation: unknown): boolean {
  return (
    typeof operation === "string" &&
    AGENT_SCHEDULABLE_GOAL_OPERATIONS.some((entry) => goalOperationMatches(entry, operation))
  );
}

/** The exclusion reason for a goal operation, or undefined when it is not excluded. */
export function agentExcludedGoalOperationReason(operation: unknown): string | undefined {
  if (typeof operation !== "string") return "no goal operation was named";
  return AGENT_EXCLUDED_GOAL_OPERATIONS.find((entry) => entry.operation === operation)?.reason;
}

/* =====================================================================
 * Classification (pure)
 * ===================================================================== */

/** Owner-configured approval gating values. Absent = fail-closed (see below). */
export interface AgentScheduleApprovalConfig {
  /** Budget above this (cents) binds approval. Unset ⇒ any budget binds. */
  budgetCentsThreshold?: number;
  /** Interval below this (seconds) binds approval. Unset ⇒ any interval binds. */
  minIntervalSeconds?: number;
}

export type AgentScheduleKind = "sdk-callback" | "goal-operation" | "workflow" | "workflow-stage";

export interface AgentScheduleClassifyInput {
  kind: AgentScheduleKind;
  callback?: string;
  operation?: string;
  /** The job whose stage is scheduled (workflow-stage kind only). */
  jobId?: string;
  /** The child-index path of the stage (workflow-stage kind only). */
  nodePath?: string;
  /** Budget the schedule carries (cents), when any. */
  budgetCents?: number;
  /** Interval the schedule fires on (seconds), when it is an interval schedule. */
  intervalSeconds?: number;
  /** Cron expression, when it is a cron schedule. */
  cron?: string;
  /** True when the firing sends outside the platform (derived from the payload/operation by the caller). */
  isExternalSend?: boolean;
}

export type AgentScheduleClassification =
  | { schedulable: true; requiresApproval: boolean; approvalReasons: string[] }
  | { schedulable: false; denialReason: string };

/**
 * Estimate the minimum gap between firings of a 5-field cron, in minutes.
 * Minute/hour fields only (the day pattern can only widen the gap, so the
 * estimate is an upper bound on frequency — it errs toward approval-binding,
 * never away from it). Unparsable ⇒ undefined (the caller binds approval on
 * uncertainty).
 */
export function estimateCronMinGapMinutes(cron: string): number | undefined {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return undefined;
  const parseField = (field: string, max: number): number | undefined => {
    if (field === "*") return max + 1;
    if (field.startsWith("*/")) {
      const n = Number(field.slice(2));
      if (!Number.isSafeInteger(n) || n <= 0 || n > max) return undefined;
      return Math.floor((max + 1) / n);
    }
    const parts = field.split(",");
    const values = new Set<number>();
    for (const part of parts) {
      if (part.includes("-")) {
        const [lo, hi] = part.split("-").map(Number);
        if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi > max || lo > hi) return undefined;
        for (let v = lo; v <= hi; v++) values.add(v);
      } else if (part.includes("/")) {
        return undefined;
      } else {
        const v = Number(part);
        if (!Number.isSafeInteger(v) || v < 0 || v > max) return undefined;
        values.add(v);
      }
    }
    return values.size;
  };
  const perHour = parseField(fields[0], 59);
  const perDayHours = parseField(fields[1], 23);
  if (perHour === undefined || perDayHours === undefined || perHour <= 0 || perDayHours <= 0) return undefined;
  return 1440 / (perHour * perDayHours);
}

/**
 * The boundary in code. Order: exclusion first (a denied request is never
 * merely approval-bound), then the consequential classes. Fail-closed:
 * a missing threshold binds the class; an unparsable cron binds approval.
 */
export function classifyAgentScheduleRequest(
  input: AgentScheduleClassifyInput,
  config: AgentScheduleApprovalConfig = {},
): AgentScheduleClassification {
  if (input.kind === "sdk-callback") {
    if (typeof input.callback !== "string" || !input.callback.trim()) {
      return { schedulable: false, denialReason: "No schedule callback was named." };
    }
    if (!isAgentSchedulableCallback(input.callback)) {
      return {
        schedulable: false,
        denialReason: `Callback '${input.callback}' is not agent-schedulable: only ${AGENT_SCHEDULABLE_CALLBACKS.join(", ")} may be armed by an agent (S0 §8A).`,
      };
    }
  } else if (input.kind === "goal-operation") {
    if (typeof input.operation !== "string" || !input.operation.trim()) {
      return { schedulable: false, denialReason: "No goal operation was named." };
    }
    const exclusion = agentExcludedGoalOperationReason(input.operation);
    if (exclusion) {
      return {
        schedulable: false,
        denialReason: `Goal operation '${input.operation}' is not agent-schedulable: ${exclusion}`,
      };
    }
    if (!isAgentSchedulableGoalOperation(input.operation)) {
      return {
        schedulable: false,
        denialReason: `Goal operation '${input.operation}' is not agent-schedulable: it is neither an executing family nor a known operation (S0 §8).`,
      };
    }
  } else if (input.kind === "workflow-stage") {
    // Issue #3310 — one pipeline stage on its own schedule. The
    // stage must be addressed (job + node path); registry existence
    // and retirement are checked by the stages adapter, which names
    // the refusal. The consequential classes below (external send /
    // spend / frequency) apply exactly as for any other schedule.
    if (typeof input.jobId !== "string" || !input.jobId.trim()) {
      return { schedulable: false, denialReason: "A stage-schedule requires a jobId naming its workflow." };
    }
    if (typeof input.nodePath !== "string" || !input.nodePath.trim()) {
      return { schedulable: false, denialReason: "A stage-schedule requires a nodePath naming its stage." };
    }
  } else {
    // Whole-workflow schedules: schedulable as today.
    if (input.kind !== "workflow") {
      return { schedulable: false, denialReason: "Unknown schedule kind." };
    }
  }

  const approvalReasons: string[] = [];
  const isExternalSend =
    input.isExternalSend === true ||
    (typeof input.operation === "string" &&
      (AGENT_APPROVAL_BOUND_GOAL_OPERATIONS as readonly string[]).includes(input.operation));
  if (isExternalSend) approvalReasons.push("external send: the firing sends outside the platform");
  if (typeof input.budgetCents === "number" && input.budgetCents > 0) {
    if (config.budgetCentsThreshold === undefined) {
      approvalReasons.push("spend: a budget is carried and no budget threshold is configured (fail-closed)");
    } else if (input.budgetCents > config.budgetCentsThreshold) {
      approvalReasons.push(`spend: budget ${input.budgetCents}c exceeds the configured threshold ${config.budgetCentsThreshold}c`);
    }
  }
  if (typeof input.intervalSeconds === "number" && input.intervalSeconds > 0) {
    if (config.minIntervalSeconds === undefined) {
      approvalReasons.push("high frequency: an interval is set and no frequency floor is configured (fail-closed)");
    } else if (input.intervalSeconds < config.minIntervalSeconds) {
      approvalReasons.push(`high frequency: interval ${input.intervalSeconds}s is below the configured floor ${config.minIntervalSeconds}s`);
    }
  }
  if (typeof input.cron === "string" && input.cron.trim()) {
    const gapMinutes = estimateCronMinGapMinutes(input.cron);
    if (gapMinutes === undefined) {
      approvalReasons.push("high frequency: the cron expression could not be parsed (fail-closed)");
    } else if (config.minIntervalSeconds === undefined) {
      approvalReasons.push("high frequency: a cron is set and no frequency floor is configured (fail-closed)");
    } else if (gapMinutes * 60 < config.minIntervalSeconds) {
      approvalReasons.push(`high frequency: cron fires about every ${gapMinutes}m, below the configured floor ${config.minIntervalSeconds}s`);
    }
  }
  return { schedulable: true, requiresApproval: approvalReasons.length > 0, approvalReasons };
}

/* =====================================================================
 * PDP (same compiled policy + membership PIP as evaluateRoutePep)
 * ===================================================================== */

export type AgentScheduleAction =
  | "create"
  | "update"
  | "pause"
  | "resume"
  | "trigger"
  | "delete"
  | "list"
  | "approve";

/**
 * Action → permission map. Existing permissions only — no policy change.
 * `task:*` is the schedulable-unit vocabulary (OPERATION_CATALOG calls
 * them tasks); `action:execute` is the manual-fire permission;
 * `action:approve` is the approver-role permission.
 */
export const AGENT_SCHEDULE_ACTION_PERMISSIONS: Record<AgentScheduleAction, Permission> = {
  create: "task:create",
  update: "task:create",
  pause: "task:cancel",
  resume: "task:cancel",
  trigger: "action:execute",
  delete: "task:cancel",
  list: "task:read",
  approve: "action:approve",
};

/** Actions that arm (or re-arm) work: the approval gate applies to these only. */
export const AGENT_SCHEDULE_APPROVAL_GATED_ACTIONS: readonly AgentScheduleAction[] = [
  "create",
  "update",
];

export interface AgentSchedulePrincipal {
  /** The principal login the agent acts for (per-login instance = tenant scope, F4). */
  login: string;
  /** The acting agent id (e.g. the A2A caller surface, the NLQ agent id). */
  agentId: string;
}

export interface AgentSchedulePdpInput {
  principal: AgentSchedulePrincipal;
  tenantId: string;
  action: AgentScheduleAction;
  nowMs: number;
}

export type AgentSchedulePdpOutcome =
  | { enforced: true; allowed: boolean; reason?: string }
  | { enforced: false };

export interface AgentSchedulePdpDeps {
  env: Partial<Env>;
  isPdpEnabled: (env: Partial<Env> | null | undefined) => boolean;
  resolvePrincipalInternalUserId: (login: string) => Promise<string | null>;
  authorize: (input: {
    actorInternalUserId: string;
    tenantId: string;
    permission: Permission;
    nowMs: number;
  }) => Promise<AuthorizationDecision>;
}

/**
 * Evaluate the PDP for one agent schedule action. The subject is the
 * PRINCIPAL (the agent never has its own membership — it acts within the
 * principal's scope, #2331 run-as). Fail-closed: with PDP on and no
 * resolvable principal, the action is denied; with PDP off the outcome
 * is not-enforced and the capability's deterministic boundary (which
 * always applies) is the only gate.
 */
export async function evaluateAgentSchedulePdp(
  deps: AgentSchedulePdpDeps,
  input: AgentSchedulePdpInput,
): Promise<AgentSchedulePdpOutcome> {
  if (!deps.isPdpEnabled(deps.env)) return { enforced: false };
  const internalUserId = await deps.resolvePrincipalInternalUserId(input.principal.login);
  if (!internalUserId) {
    return {
      enforced: true,
      allowed: false,
      reason: `no resolvable principal for login '${input.principal.login}'`,
    };
  }
  const decision = await deps.authorize({
    actorInternalUserId: internalUserId,
    tenantId: input.tenantId,
    permission: AGENT_SCHEDULE_ACTION_PERMISSIONS[input.action],
    nowMs: input.nowMs,
  });
  return {
    enforced: true,
    allowed: decision.decision === "allow",
    ...(decision.decision === "allow" ? {} : { reason: decision.reason }),
  };
}

/** Production PDP deps from the Worker env (alias record + KV membership store). */
export function createAgentSchedulePdpDeps(env: Env): AgentSchedulePdpDeps {
  const store = sessionStore(env);
  return {
    env,
    isPdpEnabled,
    resolvePrincipalInternalUserId: (login: string) => lookupInternalUserIdByLogin(store, login),
    authorize: async (input) => {
      const membershipStore = createKvMembershipStore(store);
      const denialStore = createKvPermissionDenialStore(store);
      return authorize(
        membershipStore,
        {
          actorInternalUserId: input.actorInternalUserId,
          tenantId: input.tenantId,
          permission: input.permission,
          nowMs: input.nowMs,
        },
        denialStore,
      );
    },
  };
}

/** The resolved tenant for agent schedule actions (IAAA_TENANT_ID else "primary"). */
export function resolveAgentScheduleTenant(env: Env): string {
  return resolveIaaaTenant(env);
}

/* =====================================================================
 * Provenance
 * ===================================================================== */

/** Agent creation provenance: origin agent, principal login, acting agent id. */
export function agentScheduleProvenance(
  agentId: string,
  login: string,
  nowIso?: string,
): ScheduleProvenance & { agentId: string } {
  return {
    origin: "agent",
    createdBy: login,
    agentId,
    createdAt: nowIso ?? new Date().toISOString(),
  };
}

/* =====================================================================
 * Pending approvals (pure list helpers; storage is an injected port)
 * ===================================================================== */

export interface PendingScheduleApproval {
  id: string;
  kind: "sdk" | "goal" | "workflow-stage";
  requestedBy: string;
  agentId: string;
  requestedAt: string;
  /** The full definition needed to arm the schedule on approval. */
  definition: unknown;
  approvalReasons: string[];
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
}

export function recordPendingScheduleApproval(
  list: PendingScheduleApproval[],
  entry: PendingScheduleApproval,
): PendingScheduleApproval[] {
  if (list.some((item) => item.id === entry.id)) {
    throw new Error(`A pending approval with id '${entry.id}' already exists.`);
  }
  return [...list, entry];
}

export function resolvePendingScheduleApproval(
  list: PendingScheduleApproval[],
  id: string,
): PendingScheduleApproval | undefined {
  return list.find((item) => item.id === id);
}

export function decidePendingScheduleApproval(
  list: PendingScheduleApproval[],
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  decidedAt: string,
): PendingScheduleApproval[] {
  const idx = list.findIndex((item) => item.id === id);
  if (idx < 0) throw new Error(`No pending approval with id '${id}'.`);
  const current = list[idx];
  if (current.status !== "pending") {
    throw new Error(`Pending approval '${id}' is already decided (${current.status}).`);
  }
  const next = [...list];
  next[idx] = { ...current, status: decision, decidedBy, decidedAt };
  return next;
}

/* =====================================================================
 * Executor (port-injected; one capability, three store adapters)
 * ===================================================================== */

export type AgentSdkTiming =
  | { type: "cron"; cron: string }
  | { type: "interval"; intervalSeconds: number }
  | { type: "scheduled"; time: number }
  | { type: "delayed"; delayInSeconds: number };

export interface AgentSdkScheduleAdapter {
  list(): Promise<AgentScheduleItem[]>;
  get(id: string): Promise<AgentScheduleItem | undefined>;
  create(input: { timing: AgentSdkTiming; callback: string; payload?: unknown }): Promise<AgentScheduleItem>;
  cancel(id: string): Promise<boolean>;
  /** Full adapters (orchestrator A2A) implement these; the NLQ port adapter does not. */
  pause?(id: string): Promise<AgentScheduleItem>;
  resume?(id: string): Promise<AgentScheduleItem>;
  trigger?(id: string): Promise<unknown>;
  update?(id: string, input: { timing?: AgentSdkTiming; payload?: unknown }): Promise<AgentScheduleItem>;
}

export interface AgentGoalScheduleAdapter {
  list(): Promise<Array<Record<string, unknown>>>;
  add(goal: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  trigger(id: string): Promise<unknown>;
}

/**
 * The stages adapter (#3310): the unified-store record for one
 * pipeline job stage, armed through the SDK alarm substrate with the
 * internal-only `runWorkflowStage` callback. Implemented by
 * `createWorkflowStageScheduleAdapter` (src/services/workflowStageSchedule.ts)
 * over the one management service — no second management path.
 */
export interface AgentWorkflowStageScheduleAdapter {
  /** Resolve the stage against the registry; null when the job has none. */
  resolveStage(
    jobId: string,
    nodePath: string,
  ): Promise<ResolvedWorkflowStage | null>;
  list(): Promise<UnifiedScheduleRecord[]>;
  get(id: string): Promise<UnifiedScheduleRecord | undefined>;
  create(input: {
    jobId: string;
    nodePath: string;
    timing: AgentSdkTiming;
    reason?: string;
    ownerLogin?: string;
    provenance?: ScheduleProvenance;
  }): Promise<UnifiedScheduleRecord>;
  cancel(id: string): Promise<boolean>;
  pause?(id: string): Promise<UnifiedScheduleRecord>;
  resume?(id: string): Promise<UnifiedScheduleRecord>;
  trigger?(id: string): Promise<unknown>;
  update?(
    id: string,
    input: { timing?: AgentSdkTiming; reason?: string },
  ): Promise<UnifiedScheduleRecord>;
}

export interface AgentScheduleExecutorDeps {
  pdp: (input: AgentSchedulePdpInput) => Promise<AgentSchedulePdpOutcome>;
  config?: AgentScheduleApprovalConfig;
  nowMs: () => number;
  nowIso: () => string;
  recordLedger: (record: JobRunRecord) => void | Promise<void>;
  audit: (type: string, payload: Record<string, unknown>) => void;
  pendingApprovals: {
    load(): Promise<PendingScheduleApproval[]>;
    save(list: PendingScheduleApproval[]): Promise<void>;
  };
  stores: {
    sdk?: AgentSdkScheduleAdapter;
    goals?: AgentGoalScheduleAdapter;
    stages?: AgentWorkflowStageScheduleAdapter;
  };
}

export type AgentScheduleActionRequest =
  | {
      action: "create";
      kind: "sdk";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      callback: string;
      timing: AgentSdkTiming;
      payload?: unknown;
      budgetCents?: number;
      isExternalSend?: boolean;
      /**
       * Set ONLY by the approve endpoint: the id of the pending approval
       * authorizing this arming. The executor verifies the record
       * exists and skips the gate; the endpoint owns the decision and
       * marks the approval approved after a successful arm.
       */
      approvedPendingId?: string;
    }
  | {
      action: "create";
      kind: "goal";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      operation: string;
      goal: Record<string, unknown>;
      /** As above (sdk create). */
      approvedPendingId?: string;
    }
  | {
      action: "create";
      kind: "workflow-stage";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      jobId: string;
      nodePath: string;
      timing: AgentSdkTiming;
      reason?: string;
      budgetCents?: number;
      isExternalSend?: boolean;
      /** As on create (sdk): the approve endpoint's gate-skip token. */
      approvedPendingId?: string;
    }
  | {
      action: "list";
      kind: "sdk" | "goal" | "workflow-stage";
      principal: AgentSchedulePrincipal;
      tenantId: string;
    }
  | {
      action: "update";
      kind: "sdk";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      scheduleId: string;
      timing?: AgentSdkTiming;
      payload?: unknown;
      /** As on create: the approve endpoint's gate-skip token. */
      approvedPendingId?: string;
    }
  | {
      action: "update";
      kind: "goal";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      scheduleId: string;
      goal: Record<string, unknown>;
      /** As on create: the approve endpoint's gate-skip token. */
      approvedPendingId?: string;
    }
  | {
      action: "update";
      kind: "workflow-stage";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      scheduleId: string;
      timing?: AgentSdkTiming;
      reason?: string;
      /** As on create: the approve endpoint's gate-skip token. */
      approvedPendingId?: string;
    }
  | {
      action: "pause" | "resume" | "trigger" | "delete";
      kind: "sdk" | "goal" | "workflow-stage";
      principal: AgentSchedulePrincipal;
      tenantId: string;
      scheduleId: string;
    };

export type AgentScheduleActionResult =
  | { ok: true; scheduleId?: string; schedule?: unknown; pendingApprovalId?: string }
  | {
      ok: false;
      code: "denied" | "approval-required" | "not-found" | "unsupported" | "error";
      reason: string;
      pendingApprovalId?: string;
    };

function ledgerSystem(kind: "sdk" | "goal" | "workflow-stage"): "orchestrator-schedule" | "scheduled-agent-goal" {
  return kind === "goal" ? "scheduled-agent-goal" : "orchestrator-schedule";
}

function auditEventFor(action: AgentScheduleAction): string | null {
  switch (action) {
    case "create":
      return "schedule.created";
    case "update":
      return "schedule.updated";
    case "pause":
      return "schedule.paused";
    case "resume":
      return "schedule.resumed";
    case "trigger":
      return "schedule.triggered";
    case "delete":
      return "schedule.cancelled";
    default:
      return null;
  }
}

function ownerOfSdkSchedule(item: AgentScheduleItem): string | undefined {
  const payload = (item as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  const provenance = (payload as Record<string, unknown>).provenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const createdBy = (provenance as Record<string, unknown>).createdBy;
  return typeof createdBy === "string" && createdBy.trim() ? createdBy : undefined;
}

function ownerOfGoal(goal: Record<string, unknown>): string | undefined {
  const provenance = goal.provenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const createdBy = (provenance as Record<string, unknown>).createdBy;
  return typeof createdBy === "string" && createdBy.trim() ? createdBy : undefined;
}

function ownerOfStageSchedule(record: UnifiedScheduleRecord): string | undefined {
  if (typeof record.ownerLogin === "string" && record.ownerLogin.trim()) return record.ownerLogin;
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const createdBy = (provenance as Record<string, unknown>).createdBy;
  return typeof createdBy === "string" && createdBy.trim() ? createdBy : undefined;
}

function timingOfStageSchedule(record: UnifiedScheduleRecord): AgentSdkTiming | undefined {
  const def = record.definition as Record<string, unknown>;
  if (def.type === "cron" && typeof def.cron === "string") return { type: "cron", cron: def.cron };
  if (def.type === "interval" && typeof def.intervalSeconds === "number") {
    return { type: "interval", intervalSeconds: def.intervalSeconds };
  }
  if (def.type === "scheduled" && typeof def.time === "number") return { type: "scheduled", time: def.time };
  if (def.type === "delayed" && typeof def.delayInSeconds === "number") {
    return { type: "delayed", delayInSeconds: def.delayInSeconds };
  }
  return undefined;
}

function timingOfSdkSchedule(item: AgentScheduleItem): AgentSdkTiming | undefined {
  const s = item as AgentScheduleItem & { cron?: string; intervalSeconds?: number; time?: number };
  if (s.type === "cron" && s.cron) return { type: "cron", cron: s.cron };
  if (s.type === "interval" && s.intervalSeconds) return { type: "interval", intervalSeconds: s.intervalSeconds };
  if (s.type === "scheduled" && s.time !== undefined) return { type: "scheduled", time: s.time };
  if (s.type === "delayed" && s.delayInSeconds !== undefined) {
    return { type: "delayed", delayInSeconds: s.delayInSeconds };
  }
  return undefined;
}

/**
 * Execute one agent schedule action. Order: classify → PDP → ownership →
 * approval gate → store. Every outcome (allowed or refused) writes a
 * consolidated run-ledger row with agent identity / tenant / schedule;
 * denials and approval requirements also emit an `agent.schedule.*`
 * audit event. Goal successes emit no `ctx.audit` event here — the
 * mutation funnel owns the `schedule.goal.*` lifecycle events (#3312).
 */
export async function executeAgentScheduleAction(
  deps: AgentScheduleExecutorDeps,
  request: AgentScheduleActionRequest,
): Promise<AgentScheduleActionResult> {
  const { principal, tenantId, action, kind } = request as {
    principal: AgentSchedulePrincipal;
    tenantId: string;
    action: AgentScheduleAction;
    kind: "sdk" | "goal" | "workflow-stage";
  };
  const nowMs = deps.nowMs();
  const nowIso = deps.nowIso();
  const system = ledgerSystem(kind);

  const recordOutcome = async (
    outcome: "success" | "failure" | "skipped",
    scheduleId: string | null,
    detail: string,
    error?: string,
  ): Promise<void> => {
    const started = nowIso;
    await deps.recordLedger(
      buildJobRunRecord({
        system,
        jobId: `agent-schedule-action-${crypto.randomUUID()}`,
        operation: `agent.schedule.${action}`,
        started,
        finished: started,
        outcome,
        triggeredBy: "manual",
        scheduleId,
        asyncJobId: null,
        workflowId: null,
        detail,
        ...(error !== undefined ? { error } : {}),
      }),
    );
  };

  const deny = async (
    reason: string,
    scheduleId: string | null,
  ): Promise<AgentScheduleActionResult> => {
    await recordOutcome("skipped", scheduleId, `agent ${principal.agentId} (${principal.login}) denied: ${reason}`);
    deps.audit("agent.schedule.denied", {
      action,
      kind,
      tenantId,
      agentId: principal.agentId,
      principal: principal.login,
      scheduleId,
      reason,
    });
    return { ok: false, code: "denied", reason };
  };

  try {
    // --- Load the target for non-create actions (existence + ownership + classification inputs).
    let targetSdk: AgentScheduleItem | undefined;
    let targetGoal: Record<string, unknown> | undefined;
    let targetStage: UnifiedScheduleRecord | undefined;
    if (action !== "create" && action !== "list") {
      const scheduleId = (request as { scheduleId: string }).scheduleId;
      if (kind === "sdk") {
        if (!deps.stores.sdk) return deny("No SDK schedule store is available on this channel.", scheduleId);
        targetSdk = await deps.stores.sdk.get(scheduleId);
        if (!targetSdk) {
          await recordOutcome("skipped", scheduleId, `agent ${principal.agentId} (${principal.login}): schedule not found`);
          return { ok: false, code: "not-found", reason: `Schedule '${scheduleId}' was not found.` };
        }
      } else if (kind === "workflow-stage") {
        if (!deps.stores.stages) return deny("No stage schedule store is available on this channel.", scheduleId);
        targetStage = await deps.stores.stages.get(scheduleId);
        if (!targetStage) {
          await recordOutcome("skipped", scheduleId, `agent ${principal.agentId} (${principal.login}): stage-schedule not found`);
          return { ok: false, code: "not-found", reason: `Stage-schedule '${scheduleId}' was not found.` };
        }
      } else {
        if (!deps.stores.goals) return deny("No goal schedule store is available on this channel.", scheduleId);
        const goals = await deps.stores.goals.list();
        targetGoal = goals.find((goal) => goal.id === scheduleId);
        if (!targetGoal) {
          await recordOutcome("skipped", scheduleId, `agent ${principal.agentId} (${principal.login}): goal not found`);
          return { ok: false, code: "not-found", reason: `Goal '${scheduleId}' was not found.` };
        }
      }
    }

    // --- Classify (from the request for create, from the target otherwise).
    let classification: AgentScheduleClassification;
    if (request.action === "create" && request.kind === "sdk") {
      const timing = request.timing;
      classification = classifyAgentScheduleRequest(
        {
          kind: "sdk-callback",
          callback: request.callback,
          budgetCents: request.budgetCents,
          intervalSeconds: timing.type === "interval" ? timing.intervalSeconds : undefined,
          cron: timing.type === "cron" ? timing.cron : undefined,
          isExternalSend: request.isExternalSend,
        },
        deps.config,
      );
    } else if (request.action === "create" && request.kind === "workflow-stage") {
      // The stage must exist (and not be retired) before classification:
      // the classifier's external-send class is derived from the node,
      // never guessed from the request.
      if (!deps.stores.stages) return deny("No stage schedule store is available on this channel.", null);
      let stage: Awaited<ReturnType<NonNullable<typeof deps.stores.stages.resolveStage>>> | null;
      try {
        stage = await deps.stores.stages.resolveStage(request.jobId, request.nodePath);
      } catch (err) {
        return deny(err instanceof Error ? err.message : String(err), null);
      }
      if (!stage) {
        return deny(`Job '${request.jobId}' has no stage registry; nothing was scheduled.`, null);
      }
      const timing = request.timing;
      classification = classifyAgentScheduleRequest(
        {
          kind: "workflow-stage",
          jobId: request.jobId,
          nodePath: request.nodePath,
          budgetCents: request.budgetCents,
          intervalSeconds: timing.type === "interval" ? timing.intervalSeconds : undefined,
          cron: timing.type === "cron" ? timing.cron : undefined,
          isExternalSend:
            request.isExternalSend === true ||
            isExternalSendStage(stage.node as unknown as JobNodeConfig),
        },
        deps.config,
      );
    } else if (request.action === "create" && request.kind === "goal") {
      const goal = request.goal as { operation?: unknown; budgetCents?: number };
      classification = classifyAgentScheduleRequest(
        { kind: "goal-operation", operation: typeof goal.operation === "string" ? goal.operation : undefined, budgetCents: goal.budgetCents },
        deps.config,
      );
    } else if (request.action === "update" && request.kind === "workflow-stage") {
      // The REQUEST's timing is what will arm (falling back to the
      // target's); the external-send class comes from the target's
      // stage, resolved against the registry.
      const updateReq = request as Extract<AgentScheduleActionRequest, { action: "update"; kind: "workflow-stage" }>;
      const timing = updateReq.timing ?? (targetStage ? timingOfStageSchedule(targetStage) : undefined);
      let isExternalSend: boolean | undefined;
      if (targetStage && deps.stores.stages) {
        const def = targetStage.definition as Record<string, unknown>;
        const jobId = typeof def.jobId === "string" ? def.jobId : "";
        const nodePath = typeof def.nodePath === "string" ? def.nodePath : "";
        try {
          const stage = await deps.stores.stages.resolveStage(jobId, nodePath);
          if (stage) isExternalSend = isExternalSendStage(stage.node as unknown as JobNodeConfig);
        } catch (err) {
          return deny(err instanceof Error ? err.message : String(err), updateReq.scheduleId);
        }
      }
      const def = targetStage ? (targetStage.definition as Record<string, unknown>) : {};
      classification = classifyAgentScheduleRequest(
        {
          kind: "workflow-stage",
          jobId: typeof def.jobId === "string" ? def.jobId : "",
          nodePath: typeof def.nodePath === "string" ? def.nodePath : "",
          intervalSeconds: timing?.type === "interval" ? timing.intervalSeconds : undefined,
          cron: timing?.type === "cron" ? timing.cron : undefined,
          isExternalSend,
        },
        deps.config,
      );
    } else if (request.action === "update" && request.kind === "goal") {
      const goal = request.goal as { operation?: unknown; budgetCents?: number };
      classification = classifyAgentScheduleRequest(
        { kind: "goal-operation", operation: typeof goal.operation === "string" ? goal.operation : undefined, budgetCents: goal.budgetCents },
        deps.config,
      );
    } else if (request.action === "update" && request.kind === "sdk") {
      // The REQUEST's timing is what will arm: an update that tightens
      // the interval (or moves to a fast cron) is classified on the new
      // timing, falling back to the target's when the update keeps it.
      const updateReq = request as Extract<AgentScheduleActionRequest, { action: "update"; kind: "sdk" }>;
      const timing = updateReq.timing ?? (targetSdk ? timingOfSdkSchedule(targetSdk) : undefined);
      classification = classifyAgentScheduleRequest(
        {
          kind: "sdk-callback",
          callback: targetSdk ? targetSdk.callback : "",
          intervalSeconds: timing?.type === "interval" ? timing.intervalSeconds : undefined,
          cron: timing?.type === "cron" ? timing.cron : undefined,
        },
        deps.config,
      );
    } else if (kind === "sdk" && targetSdk) {
      const timing = timingOfSdkSchedule(targetSdk);
      classification = classifyAgentScheduleRequest(
        {
          kind: "sdk-callback",
          callback: targetSdk.callback,
          intervalSeconds: timing?.type === "interval" ? timing.intervalSeconds : undefined,
          cron: timing?.type === "cron" ? timing.cron : undefined,
        },
        deps.config,
      );
    } else if (kind === "workflow-stage" && targetStage) {
      const timing = timingOfStageSchedule(targetStage);
      let isExternalSend: boolean | undefined;
      if (deps.stores.stages) {
        const def = targetStage.definition as Record<string, unknown>;
        const jobId = typeof def.jobId === "string" ? def.jobId : "";
        const nodePath = typeof def.nodePath === "string" ? def.nodePath : "";
        try {
          const stage = await deps.stores.stages.resolveStage(jobId, nodePath);
          if (stage) isExternalSend = isExternalSendStage(stage.node as unknown as JobNodeConfig);
        } catch (err) {
          // A stage that can no longer run (retired) still allows
          // housekeeping — pause and delete — but never a re-arm
          // (resume) or a firing (trigger).
          if (action === "trigger" || action === "resume") {
            return deny(err instanceof Error ? err.message : String(err), targetStage.id);
          }
        }
      }
      const def = targetStage.definition as Record<string, unknown>;
      classification = classifyAgentScheduleRequest(
        {
          kind: "workflow-stage",
          jobId: typeof def.jobId === "string" ? def.jobId : "",
          nodePath: typeof def.nodePath === "string" ? def.nodePath : "",
          intervalSeconds: timing?.type === "interval" ? timing.intervalSeconds : undefined,
          cron: timing?.type === "cron" ? timing.cron : undefined,
          isExternalSend,
        },
        deps.config,
      );
    } else if (kind === "goal" && targetGoal) {
      classification = classifyAgentScheduleRequest(
        {
          kind: "goal-operation",
          operation: typeof targetGoal.operation === "string" ? targetGoal.operation : undefined,
          budgetCents: typeof targetGoal.budgetCents === "number" ? targetGoal.budgetCents : undefined,
        },
        deps.config,
      );
    } else {
      // list: no classification needed (read-only).
      classification = { schedulable: true, requiresApproval: false, approvalReasons: [] };
    }
    if (!classification.schedulable) {
      const scheduleId =
        action !== "create" && action !== "list" ? (request as { scheduleId: string }).scheduleId : null;
      return deny(classification.denialReason, scheduleId);
    }

    // --- PDP.
    const pdp = await deps.pdp({ principal, tenantId, action, nowMs });
    if (pdp.enforced && !pdp.allowed) {
      const scheduleId =
        action !== "create" && action !== "list" ? (request as { scheduleId: string }).scheduleId : null;
      return deny(`PDP denied ${AGENT_SCHEDULE_ACTION_PERMISSIONS[action]}${pdp.reason ? `: ${pdp.reason}` : ""}`, scheduleId);
    }

    // --- Ownership (per-login instance = tenant scope, F4).
    if (action !== "create" && action !== "list") {
      const scheduleId = (request as { scheduleId: string }).scheduleId;
      const owner =
        kind === "sdk" && targetSdk
          ? ownerOfSdkSchedule(targetSdk)
          : kind === "workflow-stage" && targetStage
            ? ownerOfStageSchedule(targetStage)
            : kind === "goal" && targetGoal
              ? ownerOfGoal(targetGoal)
              : undefined;
      if (owner !== undefined && owner !== principal.login) {
        return deny(`Schedule '${scheduleId}' belongs to '${owner}', not to '${principal.login}'.`, scheduleId);
      }
    }

    // --- Approval gate (create + update only: arming work). An
    // approvedPendingId skips the gate: the approve endpoint verified
    // the decision and marks the approval approved after arming.
    if (
      classification.schedulable &&
      classification.requiresApproval &&
      (AGENT_SCHEDULE_APPROVAL_GATED_ACTIONS as readonly string[]).includes(action)
    ) {
      const approvedPendingId =
        request.action === "create" || request.action === "update"
          ? (request as { approvedPendingId?: string }).approvedPendingId
          : undefined;
      if (approvedPendingId) {
        const pending = await deps.pendingApprovals.load();
        if (!resolvePendingScheduleApproval(pending, approvedPendingId)) {
          return {
            ok: false,
            code: "error",
            reason: `Approved pending approval '${approvedPendingId}' was not found; the schedule was not armed.`,
          };
        }
      } else {
        const pendingId = `pending-${crypto.randomUUID()}`;
        const definition =
          request.action === "create" && request.kind === "sdk"
            ? { callback: request.callback, timing: request.timing, payload: request.payload }
            : request.action === "create" && request.kind === "workflow-stage"
              ? { jobId: request.jobId, nodePath: request.nodePath, timing: request.timing, reason: request.reason }
              : request.action === "create" && request.kind === "goal"
                ? { goal: request.goal }
                : request.action === "update" && request.kind === "sdk"
                  ? { scheduleId: request.scheduleId, timing: request.timing, payload: request.payload }
                  : request.action === "update" && request.kind === "workflow-stage"
                    ? { scheduleId: request.scheduleId, timing: request.timing, reason: request.reason }
                    : { scheduleId: (request as { scheduleId: string }).scheduleId, goal: (request as { goal: unknown }).goal };
        const pending = await deps.pendingApprovals.load();
        await deps.pendingApprovals.save(
          recordPendingScheduleApproval(pending, {
            id: pendingId,
            kind,
            requestedBy: principal.login,
            agentId: principal.agentId,
            requestedAt: nowIso,
            definition,
            approvalReasons: classification.approvalReasons,
            status: "pending",
          }),
        );
        await recordOutcome(
          "skipped",
          action !== "create" && action !== "list" ? (request as { scheduleId: string }).scheduleId : null,
          `agent ${principal.agentId} (${principal.login}): approval required — ${classification.approvalReasons.join("; ")}`,
        );
        deps.audit("agent.schedule.approval-required", {
          action,
          kind,
          tenantId,
          agentId: principal.agentId,
          principal: principal.login,
          pendingApprovalId: pendingId,
          approvalReasons: classification.approvalReasons,
        });
        return {
          ok: false,
          code: "approval-required",
          reason: `Approval required before arming: ${classification.approvalReasons.join("; ")}`,
          pendingApprovalId: pendingId,
        };
      }
    }

    // --- Execute via the store adapter.
    const provenance = agentScheduleProvenance(principal.agentId, principal.login, nowIso);
    if (request.action === "list") {
      const items =
        kind === "sdk"
          ? deps.stores.sdk
            ? await deps.stores.sdk.list()
            : []
          : kind === "workflow-stage"
            ? deps.stores.stages
              ? await deps.stores.stages.list()
              : []
            : deps.stores.goals
              ? await deps.stores.goals.list()
              : [];
      await recordOutcome("success", null, `agent ${principal.agentId} (${principal.login}) listed ${items.length} ${kind} schedule(s)`);
      return { ok: true, schedule: items };
    }
    if (request.action === "create" && request.kind === "workflow-stage") {
      if (!deps.stores.stages) return deny("No stage schedule store is available on this channel.", null);
      const created = await deps.stores.stages.create({
        jobId: request.jobId,
        nodePath: request.nodePath,
        timing: request.timing,
        reason: request.reason,
        ownerLogin: principal.login,
        provenance,
      });
      const def = created.definition as Record<string, unknown>;
      await recordOutcome("success", created.id, `agent ${principal.agentId} (${principal.login}) created stage-schedule ${created.id} (${request.jobId} ${String(def.stageId ?? request.nodePath)})`);
      const event = auditEventFor(action);
      if (event) {
        deps.audit(event, {
          scheduleId: created.id,
          jobId: request.jobId,
          nodePath: request.nodePath,
          stageId: def.stageId,
          agentId: principal.agentId,
          principal: principal.login,
          origin: "agent",
        });
      }
      return { ok: true, scheduleId: created.id, schedule: created };
    }
    if (request.action === "create" && request.kind === "sdk") {
      if (!deps.stores.sdk) return deny("No SDK schedule store is available on this channel.", null);
      const payload =
        request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
          ? { ...(request.payload as Record<string, unknown>), provenance }
          : { provenance };
      const created = await deps.stores.sdk.create({ timing: request.timing, callback: request.callback, payload });
      await recordOutcome("success", created.id, `agent ${principal.agentId} (${principal.login}) created schedule ${created.id}`);
      const event = auditEventFor(action);
      if (event) deps.audit(event, { scheduleId: created.id, callback: created.callback, agentId: principal.agentId, principal: principal.login, origin: "agent" });
      return { ok: true, scheduleId: created.id, schedule: created };
    }
    if (request.action === "create" && request.kind === "goal") {
      if (!deps.stores.goals) return deny("No goal schedule store is available on this channel.", null);
      const goal = { ...(request.goal as Record<string, unknown>), provenance };
      const created = await deps.stores.goals.add(goal);
      const createdId = typeof created.id === "string" ? created.id : String((request.goal as Record<string, unknown>).id ?? "");
      await recordOutcome("success", createdId, `agent ${principal.agentId} (${principal.login}) created goal ${createdId}`);
      return { ok: true, scheduleId: createdId, schedule: created };
    }
    const scheduleId = (request as { scheduleId: string }).scheduleId;
    if (kind === "sdk") {
      const sdk = deps.stores.sdk;
      if (!sdk) return deny("No SDK schedule store is available on this channel.", scheduleId);
      if (request.action === "delete") {
        const cancelled = await sdk.cancel(scheduleId);
        if (!cancelled) return { ok: false, code: "not-found", reason: `Schedule '${scheduleId}' was not found.` };
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) deleted schedule ${scheduleId}`);
        deps.audit("schedule.cancelled", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId };
      }
      if (request.action === "pause") {
        if (!sdk.pause) return { ok: false, code: "unsupported", reason: "Pause is not supported on this channel." };
        const paused = await sdk.pause(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) paused schedule ${scheduleId}`);
        deps.audit("schedule.paused", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId, schedule: paused };
      }
      if (request.action === "resume") {
        if (!sdk.resume) return { ok: false, code: "unsupported", reason: "Resume is not supported on this channel." };
        const resumed = await sdk.resume(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) resumed schedule ${scheduleId}`);
        deps.audit("schedule.resumed", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId, schedule: resumed };
      }
      if (request.action === "trigger") {
        if (!sdk.trigger) return { ok: false, code: "unsupported", reason: "Trigger is not supported on this channel." };
        await sdk.trigger(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) triggered schedule ${scheduleId}`);
        deps.audit("schedule.triggered", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId };
      }
      // update (sdk): cancel + recreate via the adapter's update when present, else cancel + create.
      if (request.action === "update") {
        const updateReq = request as Extract<AgentScheduleActionRequest, { action: "update"; kind: "sdk" }>;
        if (sdk.update) {
          const updated = await sdk.update(scheduleId, { timing: updateReq.timing, payload: updateReq.payload });
          await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) updated schedule ${scheduleId}`);
          deps.audit("schedule.updated", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
          return { ok: true, scheduleId, schedule: updated };
        }
        const timing = updateReq.timing ?? timingOfSdkSchedule(targetSdk as AgentScheduleItem);
        if (!timing || !targetSdk) return { ok: false, code: "error", reason: "Cannot determine the schedule's current timing to update it." };
        await sdk.cancel(scheduleId);
        const payload =
          updateReq.payload && typeof updateReq.payload === "object" && !Array.isArray(updateReq.payload)
            ? { ...(updateReq.payload as Record<string, unknown>), provenance }
            : { ...(targetSdk.payload as Record<string, unknown> | undefined), provenance };
        const created = await sdk.create({ timing, callback: targetSdk.callback, payload });
        await recordOutcome("success", created.id, `agent ${principal.agentId} (${principal.login}) updated schedule ${scheduleId} (recreated as ${created.id})`);
        deps.audit("schedule.updated", { scheduleId, newScheduleId: created.id, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId: created.id, schedule: created };
      }
    } else if (kind === "workflow-stage") {
      const stages = deps.stores.stages;
      if (!stages) return deny("No stage schedule store is available on this channel.", scheduleId);
      if (request.action === "delete") {
        const cancelled = await stages.cancel(scheduleId);
        if (!cancelled) return { ok: false, code: "not-found", reason: `Stage-schedule '${scheduleId}' was not found.` };
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) deleted stage-schedule ${scheduleId}`);
        deps.audit("schedule.cancelled", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId };
      }
      if (request.action === "pause") {
        if (!stages.pause) return { ok: false, code: "unsupported", reason: "Pause is not supported on this channel." };
        const paused = await stages.pause(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) paused stage-schedule ${scheduleId}`);
        deps.audit("schedule.paused", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId, schedule: paused };
      }
      if (request.action === "resume") {
        if (!stages.resume) return { ok: false, code: "unsupported", reason: "Resume is not supported on this channel." };
        const resumed = await stages.resume(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) resumed stage-schedule ${scheduleId}`);
        deps.audit("schedule.resumed", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId, schedule: resumed };
      }
      if (request.action === "trigger") {
        if (!stages.trigger) return { ok: false, code: "unsupported", reason: "Trigger is not supported on this channel." };
        await stages.trigger(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) triggered stage-schedule ${scheduleId}`);
        deps.audit("schedule.triggered", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId };
      }
      // update (workflow-stage): re-time through the management service (same record id).
      if (request.action === "update") {
        if (!stages.update) return { ok: false, code: "unsupported", reason: "Update is not supported on this channel." };
        const updateReq = request as Extract<AgentScheduleActionRequest, { action: "update"; kind: "workflow-stage" }>;
        const updated = await stages.update(scheduleId, { timing: updateReq.timing, reason: updateReq.reason });
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) updated stage-schedule ${scheduleId}`);
        deps.audit("schedule.updated", { scheduleId, agentId: principal.agentId, principal: principal.login, origin: "agent" });
        return { ok: true, scheduleId, schedule: updated };
      }
    } else {
      const goals = deps.stores.goals;
      if (!goals) return deny("No goal schedule store is available on this channel.", scheduleId);
      if (request.action === "delete") {
        const removed = await goals.remove(scheduleId);
        if (!removed) return { ok: false, code: "not-found", reason: `Goal '${scheduleId}' was not found.` };
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) deleted goal ${scheduleId}`);
        return { ok: true, scheduleId };
      }
      if (request.action === "pause") {
        const ok = await goals.setEnabled(scheduleId, false);
        if (!ok) return { ok: false, code: "not-found", reason: `Goal '${scheduleId}' was not found.` };
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) paused goal ${scheduleId}`);
        return { ok: true, scheduleId };
      }
      if (request.action === "resume") {
        const ok = await goals.setEnabled(scheduleId, true);
        if (!ok) return { ok: false, code: "not-found", reason: `Goal '${scheduleId}' was not found.` };
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) resumed goal ${scheduleId}`);
        return { ok: true, scheduleId };
      }
      if (request.action === "trigger") {
        await goals.trigger(scheduleId);
        await recordOutcome("success", scheduleId, `agent ${principal.agentId} (${principal.login}) triggered goal ${scheduleId}`);
        return { ok: true, scheduleId };
      }
      // update (goal): remove + re-add under the same id (cancel+recreate, #273 shape).
      if (request.action === "update") {
        const updateReq = request as Extract<AgentScheduleActionRequest, { action: "update"; kind: "goal" }>;
        await goals.remove(scheduleId);
        const goal = { ...(updateReq.goal as Record<string, unknown>), provenance };
        const created = await goals.add(goal);
        const createdId = typeof created.id === "string" ? created.id : scheduleId;
        await recordOutcome("success", createdId, `agent ${principal.agentId} (${principal.login}) updated goal ${scheduleId}`);
        return { ok: true, scheduleId: createdId, schedule: created };
      }
    }
    return { ok: false, code: "error", reason: `Action '${action}' on kind '${kind}' is not implemented.` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await recordOutcome(
        "failure",
        request.action !== "create" && request.action !== "list"
          ? (request as { scheduleId: string }).scheduleId
          : null,
        `agent ${principal.agentId} (${principal.login}) action failed`,
        reason,
      );
    } catch {
      // The failure row itself failed to record; the error still surfaces.
    }
    return { ok: false, code: "error", reason };
  }
}

/* =====================================================================
 * DO binding helpers (one factory; each DO binds its own stores)
 * ===================================================================== */

/**
 * Issue #3122 (store integration, #3123) — adopt an armed SDK alarm
 * into the unified store. The #3123 T2-route precedent (adoptRecord
 * in routes/schedules.ts): the record id is the SDK alarm id;
 * insert-if-absent (never clobber an existing record — an idempotent
 * re-arm must not reset createdAt); best-effort (a failed record
 * write must not fail the creation — the alarm is armed either way,
 * and the schedule adopts a record when it is next touched).
 * ownerLogin comes from the payload's provenance.createdBy (stamped
 * by the executor) and is never invented (F4).
 */
export async function adoptAgentSdkScheduleRecord(
  store: UnifiedStoreLike | undefined,
  armed: AgentScheduleItem,
  nowIso: string,
): Promise<void> {
  if (!store) return;
  try {
    const existing = await store.get(armed.id);
    if (existing) return;
    const owner = ownerOfSdkSchedule(armed);
    await store.save(screenScheduleToRecord(armed, nowIso, owner ?? null));
  } catch {
    // Best-effort: the alarm is armed either way.
  }
}

/**
 * Issue #3122 (store integration, #3123) — remove a cancelled SDK
 * alarm's unified record. Best-effort like the adoption: a failed
 * removal must not fail the cancellation (the alarm is cancelled
 * either way; a stale record is adopted over when next touched).
 */
export async function removeAgentSdkScheduleRecord(
  store: UnifiedStoreLike | undefined,
  id: string,
): Promise<void> {
  if (!store) return;
  try {
    await store.remove(id);
  } catch {
    // Best-effort: the alarm is cancelled either way.
  }
}

/**
 * Adapt the NLQ scheduling port to the capability's SDK adapter. The
 * port implements only create/list/cancel — pause/resume/trigger/update
 * are absent, so the executor returns `unsupported` for those actions
 * on this channel (never a silent no-op). When a unified store is
 * supplied, each armed alarm is adopted into it (record id = alarm
 * id) and each cancellation removes its record, so capability-created
 * schedules live in the one store (#3123) instead of beside it.
 */
export function nlqPortToAgentSdkAdapter(
  port: NLQSchedulingPort,
  store?: UnifiedStoreLike,
): AgentSdkScheduleAdapter {
  return {
    list: () => port.listSchedules(),
    get: async (id) => (await port.listSchedules()).find((item) => item.id === id),
    create: async ({ timing, callback, payload }) => {
      let armed: AgentScheduleItem;
      if (timing.type === "interval") {
        armed = await port.scheduleEvery(timing.intervalSeconds, callback, payload);
      } else if (timing.type === "cron") {
        armed = await port.schedule(timing.cron, callback, payload, { idempotent: true });
      } else if (timing.type === "scheduled") {
        armed = await port.schedule(new Date(timing.time * 1000), callback, payload);
      } else {
        armed = await port.schedule(timing.delayInSeconds, callback, payload);
      }
      await adoptAgentSdkScheduleRecord(store, armed, new Date().toISOString());
      return armed;
    },
    cancel: async (id) => {
      const cancelled = await port.cancelSchedule(id);
      if (cancelled) await removeAgentSdkScheduleRecord(store, id);
      return cancelled;
    },
  };
}

/**
 * Build the capability's executor deps for a DO from its Worker env,
 * its DO sql handle, and its audit sink. The caller supplies the store
 * adapters (SDK over the NLQ port, goals over the ScheduledAgent) —
 * this factory wires the shared parts (PDP, thresholds, ledger,
 * pending approvals) identically on every channel, so no channel gets
 * a private enforcement path.
 */
export function createAgentScheduleExecutorDepsForDo(
  env: Env,
  sql: SqlStorage,
  audit: (type: string, payload: Record<string, unknown>) => void,
  stores: AgentScheduleExecutorDeps["stores"],
): AgentScheduleExecutorDeps {
  const pdpDeps = createAgentSchedulePdpDeps(env);
  const ledgerStore = new SqlJobRunRecordStore(sql);
  return {
    pdp: (input) => evaluateAgentSchedulePdp(pdpDeps, input),
    config: resolveEnvironmentConfig(env).agentSchedule,
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    recordLedger: (record) => {
      ledgerStore.record(record);
    },
    audit,
    pendingApprovals: createPendingScheduleApprovalPort(sql),
    stores,
  };
}
