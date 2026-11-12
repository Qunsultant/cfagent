/**
 * Issue #2373 (slice C): scheduled stock ticks follow the same
 * payment path as the goal tick — as a payment DECISION, not a
 * workflow start (stock chains / the monolithic runScreen path
 * cannot ride ScreenerScreenWorkflow; CLO G7 #2914 rejected that
 * migration, and it is NOT re-proposed here).
 *
 * Contract pins, per stock tick (autonomousMarketScreen, sharded
 * and monolithic — one service method, one decision block before
 * the sharded/monolithic dispatch):
 * - Flag ON + uncovered recurring -> skipped + audited
 *   (stock_screen.skipped_uncovered, status skipped_uncovered),
 *   explained, no chain, no workflow, never charged unattended.
 * - Flag ON + uncovered one_off without authorization -> skipped
 *   (same audit, coverage reason).
 * - Flag ON + uncovered one_off WITH authorization -> skipped with
 *   the honest one-off-unavailable explanation (no checkout exists
 *   for a stock chain/monolith); still no chain, no charge.
 * - Flag ON + covered -> coverage consumed via the commercial
 *   adapter port (consumeIncludedRun / consumeCredits — the exact
 *   calls inside paymentWorkflow.ts's consumeCoverage dep, reused
 *   at port level, no second consume path) and the chain/run
 *   starts as today.
 * - Flag ON + consume failure -> skipped, no chain (deliberately
 *   stricter than the workflow's best-effort consume: nothing is
 *   paid yet at the tick, so a failed consume must not yield an
 *   uncovered run).
 * - Flag OFF -> today's behaviour unchanged (chain/run starts,
 *   no payment decision, no catalogue/store reads).
 * - Flag ON + missing/invalid/unapproved catalogue price ->
 *   run_failed (success:false + screener.screen_failed audit),
 *   nothing started. Unapproved is discriminated via the
 *   approval-aware read: the stub's raw getPrice still returns a
 *   value while getApprovedPrice returns null, so a tick reading
 *   the raw price would wrongly proceed.
 * - Legacy payload without scheduleKind -> treated as recurring
 *   (uncovered -> skipped).
 *
 * Harness: ScheduledTasksService constructed directly (the
 * pattern of tests/goal_screen_yahoo_fallback_1571.test.ts),
 * with the guard/auth/agent stubs on the instance and the
 * port factories mocked to in-memory doubles. The mocked
 * composition roots are per-file (vi.mock), so no other suite
 * is affected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    getPrice: async (family: string) =>
      priceState.mode === "missing" ? null : family === "stock" ? 0.02 : null,
    getApprovedPrice: async (family: string) =>
      priceState.mode === "approved" && family === "stock" ? 0.02 : null,
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

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";

const USER = "trader@example.com";
const TENANT = "tenant-2373";

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen. The seam fake delegates to the stub agent's
// runScreen: it flattens the seam input back into the runScreen
// request (provider/sector ride the spec on the routes, the
// overrides on the scheduled path) and returns the stub's result
// as the engine run's one shard. The seam itself is pinned in
// tests/stock_entry_routing_4278.test.ts.
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

function stockService(opts: { sharded: boolean }) {
  const env = { IAAA_TENANT_ID: TENANT } as any;
  const service = new ScheduledTasksService(
    env,
    undefined,
    USER,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.sharded ? async () => ({ jobId: "job-1", status: "queued", statusUrl: "/jobs/job-1" }) : undefined,
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
  (service as any).publishScreenerEvent = vi.fn(async () => undefined);
  return { service, audit, guard, runScreen, isScreenRunning };
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

describe("scheduled stock tick payment decision (#2373 slice C)", () => {
  beforeEach(() => {
    flagState.on = true;
    priceState.mode = "approved";
    storeState.commercial = null;
    storeState.subscriptions = null;
  });

  it("flag ON + uncovered recurring (sharded) -> skipped + audited, no chain", async () => {
    seedAccount({ tier: "Free" });
    const { service, audit } = stockService({ sharded: true });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: true,
      scheduleKind: "recurring",
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_uncovered");
    expect(res.data?.reason).toContain("No unattended card charge");
    expect(auditTypes(audit)).toContain("stock_screen.skipped_uncovered");
    expect(auditTypes(audit)).not.toContain("screener.sharded_chain_submitted");
  });

  it("flag ON + uncovered recurring (monolithic) -> skipped, runScreen never called", async () => {
    seedAccount({ tier: "Free" });
    const { service, audit, runScreen } = stockService({ sharded: false });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      scheduleKind: "recurring",
    });
    expect(res.skipped).toBe(true);
    expect(runScreen).not.toHaveBeenCalled();
    expect(auditTypes(audit)).toContain("stock_screen.skipped_uncovered");
  });

  it("flag ON + uncovered one_off without authorization -> skipped", async () => {
    seedAccount({ tier: "Free" });
    const { service } = stockService({ sharded: true });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: true,
      scheduleKind: "one_off",
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_uncovered");
  });

  it("flag ON + uncovered one_off WITH authorization -> skipped with the honest one-off explanation, no chain", async () => {
    seedAccount({ tier: "Free" });
    const { service, audit } = stockService({ sharded: true });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: true,
      scheduleKind: "one_off",
      authorizedAtSubmission: true,
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_one_off_unavailable");
    expect(res.data?.reason).toContain("One-off checkout is unavailable");
    expect(auditTypes(audit)).not.toContain("screener.sharded_chain_submitted");
  });

  it("flag ON + covered by subscription (sharded) -> included run consumed, chain submitted", async () => {
    const commercial = seedAccount({
      tier: "Subscribed",
      includedRuns: 3,
      subscriptions: [{ periodEndMs: Date.now() + 86400_000 }],
    });
    const { service, audit } = stockService({ sharded: true });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: true,
      scheduleKind: "recurring",
    });
    expect(res.skipped).not.toBe(true);
    expect(res.data?.sharded).toBe(true);
    expect(res.data?.chainId).toBeTruthy();
    expect(auditTypes(audit)).toContain("screener.sharded_chain_submitted");
    expect((await commercial.getAccount(USER))?.includedRuns).toBe(2);
  });

  it("flag ON + covered by credits (monolithic) -> credits consumed, runScreen called", async () => {
    const commercial = seedAccount({ tier: "Free", creditsUSD: 5 });
    const { service, runScreen } = stockService({ sharded: false });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      scheduleKind: "recurring",
    });
    expect(res.success).toBe(true);
    expect(runScreen).toHaveBeenCalledTimes(1);
    expect((await commercial.getAccount(USER))?.creditsUSD).toBeCloseTo(4.98, 6);
  });

  it("flag ON + consume failure -> skipped, no chain and no run", async () => {
    const commercial = seedAccount({ tier: "Free", creditsUSD: 5 });
    // Sabotage consumption after the coverage read: the tick must
    // skip rather than run uncovered. (Override on the instance so
    // the adapter's other port methods stay intact.)
    (commercial as any).consumeCredits = async () => {
      throw new Error("store blip");
    };
    const { service, runScreen } = stockService({ sharded: false });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      scheduleKind: "recurring",
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_consume_failed");
    expect(runScreen).not.toHaveBeenCalled();
  });

  it("flag OFF -> today's behaviour unchanged, no payment decision", async () => {
    flagState.on = false;
    seedAccount({ tier: "Free" });
    const { service, runScreen, audit } = stockService({ sharded: false });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      scheduleKind: "recurring",
    });
    expect(res.success).toBe(true);
    expect(runScreen).toHaveBeenCalledTimes(1);
    expect(auditTypes(audit)).not.toContain("stock_screen.skipped_uncovered");
  });

  it("flag ON + missing catalogue price -> run_failed, nothing started", async () => {
    priceState.mode = "missing";
    seedAccount({ tier: "Subscribed", includedRuns: 3 });
    const { service, audit, runScreen } = stockService({ sharded: false });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      scheduleKind: "recurring",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/approved stored price/);
    expect(runScreen).not.toHaveBeenCalled();
    expect(auditTypes(audit)).toContain("screener.screen_failed");
  });

  it("flag ON + unapproved (proposed) price -> run_failed even though a raw price exists", async () => {
    priceState.mode = "proposed";
    seedAccount({ tier: "Subscribed", includedRuns: 3 });
    const { service, audit, runScreen } = stockService({ sharded: true });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: true,
      scheduleKind: "recurring",
    });
    expect(res.success).toBe(false);
    expect(runScreen).not.toHaveBeenCalled();
    expect(auditTypes(audit)).not.toContain("screener.sharded_chain_submitted");
    expect(auditTypes(audit)).toContain("screener.screen_failed");
  });

  it("legacy payload without scheduleKind -> treated as recurring (uncovered -> skipped)", async () => {
    seedAccount({ tier: "Free" });
    const { service } = stockService({ sharded: true });
    const res: any = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      trigger: "scheduled",
      sharded: true,
    });
    expect(res.skipped).toBe(true);
    expect(res.data?.status).toBe("skipped_uncovered");
  });
});
