/**
 * Issue #2373 (slice C, item 5 second half): the goal tick's
 * fail-closed price path had no dedicated test. The tick reads
 * the goal price from the operator price catalogue port and must
 * THROW into its run_failed path (no workflow, no screen) when
 * the price is missing, invalid, or — per #2547 — UNAPPROVED.
 *
 * #2547 semantics, as verified in src/data/priceCataloguePorts.ts
 * and both adapters: charging reads go through getApprovedPrice,
 * which returns null unless the entry exists, is valid, AND is
 * APPROVED. A proposed price is not an error and not a flag on
 * the number — it is a null from the approval-aware read, and the
 * tick fails closed on that null exactly like a missing price.
 * (The tick previously read the raw getPrice, bypassing #2547;
 * slice C switches it to getApprovedPrice. The "proposed" case
 * below discriminates the two reads: the stub's raw getPrice
 * still returns a value while getApprovedPrice returns null, so
 * a tick on the raw read would wrongly proceed to payment.)
 *
 * Harness: ScheduledTasksService constructed directly (the
 * pattern of tests/goal_screen_yahoo_fallback_1571.test.ts),
 * with the guard stubbed unblocked and the port factories mocked
 * to in-memory doubles. The mocked composition roots are
 * per-file (vi.mock), so no other suite is affected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const flagState = vi.hoisted(() => ({ on: true }));
const priceState = vi.hoisted(() => ({
  mode: "approved" as "approved" | "proposed" | "missing" | "invalid",
}));
const storeState = vi.hoisted(() => ({
  commercial: null as any,
  subscriptions: null as any,
}));

vi.mock("../src/features/createFeatureFlagPort", () => ({
  createFeatureFlagPort: () => ({
    isEnabled: async (name: string) => (name === "monetization" ? flagState.on : false),
  }),
}));

vi.mock("../src/data/createPriceCataloguePorts", () => ({
  createPriceCatalogueAdapter: () => ({
    db: {},
    getPrice: async (family: string) => {
      if (priceState.mode === "missing" || priceState.mode === "invalid") return null;
      return family === "goal" ? 0.1 : null;
    },
    getApprovedPrice: async (family: string) =>
      priceState.mode === "approved" && family === "goal" ? 0.1 : null,
    getEntry: async () => null,
  }),
  ensurePriceCatalogueSchema: async () => {},
}));

vi.mock("../src/data/createCommercialPorts", () => ({
  createCommercialAdapter: () => storeState.commercial,
  ensureCommercialSchema: async () => {},
}));

vi.mock("../src/data/createSubscriptionPorts", () => ({
  createSubscriptionAdapter: () => storeState.subscriptions,
  ensureSubscriptionSchema: async () => {},
}));

vi.mock("../src/services/paymentWorkflowSubmission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paymentWorkflowSubmission")>();
  return {
    ...actual,
    startPaymentWorkflowViaBinding: vi.fn(async () => ({ workflowId: "wf-test-1" })),
  };
});

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { startPaymentWorkflowViaBinding } from "../src/services/paymentWorkflowSubmission";

const USER = "trader@example.com";
const TENANT = "tenant-2373";

function goalService() {
  const env = { IAAA_TENANT_ID: TENANT } as any;
  const orm = new DatabaseORM(new MockSqlStorage() as any);
  const service = new ScheduledTasksService(env, orm, USER);
  const audit = vi.fn(() => {});
  const guard = vi.fn(async () => ({ blocked: false as const }));
  (service as any).audit = audit;
  (service as any).guardScheduledAuth = guard;
  return { service, audit, guard };
}

function seedAccount(opts: {
  tier: "Free" | "Subscribed";
  creditsUSD?: number;
  includedRuns?: number;
  subscriptions?: Array<{ periodEndMs: number }>;
}) {
  const commercial = new InMemoryCommercialAdapter();
  void commercial.upsertAccount({
    userId: USER,
    tenantId: TENANT,
    tier: opts.tier,
    tierSource: "operator",
    creditsUSD: opts.creditsUSD ?? 0,
    includedRuns: opts.includedRuns ?? 0,
  });
  storeState.commercial = commercial;
  storeState.subscriptions = {
    listSubscriptions: async () => opts.subscriptions ?? [],
  };
  return commercial;
}

function auditTypes(audit: any): string[] {
  return audit.mock.calls.map((c: any[]) => c[0] as string);
}

describe("goal tick fail-closed price path (#2373 slice C)", () => {
  beforeEach(() => {
    flagState.on = true;
    priceState.mode = "approved";
    storeState.commercial = null;
    storeState.subscriptions = null;
    vi.mocked(startPaymentWorkflowViaBinding).mockClear();
  });

  it("missing price -> run_failed, no workflow started", async () => {
    priceState.mode = "missing";
    seedAccount({ tier: "Subscribed", includedRuns: 3 });
    const { service, audit } = goalService();
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: USER,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/approved stored price/);
    expect(auditTypes(audit)).toContain("goal_screen.run_failed");
    expect(auditTypes(audit)).not.toContain("goal_screen.payment_started");
    expect(startPaymentWorkflowViaBinding).not.toHaveBeenCalled();
  });

  it("invalid price -> run_failed, no workflow started", async () => {
    priceState.mode = "invalid";
    seedAccount({ tier: "Subscribed", includedRuns: 3 });
    const { service, audit } = goalService();
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: USER,
    });
    expect(res.success).toBe(false);
    expect(auditTypes(audit)).toContain("goal_screen.run_failed");
    expect(startPaymentWorkflowViaBinding).not.toHaveBeenCalled();
  });

  it("unapproved (proposed) price -> run_failed, no workflow started", async () => {
    priceState.mode = "proposed";
    seedAccount({ tier: "Subscribed", includedRuns: 3 });
    const { service, audit } = goalService();
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: USER,
    });
    expect(res.success).toBe(false);
    expect(auditTypes(audit)).toContain("goal_screen.run_failed");
    expect(auditTypes(audit)).not.toContain("goal_screen.payment_started");
    expect(startPaymentWorkflowViaBinding).not.toHaveBeenCalled();
  });

  it("valid approved price + covered -> payment path proceeds (payment_started)", async () => {
    priceState.mode = "approved";
    seedAccount({
      tier: "Subscribed",
      includedRuns: 3,
      subscriptions: [{ periodEndMs: Date.now() + 86400_000 }],
    });
    const { service, audit } = goalService();
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: USER,
    });
    expect(res.success).toBe(true);
    expect(res.data?.status).toBe("payment_started");
    expect(res.data?.workflowId).toBe("wf-test-1");
    expect(auditTypes(audit)).toContain("goal_screen.payment_started");
    expect(auditTypes(audit)).not.toContain("goal_screen.run_failed");
    expect(startPaymentWorkflowViaBinding).toHaveBeenCalledTimes(1);
  });
});
