import { describe, it, expect } from "vitest";
import { OPERATION_CATALOG } from "../src/orchestrate";
import {
  CREATABLE_SCHEDULE_CALLBACKS,
  INTERNAL_RECORDED_SCHEDULE_CALLBACKS,
} from "../src/agents/orchestrator/scheduleCallbacks";
import {
  AGENT_APPROVAL_BOUND_GOAL_OPERATIONS,
  AGENT_EXCLUDED_CALLBACKS,
  AGENT_EXCLUDED_GOAL_OPERATIONS,
  AGENT_SCHEDULABLE_CALLBACKS,
  AGENT_SCHEDULABLE_GOAL_OPERATIONS,
  AGENT_SCHEDULABLE_REMINDER_CALLBACK,
  AGENT_SCHEDULE_ACTION_PERMISSIONS,
  agentScheduleProvenance,
  classifyAgentScheduleRequest,
  decidePendingScheduleApproval,
  estimateCronMinGapMinutes,
  evaluateAgentSchedulePdp,
  executeAgentScheduleAction,
  isAgentSchedulableCallback,
  isAgentSchedulableGoalOperation,
  isNlqScheduleCallbackAllowed,
  recordPendingScheduleApproval,
  resolvePendingScheduleApproval,
  type AgentScheduleAction,
  type AgentScheduleApprovalConfig,
  type AgentSchedulePdpDeps,
  type PendingScheduleApproval,
} from "../src/services/agentScheduleCapability";

/**
 * #3122 pins (3122-P01..): the one agent-facing schedule-management
 * capability. The registry, the classifier, the F1 allow-list, the PDP
 * mapping, the approval binding, and the audit shape are pinned here;
 * the channel wiring (NLQ executor, A2A dispatches, approve endpoints)
 * is pinned in their own suites and calls this module, never a copy.
 */

const NO_CONFIG: AgentScheduleApprovalConfig = {};
const CONFIG: AgentScheduleApprovalConfig = {
  budgetCentsThreshold: 10_000,
  minIntervalSeconds: 3_600,
};

describe("3122-P01 registry accounting: every catalog operation declared exactly once", () => {
  it("covers every OPERATION_CATALOG operation exactly once across schedulable + excluded", () => {
    const catalogOps = OPERATION_CATALOG.flatMap((entry) => entry.operations);
    expect(new Set(catalogOps).size).toBe(catalogOps.length);
    const declared = new Map<string, string>();
    const note = (op: string, bucket: string) => {
      expect(declared.has(op), `operation ${op} declared twice`).toBe(false);
      declared.set(op, bucket);
    };
    for (const op of AGENT_SCHEDULABLE_GOAL_OPERATIONS) {
      if (op.endsWith(":*")) {
        const prefix = op.slice(0, -1);
        for (const catalogOp of catalogOps) {
          if (catalogOp.startsWith(prefix)) note(catalogOp, "schedulable");
        }
      } else {
        note(op, "schedulable");
      }
    }
    for (const entry of AGENT_EXCLUDED_GOAL_OPERATIONS) note(entry.operation, "excluded");
    for (const op of catalogOps) {
      expect(declared.has(op), `catalog operation ${op} is in neither set`).toBe(true);
    }
  });

  it("schedulable callbacks are exactly the creatable four; excluded callbacks are exactly the internal four plus system duties", () => {
    expect([...AGENT_SCHEDULABLE_CALLBACKS].sort()).toEqual(
      [...CREATABLE_SCHEDULE_CALLBACKS].sort(),
    );
    for (const cb of INTERNAL_RECORDED_SCHEDULE_CALLBACKS) {
      expect(AGENT_EXCLUDED_CALLBACKS).toContain(cb);
    }
    expect(AGENT_SCHEDULABLE_CALLBACKS).not.toContain("sendScheduledReminder");
    expect(AGENT_SCHEDULABLE_REMINDER_CALLBACK).toBe("sendScheduledReminder");
  });

  it("approval-bound goal operations are the external-send family only", () => {
    expect(AGENT_APPROVAL_BOUND_GOAL_OPERATIONS).toContain("social.publish");
    for (const op of AGENT_APPROVAL_BOUND_GOAL_OPERATIONS) {
      expect(isAgentSchedulableGoalOperation(op)).toBe(true);
    }
  });
});

describe("3122-P02..P09 classifier", () => {
  it("P02 plain screen callback is schedulable with no approval", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen" },
      CONFIG,
    );
    expect(out).toEqual({ schedulable: true, requiresApproval: false, approvalReasons: [] });
  });

  it("P03 internal-only callback is denied and names the callback", () => {
    for (const cb of ["autoRenewETradeTokens", "executeAsyncJob", "expireStaleOrderDraft", "collectIvHistory"]) {
      const out = classifyAgentScheduleRequest({ kind: "sdk-callback", callback: cb }, CONFIG);
      expect(out.schedulable).toBe(false);
      if (!out.schedulable) expect(out.denialReason).toContain(cb);
    }
  });

  it("P04 descriptor-only goal operation is denied and names F2", () => {
    for (const op of ["search.query", "qa.run_sweep", "trading.screen_stocks", "trading.trade_stock", "nlq.execute"]) {
      const out = classifyAgentScheduleRequest({ kind: "goal-operation", operation: op }, CONFIG);
      expect(out.schedulable).toBe(false);
      if (!out.schedulable) {
        expect(out.denialReason).toContain(op);
        expect(out.denialReason).toMatch(/descriptor-only|does not execute/i);
      }
    }
  });

  it("P05 social.publish is schedulable but approval-bound (external send)", () => {
    const out = classifyAgentScheduleRequest({ kind: "goal-operation", operation: "social.publish" }, CONFIG);
    expect(out.schedulable).toBe(true);
    if (out.schedulable) {
      expect(out.requiresApproval).toBe(true);
      expect(out.approvalReasons.join(" ")).toMatch(/external send/i);
    }
  });

  it("P06 spend above the threshold binds approval; at or below does not", () => {
    const over = classifyAgentScheduleRequest(
      { kind: "goal-operation", operation: "resource.rollup_daily", budgetCents: 10_001 },
      CONFIG,
    );
    expect(over.schedulable).toBe(true);
    if (over.schedulable) expect(over.requiresApproval).toBe(true);
    const at = classifyAgentScheduleRequest(
      { kind: "goal-operation", operation: "resource.rollup_daily", budgetCents: 10_000 },
      CONFIG,
    );
    if (at.schedulable) expect(at.requiresApproval).toBe(false);
  });

  it("P07 spend with no threshold configured is approval-bound (fail-closed)", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "goal-operation", operation: "resource.rollup_daily", budgetCents: 1 },
      NO_CONFIG,
    );
    expect(out.schedulable).toBe(true);
    if (out.schedulable) expect(out.requiresApproval).toBe(true);
  });

  it("P08 interval below the floor binds approval; at or above does not; no floor binds all", () => {
    const below = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", intervalSeconds: 1_800 },
      CONFIG,
    );
    if (below.schedulable) expect(below.requiresApproval).toBe(true);
    const at = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", intervalSeconds: 3_600 },
      CONFIG,
    );
    if (at.schedulable) expect(at.requiresApproval).toBe(false);
    const noFloor = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", intervalSeconds: 86_400 },
      NO_CONFIG,
    );
    if (noFloor.schedulable) expect(noFloor.requiresApproval).toBe(true);
  });

  it("P08b cron gap estimation: */30 fires every 30m; daily 0 9 fires every 1440m; unparsable is undefined", () => {
    expect(estimateCronMinGapMinutes("*/30 * * * *")).toBe(30);
    expect(estimateCronMinGapMinutes("0 9 * * 1-5")).toBe(1_440);
    expect(estimateCronMinGapMinutes("0 */6 * * *")).toBe(360);
    expect(estimateCronMinGapMinutes("not a cron")).toBeUndefined();
    const frequent = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", cron: "*/30 * * * *" },
      CONFIG,
    );
    if (frequent.schedulable) expect(frequent.requiresApproval).toBe(true);
    const daily = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", cron: "0 9 * * 1-5" },
      CONFIG,
    );
    if (daily.schedulable) expect(daily.requiresApproval).toBe(false);
  });

  it("P09 trading operation is denied outright (exclusion wins over approval-binding)", () => {
    const out = classifyAgentScheduleRequest({ kind: "goal-operation", operation: "trading.trade_stock" }, CONFIG);
    expect(out.schedulable).toBe(false);
  });

  it("P09b unknown callback and unknown operation are denied, never armed", () => {
    expect(classifyAgentScheduleRequest({ kind: "sdk-callback", callback: "noSuchCallback" }, CONFIG).schedulable).toBe(false);
    expect(classifyAgentScheduleRequest({ kind: "goal-operation", operation: "no.such_op" }, CONFIG).schedulable).toBe(false);
    expect(classifyAgentScheduleRequest({ kind: "sdk-callback" }, CONFIG).schedulable).toBe(false);
  });
});

describe("3122-P10 F1 NLQ allow-list", () => {
  it("allows the reminder and the four creatable callbacks, refuses everything else", () => {
    for (const cb of ["sendScheduledReminder", ...CREATABLE_SCHEDULE_CALLBACKS]) {
      expect(isNlqScheduleCallbackAllowed(cb)).toBe(true);
    }
    // The reminder is NLQ-only, not a creatable screen callback.
    expect(isAgentSchedulableCallback("sendScheduledReminder")).toBe(false);
    for (const cb of CREATABLE_SCHEDULE_CALLBACKS) {
      expect(isAgentSchedulableCallback(cb)).toBe(true);
    }
    for (const cb of [
      "autoRenewETradeTokens",
      "executeAsyncJob",
      "expireStaleOrderDraft",
      "collectIvHistory",
      "pushTicks",
      "sweepStaleLedgerTasks",
      "",
      undefined,
      null,
    ]) {
      expect(isNlqScheduleCallbackAllowed(cb)).toBe(false);
    }
  });
});

describe("3122-P11 PDP action-to-permission map", () => {
  it("covers all seven actions plus approve with existing permissions only", () => {
    const actions: AgentScheduleAction[] = ["create", "update", "pause", "resume", "trigger", "delete", "list", "approve"];
    for (const action of actions) {
      expect(AGENT_SCHEDULE_ACTION_PERMISSIONS[action]).toBeTruthy();
    }
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.create).toBe("task:create");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.update).toBe("task:create");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.list).toBe("task:read");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.pause).toBe("task:cancel");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.resume).toBe("task:cancel");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.delete).toBe("task:cancel");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.trigger).toBe("action:execute");
    expect(AGENT_SCHEDULE_ACTION_PERMISSIONS.approve).toBe("action:approve");
  });
});

describe("3122-P12 PDP evaluation", () => {
  const baseDeps = (overrides: Partial<AgentSchedulePdpDeps> = {}): AgentSchedulePdpDeps => ({
    env: { IAAA_PDP_ENABLED: "1" },
    isPdpEnabled: (env: unknown) =>
      (env as Record<string, unknown>)?.IAAA_PDP_ENABLED === "1",
    resolvePrincipalInternalUserId: async (login: string) =>
      login === "OpenAIMP" ? "user-1" : null,
    authorize: async ({ actorInternalUserId }: { actorInternalUserId: string }) => ({
      decision: (actorInternalUserId === "user-1" ? "allow" : "deny") as "allow" | "deny",
      reason: actorInternalUserId === "user-1" ? undefined : "NO_MEMBERSHIP",
    }),
    ...overrides,
  });

  it("allows a resolvable principal with membership", async () => {
    const out = await evaluateAgentSchedulePdp(baseDeps(), {
      principal: { login: "OpenAIMP", agentId: "agent-1" },
      tenantId: "primary",
      action: "create",
      nowMs: 1_700_000_000_000,
    });
    expect(out).toEqual({ enforced: true, allowed: true });
  });

  it("denies an unresolvable principal when PDP is on (fail-closed)", async () => {
    const out = await evaluateAgentSchedulePdp(baseDeps(), {
      principal: { login: "ghost-login", agentId: "agent-1" },
      tenantId: "primary",
      action: "create",
      nowMs: 1_700_000_000_000,
    });
    expect(out.enforced).toBe(true);
    if (out.enforced) expect(out.allowed).toBe(false);
  });

  it("denies a resolvable principal without membership", async () => {
    const deps = baseDeps({
      authorize: async () => ({ decision: "deny" as const, reason: "NO_MEMBERSHIP" }),
    });
    const out = await evaluateAgentSchedulePdp(deps, {
      principal: { login: "OpenAIMP", agentId: "agent-1" },
      tenantId: "primary",
      action: "create",
      nowMs: 1_700_000_000_000,
    });
    expect(out).toEqual({ enforced: true, allowed: false, reason: "NO_MEMBERSHIP" });
  });

  it("reports not-enforced when PDP is off; the boundary still applies elsewhere", async () => {
    const deps = baseDeps({ env: { IAAA_PDP_ENABLED: "0" } });
    const out = await evaluateAgentSchedulePdp(deps, {
      principal: { login: "OpenAIMP", agentId: "agent-1" },
      tenantId: "primary",
      action: "create",
      nowMs: 1_700_000_000_000,
    });
    expect(out).toEqual({ enforced: false });
  });
});

describe("3122-P13..P15 executor", () => {
  const principal = { login: "OpenAIMP", agentId: "agent-1" };

  function harness(overrides: Record<string, unknown> = {}) {
    const ledger: unknown[] = [];
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let pending: PendingScheduleApproval[] = [];
    const sdkItems: Array<{ id: string; callback: string; payload?: unknown; type: string; intervalSeconds?: number; cron?: string }> = [];
    let seq = 0;
    const deps = {
      pdp: async () => ({ enforced: true as const, allowed: true as const }),
      config: CONFIG,
      nowMs: () => 1_700_000_000_000,
      nowIso: () => "2026-11-11T12:00:00.000Z",
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
      stores: {
        sdk: {
          list: async () => sdkItems,
          get: async (id: string) => sdkItems.find((item) => item.id === id),
          create: async (input: { callback: string; payload?: unknown; timing: { type: string; cron?: string; intervalSeconds?: number } }) => {
            const item = { id: `sdk-${++seq}`, callback: input.callback, payload: input.payload, type: input.timing.type };
            sdkItems.push(item);
            return item;
          },
          cancel: async (id: string) => {
            const idx = sdkItems.findIndex((item) => item.id === id);
            if (idx < 0) return false;
            sdkItems.splice(idx, 1);
            return true;
          },
        },
        goals: {
          list: async () => [],
          add: async (goal: { id: string; operation: string }) => ({ ...goal, enabled: true }),
          remove: async () => true,
          setEnabled: async () => true,
          trigger: async () => ({ jobsCreated: 0, jobsSkipped: 0, errors: [] }),
        },
      },
      ...overrides,
    };
    return { deps, ledger, audits, getPending: () => pending, sdkItems };
  }

  it("P13 agent creates a screen schedule: armed with agent provenance + ledger row with agent identity", async () => {
    const { deps, ledger, audits, sdkItems } = harness();
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "cron", cron: "0 9 * * 1-5" },
      payload: {},
    });
    expect(out.ok).toBe(true);
    expect(sdkItems).toHaveLength(1);
    const payload = sdkItems[0].payload as Record<string, unknown>;
    expect((payload.provenance as Record<string, unknown>)?.origin).toBe("agent");
    expect((payload.provenance as Record<string, unknown>)?.agentId).toBe("agent-1");
    expect((payload.provenance as Record<string, unknown>)?.createdBy).toBe("OpenAIMP");
    expect(ledger).toHaveLength(1);
    const row = ledger[0] as Record<string, unknown>;
    expect(row.system).toBe("orchestrator-schedule");
    expect(row.operation).toBe("agent.schedule.create");
    expect(row.outcome).toBe("success");
    expect(row.triggeredBy).toBe("manual");
    expect(String(row.detail ?? "")).toContain("agent-1");
    expect(audits.some((a) => a.type === "schedule.created")).toBe(true);
  });

  it("P13b PDP denial blocks the action and audits the denial", async () => {
    const { deps, ledger, sdkItems } = harness({
      pdp: async () => ({ enforced: true as const, allowed: false as const, reason: "NO_MEMBERSHIP" }),
    });
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "cron", cron: "0 9 * * 1-5" },
      payload: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("denied");
    expect(sdkItems).toHaveLength(0);
    expect(ledger).toHaveLength(1);
    expect((ledger[0] as Record<string, unknown>).outcome).toBe("skipped");
  });

  it("P14 consequential schedule without approval is refused and a pending record is created", async () => {
    const { deps, getPending, sdkItems } = harness();
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "goal",
      principal,
      tenantId: "primary",
      operation: "social.publish",
      goal: { id: "g1", name: "Daily post", cron: "0 9 * * *", operation: "social.publish", budgetCents: 100 },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("approval-required");
    expect(sdkItems).toHaveLength(0);
    expect(getPending()).toHaveLength(1);
    expect(getPending()[0].approvalReasons.join(" ")).toMatch(/external send/i);
    expect(getPending()[0].status).toBe("pending");
  });

  it("P15 action on a schedule owned by another login is denied", async () => {
    const { deps, sdkItems } = harness();
    sdkItems.push({
      id: "sdk-9",
      callback: "autonomousMarketScreen",
      type: "cron",
      payload: { provenance: { origin: "user", createdBy: "someone-else", createdAt: "2026-11-11T00:00:00.000Z" } },
    });
    const out = await executeAgentScheduleAction(deps as never, {
      action: "delete",
      kind: "sdk",
      principal,
      tenantId: "primary",
      scheduleId: "sdk-9",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("denied");
    expect(sdkItems).toHaveLength(1);
  });

  it("P14b an approved pending id arms the schedule without re-gating; an unknown id errors honestly", async () => {
    const { deps, getPending, sdkItems } = harness();
    const create = {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "interval", intervalSeconds: 60 } as const,
    } as const;
    const refused = await executeAgentScheduleAction(deps as never, create);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("approval-required");
    const pendingId = !refused.ok ? refused.pendingApprovalId : undefined;
    expect(pendingId).toBeTruthy();
    expect(getPending()).toHaveLength(1);

    // Unknown approval id: honest error, nothing armed.
    const unknown = await executeAgentScheduleAction(deps as never, { ...create, approvedPendingId: "pending-nope" });
    expect(unknown).toMatchObject({ ok: false, code: "error" });
    expect(sdkItems).toHaveLength(0);

    // The recorded approval, once approved, arms the schedule.
    await deps.pendingApprovals.save(
      decidePendingScheduleApproval(getPending(), pendingId!, "approved", "approver", "2026-11-11T13:00:00.000Z"),
    );
    const armed = await executeAgentScheduleAction(deps as never, { ...create, approvedPendingId: pendingId });
    expect(armed.ok).toBe(true);
    expect(sdkItems).toHaveLength(1);
  });

  it("P14c an approved update arms without re-gating (cancel + recreate)", async () => {
    const { deps, getPending, sdkItems } = harness();
    sdkItems.push({
      id: "sdk-1",
      callback: "autonomousMarketScreen",
      type: "interval",
      intervalSeconds: 3600,
      payload: { provenance: { origin: "user", createdBy: "OpenAIMP", createdAt: "2026-11-11T00:00:00.000Z" } },
    });
    const update = {
      action: "update",
      kind: "sdk",
      principal,
      tenantId: "primary",
      scheduleId: "sdk-1",
      timing: { type: "interval", intervalSeconds: 30 } as const,
    } as const;
    const refused = await executeAgentScheduleAction(deps as never, update);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("approval-required");
    const pendingId = !refused.ok ? refused.pendingApprovalId : undefined;
    expect(pendingId).toBeTruthy();
    await deps.pendingApprovals.save(
      decidePendingScheduleApproval(getPending(), pendingId!, "approved", "approver", "2026-11-11T13:00:00.000Z"),
    );
    const armed = await executeAgentScheduleAction(deps as never, { ...update, approvedPendingId: pendingId });
    expect(armed.ok).toBe(true);
    // Cancel + recreate: exactly one row remains, stamped with agent
    // provenance (the fake re-mints the same sequence id, so the
    // provenance stamp — not the id — proves the row is the new one).
    expect(sdkItems).toHaveLength(1);
    expect((sdkItems[0].payload as Record<string, unknown>).provenance).toMatchObject({
      origin: "agent",
      createdBy: "OpenAIMP",
      agentId: "agent-1",
    });
  });
});

describe("3122-P16 pending approvals", () => {
  const entry: PendingScheduleApproval = {
    id: "pending-1",
    kind: "sdk",
    requestedBy: "OpenAIMP",
    agentId: "agent-1",
    requestedAt: "2026-11-11T12:00:00.000Z",
    definition: { callback: "autonomousMarketScreen", timing: { type: "cron", cron: "0 9 * * 1-5" } },
    approvalReasons: ["external send"],
    status: "pending",
  };

  it("records, resolves, and decides a pending approval; double decision and unknown id fail honestly", () => {
    let list: PendingScheduleApproval[] = [];
    list = recordPendingScheduleApproval(list, entry);
    expect(list).toHaveLength(1);
    expect(resolvePendingScheduleApproval(list, "pending-1")?.status).toBe("pending");
    expect(resolvePendingScheduleApproval(list, "nope")).toBeUndefined();
    list = decidePendingScheduleApproval(list, "pending-1", "approved", "approver-1", "2026-11-11T13:00:00.000Z");
    expect(resolvePendingScheduleApproval(list, "pending-1")?.status).toBe("approved");
    expect(() =>
      decidePendingScheduleApproval(list, "pending-1", "approved", "approver-1", "2026-11-11T13:00:00.000Z"),
    ).toThrow(/already decided/i);
    expect(() =>
      decidePendingScheduleApproval(list, "missing", "approved", "approver-1", "2026-11-11T13:00:00.000Z"),
    ).toThrow(/no pending approval/i);
  });
});

describe("3122-P17 agent provenance", () => {
  it("stamps origin agent with agentId and creator login", () => {
    const p = agentScheduleProvenance("agent-1", "OpenAIMP", "2026-11-11T12:00:00.000Z");
    expect(p.origin).toBe("agent");
    expect(p.agentId).toBe("agent-1");
    expect(p.createdBy).toBe("OpenAIMP");
    expect(p.createdAt).toBe("2026-11-11T12:00:00.000Z");
  });
});
