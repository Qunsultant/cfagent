import { describe, expect, it, vi } from "vitest";
import {
  autoRenewETradeTokens,
  autonomousGoalScreen,
  autonomousMarketScreen,
  autonomousStrategyDiscovery,
  collectIvHistory,
  expireStaleOrderDraft,
  sendScheduledReminder,
  type ScheduledCallbacksContext,
} from "../src/agents/orchestrator/scheduledCallbacks";
import {
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";

const SERVICE_LOGIN = "svc-background";

function makeCtx(opts: {
  sessionKey?: string;
  savedUserLogin?: string;
  savedTrigger?: "manual" | "scheduled";
  store?: MembershipStore;
}): {
  ctx: ScheduledCallbacksContext;
  audit: ReturnType<typeof vi.fn>;
  getOrm: ReturnType<typeof vi.fn>;
  removeUnowned: ReturnType<typeof vi.fn>;
} {
  const audit = vi.fn();
  const getOrm = vi.fn(() => {
    throw new Error("getOrm must not be called on a denied dispatch");
  });
  const removeUnowned = vi.fn(async () => {});
  const ctx = {
    env: { SERVICE_USER_LOGIN: SERVICE_LOGIN },
    agentCtx: { storage: { sql: {} } },
    self: {},
    getScreenerExecutionContext: async () =>
      opts.savedUserLogin !== undefined || opts.savedTrigger !== undefined
        ? {
            userLogin: opts.savedUserLogin,
            trigger: opts.savedTrigger,
          }
        : undefined,
    removeUnownedBaselineSchedules: removeUnowned,
    getOrm,
    sessionKey: () => opts.sessionKey ?? "session-1",
    waitUntilStable: async () => true,
    scheduledScreenerSlots: new Set<string>(),
    scheduledDiscoverySlots: new Set<string>(),
    scheduleScreenerFollowups: vi.fn(async () => {}),
    audit,
    serviceMembershipStore: opts.store ?? createMemoryMembershipStore(),
  } as unknown as ScheduledCallbacksContext;
  return { ctx, audit, getOrm, removeUnowned };
}

function denialAudit(audit: ReturnType<typeof vi.fn>, reason: string): void {
  const denial = audit.mock.calls.find(([type]) => type === "schedule.dispatch_denied");
  expect(denial).toBeDefined();
  expect(denial![2]).toMatchObject({ reason });
  // #4004: a denial must carry the action that clears it, not just its code.
  const payload = denial![2] as { action?: unknown };
  expect(typeof payload.action).toBe("string");
  expect(String(payload.action).length).toBeGreaterThan(0);
}

describe("schedule callback dispatch enforcement (#2331 slice 2)", () => {
  it("market screen: denies a service login while unprovisioned, schedule preserved", async () => {
    const { ctx, audit, getOrm, removeUnowned } = makeCtx({
      savedUserLogin: SERVICE_LOGIN,
      savedTrigger: "scheduled",
    });
    await autonomousMarketScreen(ctx, { trigger: "scheduled" });
    denialAudit(audit, "SERVICE_NOT_PROVISIONED");
    expect(getOrm).not.toHaveBeenCalled();
    expect(removeUnowned).not.toHaveBeenCalled();
  });

  it("market screen: denies a scheduled run with no identity and removes the unowned schedule", async () => {
    const { ctx, audit, getOrm, removeUnowned } = makeCtx({ savedTrigger: "scheduled" });
    await autonomousMarketScreen(ctx, { trigger: "scheduled" });
    denialAudit(audit, "NO_IDENTITY");
    expect(getOrm).not.toHaveBeenCalled();
    expect(removeUnowned).toHaveBeenCalled();
  });

  it("market screen: denies a manual run with no identity (no longer runs as empty login)", async () => {
    const { ctx, audit, getOrm, removeUnowned } = makeCtx({ savedTrigger: "manual" });
    await autonomousMarketScreen(ctx, { trigger: "manual" });
    denialAudit(audit, "NO_IDENTITY");
    expect(getOrm).not.toHaveBeenCalled();
    expect(removeUnowned).not.toHaveBeenCalled();
  });

  it("goal screen: denies a service login while unprovisioned", async () => {
    const { ctx, audit, getOrm } = makeCtx({
      savedUserLogin: SERVICE_LOGIN,
      savedTrigger: "scheduled",
    });
    await autonomousGoalScreen(ctx, { trigger: "scheduled" });
    denialAudit(audit, "SERVICE_NOT_PROVISIONED");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("strategy discovery: denies a service login while unprovisioned", async () => {
    const { ctx, audit, getOrm } = makeCtx({
      savedUserLogin: SERVICE_LOGIN,
      savedTrigger: "scheduled",
    });
    await autonomousStrategyDiscovery(ctx, { trigger: "scheduled" } as any);
    denialAudit(audit, "SERVICE_NOT_PROVISIONED");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("token renewal: denies a service login (never renews under service identity)", async () => {
    const { ctx, audit, getOrm } = makeCtx({ savedUserLogin: SERVICE_LOGIN });
    await autoRenewETradeTokens(ctx, {});
    denialAudit(audit, "BROKER_REQUIRED");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("token renewal: skips with a denial audit when no user resolves", async () => {
    const { ctx, audit, getOrm, removeUnowned } = makeCtx({});
    await autoRenewETradeTokens(ctx, {});
    denialAudit(audit, "NO_IDENTITY");
    expect(getOrm).not.toHaveBeenCalled();
    expect(removeUnowned).toHaveBeenCalled();
  });

  it("IV collection: denies a service login (options-chain work needs a broker)", async () => {
    const { ctx, audit, getOrm } = makeCtx({ savedUserLogin: SERVICE_LOGIN });
    await collectIvHistory(ctx, {});
    denialAudit(audit, "BROKER_REQUIRED");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("order-draft expiry: denies the shared address as an identity", async () => {
    const { ctx, audit, getOrm } = makeCtx({ sessionKey: "default_trader" });
    await expireStaleOrderDraft(ctx, { orderId: "order-1" });
    denialAudit(audit, "SHARED_ADDRESS");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("order-draft expiry: denies a service login (order state is owner-attached)", async () => {
    const { ctx, audit, getOrm } = makeCtx({});
    await expireStaleOrderDraft(ctx, { orderId: "order-1", userLogin: SERVICE_LOGIN });
    denialAudit(audit, "BROKER_REQUIRED");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("reminders: denies the shared address as an identity", async () => {
    const { ctx, audit, getOrm } = makeCtx({ sessionKey: "default_trader" });
    await sendScheduledReminder(ctx, { reminderId: "r-1", message: "hi" });
    denialAudit(audit, "SHARED_ADDRESS");
    expect(getOrm).not.toHaveBeenCalled();
  });

  it("reminders: denies a service login while unprovisioned", async () => {
    const { ctx, audit, getOrm } = makeCtx({});
    await sendScheduledReminder(ctx, {
      reminderId: "r-1",
      message: "hi",
      userLogin: SERVICE_LOGIN,
    });
    denialAudit(audit, "SERVICE_NOT_PROVISIONED");
    expect(getOrm).not.toHaveBeenCalled();
  });
});
