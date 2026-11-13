/**
 * Issue #3179: scheduled ticks resolve the tenant from the schedule
 * OWNER's stored account row, never from the deployment default.
 *
 * Before this fix the stock and goal tick gate blocks called
 * resolveIaaaTenant(env) (env IAAA_TENANT_ID, else "primary") and
 * used that as the run tenant, while paid coverage resolves from
 * the owner's account tenant — so a mismatched-default deployment
 * failed owner ticks closed on the mismatch throw in
 * resolvePaidScreenAccount, and the flag-OFF path ran silently
 * under the env default with no check.
 *
 * Contract pins:
 * - Owner row wins: a tick with an account row whose tenant
 *   differs from the env default runs under the ROW tenant (no
 *   mismatch throw), in the stock gate, the goal gate, and the
 *   flag-OFF workflow command alike.
 * - Ownerless fallback: a tick with no account row runs under the
 *   env default, EXPLICITLY and LOGGED (the
 *   schedule.tick_tenant_env_fallback audit), never silent.
 * - Two tenants in flight: two owners' ticks in one deployment
 *   each execute under their own owner's tenant.
 * - The mismatch throw in resolvePaidScreenAccount is unchanged
 *   (still the guard); the tick gate blocks never call the
 *   env-default resolver directly (source pin below).
 *
 * Harness: ScheduledTasksService constructed directly (the pattern
 * of tests/paid_screen_scheduled_stock_2373.test.ts), with the
 * guard/auth/agent stubs on the instance and the port factories
 * mocked to in-memory doubles. The mocked composition roots are
 * per-file (vi.mock), so no other suite is affected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const flagState = vi.hoisted(() => ({ on: true }));
const priceState = vi.hoisted(() => ({
  mode: "approved" as "approved" | "proposed" | "missing",
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
      if (priceState.mode === "missing") return null;
      return family === "stock" ? 0.02 : family === "goal" ? 0.1 : null;
    },
    getApprovedPrice: async (family: string) =>
      priceState.mode === "approved" ? (family === "stock" ? 0.02 : family === "goal" ? 0.1 : null) : null,
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

vi.mock("../src/services/goalScreenWorkflowSubmission", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/goalScreenWorkflowSubmission")>();
  return {
    ...actual,
    startGoalScreenWorkflow: vi.fn(async () => ({ workflowId: "wf-flag-off-1" })),
  };
});

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveTickTenant } from "../src/services/paidScreenSubmission";
import { startPaymentWorkflowViaBinding } from "../src/services/paymentWorkflowSubmission";
import { startGoalScreenWorkflow } from "../src/services/goalScreenWorkflowSubmission";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const DEPLOY_DEFAULT = "deploy-default-tenant";

const FALLBACK_AUDIT = "schedule.tick_tenant_env_fallback";

function auditTypes(audit: any): string[] {
  return audit.mock.calls.map((c: any[]) => c[0] as string);
}

function fallbackAudits(audit: any): any[] {
  return audit.mock.calls.filter((c: any[]) => c[0] === FALLBACK_AUDIT).map((c: any[]) => c[1]);
}

/* ------------------------------------------------------------------ */
/* Tick-tenant helper                                                  */
/* ------------------------------------------------------------------ */

describe("resolveTickTenant (#3179)", () => {
  const rowStore = (tenantId: string) => ({
    getAccount: async () => ({ tenantId }),
  });

  it("owner row wins over a mismatched env default", async () => {
    const res = await resolveTickTenant(rowStore("owner-tenant") as any, {
      userId: ALICE,
      env: { IAAA_TENANT_ID: DEPLOY_DEFAULT } as any,
    });
    expect(res).toEqual({ tenantId: "owner-tenant", usedEnvDefaultFallback: false });
  });

  it("owner row wins when the env default is unset", async () => {
    const res = await resolveTickTenant(rowStore(ALICE) as any, {
      userId: ALICE,
      env: {} as any,
    });
    expect(res).toEqual({ tenantId: ALICE, usedEnvDefaultFallback: false });
  });

  it("no owner row -> env default, flagged for explicit logging", async () => {
    const res = await resolveTickTenant({ getAccount: async () => null } as any, {
      userId: ALICE,
      env: { IAAA_TENANT_ID: DEPLOY_DEFAULT } as any,
    });
    expect(res).toEqual({ tenantId: DEPLOY_DEFAULT, usedEnvDefaultFallback: true });
  });

  it("no owner row + env unset -> documented default, flagged", async () => {
    const res = await resolveTickTenant({ getAccount: async () => null } as any, {
      userId: ALICE,
      env: {} as any,
    });
    expect(res).toEqual({ tenantId: "primary", usedEnvDefaultFallback: true });
  });

  it("unbound store -> env default, flagged", async () => {
    const res = await resolveTickTenant(null, {
      userId: ALICE,
      env: { IAAA_TENANT_ID: DEPLOY_DEFAULT } as any,
    });
    expect(res).toEqual({ tenantId: DEPLOY_DEFAULT, usedEnvDefaultFallback: true });
  });

  it("store read failure propagates (paid gates fail closed on it)", async () => {
    const failing = {
      getAccount: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      resolveTickTenant(failing as any, { userId: ALICE, env: {} as any }),
    ).rejects.toThrow("db down");
  });
});

/* ------------------------------------------------------------------ */
/* Regression pin: gate blocks never resolve the tenant directly       */
/* ------------------------------------------------------------------ */

describe("tick gate source pin (#3179)", () => {
  it("scheduledTasks.ts never calls the env-default resolver directly", () => {
    const srcPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/services/scheduledTasks.ts",
    );
    const source = readFileSync(srcPath, "utf8");
    // Strip comments so the pin constrains code, not vocabulary:
    // block comments removed, then line comments cut at the first
    // "//". Over-stripping inside string literals is sound here —
    // the pin asserts absence, and no resolver call shares a line
    // with a preceding "//" in a string.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.split("//")[0])
      .join("\n");
    expect(stripped).not.toMatch(/resolveIaaaTenant\s*\(/);
    expect(stripped).not.toMatch(/resolveIaaaTenant\s*}/);
  });
});

/* ------------------------------------------------------------------ */
/* Stock tick                                                          */
/* ------------------------------------------------------------------ */

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen (copied from
// tests/paid_screen_scheduled_stock_2373.test.ts).
const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
  const flat = {
    trigger: input.spec.trigger,
    sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
    universe: input.spec.universe,
    maxSymbols: input.commandOverrides?.maxSymbols,
    filters: input.spec.filters,
    userLogin: input.userLogin,
    environment: input.environment,
    portfolioContext: input.portfolioContext,
    provider: input.commandOverrides?.provider ?? input.spec.provider,
    broker: input.commandOverrides?.broker,
    ...(input.commandOverrides?.mode
      ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
      : {}),
  };
  const result = await runScreen(flat);
  return {
    results: [result],
    collation: null,
    jobId: input.spec?.jobId ?? "test-job",
    workflowId: "wf-1",
  };
};

function stockService(opts: { envTenant?: string | null; user?: string }) {
  const env = (opts.envTenant === null ? {} : { IAAA_TENANT_ID: opts.envTenant ?? DEPLOY_DEFAULT }) as any;
  const service = new ScheduledTasksService(
    env,
    undefined,
    opts.user ?? ALICE,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  const audit = vi.fn(() => {});
  const guard = vi.fn(async () => ({ blocked: false as const }));
  const runScreen = vi.fn(async () => ({
    success: true,
    trigger: "scheduled",
    sector: "ALL",
    universe: "NASDAQ100",
    provider: "etrade",
    totalScanned: 10,
    matchedCount: 0,
    opportunities: [],
    allStocks: [],
  }));
  const isScreenRunning = vi.fn(async () => ({ running: false }));
  (service as any).audit = audit;
  (service as any).guardScheduledAuth = guard;
  (service as any).getScreenerAgent = () => ({ runScreen, isScreenRunning });
  (service as any).runStockScreenViaEngine = delegateSeamFake(runScreen);
  (service as any).submitStockScreenViaEngine = async (input: any) => ({
    jobId: input.commandOverrides?.jobId ?? input.spec?.jobId ?? "test-job",
    workflowId: "wf-1",
  });
  (service as any).publishScreenerEvent = vi.fn(async () => undefined);
  return { service, audit, guard, runScreen, isScreenRunning };
}

function seedAccounts(
  rows: Array<{
    userId: string;
    tenantId: string;
    tier: "Free" | "Subscribed";
    creditsUSD?: number;
    includedRuns?: number;
  }>,
  subscriptions: Array<{ periodEndMs: number }> = [],
) {
  const commercial = new InMemoryCommercialAdapter();
  for (const row of rows) {
    void commercial.upsertAccount({
      userId: row.userId,
      tenantId: row.tenantId,
      tier: row.tier,
      tierSource: "operator",
      creditsUSD: row.creditsUSD ?? 0,
      includedRuns: row.includedRuns ?? 0,
    });
  }
  storeState.commercial = commercial;
  storeState.subscriptions = {
    listSubscriptions: async () => subscriptions,
  };
  return commercial;
}

describe("scheduled stock tick tenant (#3179)", () => {
  beforeEach(() => {
    flagState.on = true;
    priceState.mode = "approved";
    storeState.commercial = null;
    storeState.subscriptions = null;
  });

  it("mismatched default + owner row (tenant = login) + covered -> runs, no mismatch throw", async () => {
    const commercial = seedAccounts(
      [{ userId: ALICE, tenantId: ALICE, tier: "Subscribed", includedRuns: 3 }],
      [{ periodEndMs: Date.now() + 86400_000 }],
    );
    const { service, audit, runScreen } = stockService({});
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: false,
      scheduleKind: "recurring",
    });
    expect(res.skipped).not.toBe(true);
    expect(res.success).toBe(true);
    expect(runScreen).toHaveBeenCalled();
    expect(auditTypes(audit)).not.toContain(FALLBACK_AUDIT);
    expect(auditTypes(audit)).not.toContain("screener.screen_failed");
    expect((await commercial.getAccount(ALICE))?.includedRuns).toBe(2);
  });

  it("mismatched default + owner row + uncovered -> skipped_uncovered, not run_failed", async () => {
    seedAccounts([{ userId: ALICE, tenantId: ALICE, tier: "Free" }]);
    const { service, audit, runScreen } = stockService({});
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: false,
      scheduleKind: "recurring",
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_uncovered");
    expect(runScreen).not.toHaveBeenCalled();
    expect(auditTypes(audit)).not.toContain(FALLBACK_AUDIT);
  });

  it("no owner row -> explicit logged env-default fallback, then uncovered skip", async () => {
    seedAccounts([]);
    const { service, audit } = stockService({});
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: false,
      scheduleKind: "recurring",
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_uncovered");
    const fallbacks = fallbackAudits(audit);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      family: "stock",
      userLogin: ALICE,
      tenantId: DEPLOY_DEFAULT,
      reason: "no stored account row for schedule owner",
    });
  });

  it("no owner row + env unset -> fallback audit names the documented default", async () => {
    seedAccounts([]);
    const { service, audit } = stockService({ envTenant: null });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: false,
      scheduleKind: "recurring",
    });
    expect(res.skipped).toBe(true);
    const fallbacks = fallbackAudits(audit);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ tenantId: "primary", family: "stock" });
  });

  it("two tenants in flight: each owner's tick runs under its own row tenant", async () => {
    const commercial = seedAccounts(
      [
        { userId: ALICE, tenantId: "tenant-alice", tier: "Subscribed", includedRuns: 2 },
        { userId: BOB, tenantId: "tenant-bob", tier: "Subscribed", includedRuns: 2 },
      ],
      [{ periodEndMs: Date.now() + 86400_000 }],
    );
    const { service, audit, runScreen } = stockService({});
    const resAlice: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: false,
      scheduleKind: "recurring",
      userLogin: ALICE,
    });
    const resBob: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: false,
      scheduleKind: "recurring",
      userLogin: BOB,
    });
    expect(resAlice.success).toBe(true);
    expect(resBob.success).toBe(true);
    expect(runScreen).toHaveBeenCalledTimes(2);
    expect(auditTypes(audit)).not.toContain(FALLBACK_AUDIT);
    expect((await commercial.getAccount(ALICE))?.includedRuns).toBe(1);
    expect((await commercial.getAccount(BOB))?.includedRuns).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Goal tick                                                           */
/* ------------------------------------------------------------------ */

function goalService(opts: { envTenant?: string | null; user?: string }) {
  const env = (opts.envTenant === null ? {} : { IAAA_TENANT_ID: opts.envTenant ?? DEPLOY_DEFAULT }) as any;
  const orm = new DatabaseORM(new MockSqlStorage() as any);
  const service = new ScheduledTasksService(env, orm, opts.user ?? ALICE);
  const audit = vi.fn(() => {});
  const guard = vi.fn(async () => ({ blocked: false as const }));
  (service as any).audit = audit;
  (service as any).guardScheduledAuth = guard;
  return { service, audit, guard };
}

describe("scheduled goal tick tenant (#3179)", () => {
  beforeEach(() => {
    flagState.on = true;
    priceState.mode = "approved";
    storeState.commercial = null;
    storeState.subscriptions = null;
    vi.mocked(startPaymentWorkflowViaBinding).mockClear();
    vi.mocked(startGoalScreenWorkflow).mockClear();
  });

  it("mismatched default + owner row + covered -> payment workflow carries the row tenant", async () => {
    seedAccounts(
      [{ userId: ALICE, tenantId: ALICE, tier: "Subscribed", includedRuns: 3 }],
      [{ periodEndMs: Date.now() + 86400_000 }],
    );
    const { service, audit } = goalService({});
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: ALICE,
    });
    expect(res.data?.status).toBe("payment_started");
    expect(startPaymentWorkflowViaBinding).toHaveBeenCalledTimes(1);
    const params = vi.mocked(startPaymentWorkflowViaBinding).mock.calls[0][1] as any;
    expect(params.tenantId).toBe(ALICE);
    expect(params.screenerCommand.tenantId).toBe(ALICE);
    expect(params.account.tenantId).toBe(ALICE);
    expect(auditTypes(audit)).not.toContain(FALLBACK_AUDIT);
  });

  it("no owner row -> explicit logged env-default fallback, then uncovered skip", async () => {
    seedAccounts([]);
    const { service, audit } = goalService({});
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: ALICE,
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_uncovered");
    expect(startPaymentWorkflowViaBinding).not.toHaveBeenCalled();
    const fallbacks = fallbackAudits(audit);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      family: "goal",
      userLogin: ALICE,
      tenantId: DEPLOY_DEFAULT,
      reason: "no stored account row for schedule owner",
    });
  });

  it("two tenants in flight: each payment submission carries its owner's tenant", async () => {
    seedAccounts(
      [
        { userId: ALICE, tenantId: "tenant-alice", tier: "Subscribed", includedRuns: 2 },
        { userId: BOB, tenantId: "tenant-bob", tier: "Subscribed", includedRuns: 2 },
      ],
      [{ periodEndMs: Date.now() + 86400_000 }],
    );
    const { service, audit } = goalService({});
    await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: ALICE,
      userLogin: ALICE,
    });
    await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: BOB,
      userLogin: BOB,
    });
    expect(startPaymentWorkflowViaBinding).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(startPaymentWorkflowViaBinding).mock.calls;
    expect((calls[0][1] as any).tenantId).toBe("tenant-alice");
    expect((calls[1][1] as any).tenantId).toBe("tenant-bob");
    expect(auditTypes(audit)).not.toContain(FALLBACK_AUDIT);
  });

  it("flag OFF + owner row -> workflow command carries the row tenant, not the env default", async () => {
    flagState.on = false;
    seedAccounts([{ userId: ALICE, tenantId: ALICE, tier: "Free" }]);
    const { service, audit } = goalService({});
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: ALICE,
    });
    expect(res.data?.status).toBe("queued");
    expect(startGoalScreenWorkflow).toHaveBeenCalledTimes(1);
    const command = vi.mocked(startGoalScreenWorkflow).mock.calls[0][1] as any;
    expect(command.tenantId).toBe(ALICE);
    expect(auditTypes(audit)).not.toContain(FALLBACK_AUDIT);
  });

  it("flag OFF + no owner row -> command carries the env default, fallback audited", async () => {
    flagState.on = false;
    seedAccounts([]);
    const { service, audit } = goalService({});
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: ALICE,
    });
    expect(res.data?.status).toBe("queued");
    expect(startGoalScreenWorkflow).toHaveBeenCalledTimes(1);
    const command = vi.mocked(startGoalScreenWorkflow).mock.calls[0][1] as any;
    expect(command.tenantId).toBe(DEPLOY_DEFAULT);
    const fallbacks = fallbackAudits(audit);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ family: "goal", tenantId: DEPLOY_DEFAULT });
  });

  it("flag OFF + unreadable store -> free path still runs under the logged fallback", async () => {
    flagState.on = false;
    storeState.commercial = {
      getAccount: async () => {
        throw new Error("db down");
      },
    };
    storeState.subscriptions = { listSubscriptions: async () => [] };
    const { service, audit } = goalService({});
    const res: any = await service.autonomousGoalScreen({
      goalKind: "income",
      trigger: "scheduled",
      emailTo: ALICE,
    });
    expect(res.data?.status).toBe("queued");
    const command = vi.mocked(startGoalScreenWorkflow).mock.calls[0][1] as any;
    expect(command.tenantId).toBe(DEPLOY_DEFAULT);
    const fallbacks = fallbackAudits(audit);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      reason: "commercial account read failed",
      error: "db down",
    });
  });
});
