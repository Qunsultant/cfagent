/**
 * Issue #2186 (slice 10, program #2012) — orchestrator paid-screen seam:
 * the routing decision, the caller-side coverage read, the verified
 * account resolution, and the payment-workflow submission builder.
 *
 * TDD: written before the route/scheduler wiring. No worker runtime, no
 * D1, no cfpay — ports are fakes, the decision is pure.
 */
import { describe, expect, it } from "vitest";
import {
  buildPaidScreenSubmission,
  coverageForAccount,
  resolvePaidScreenAccount,
  resolvePaidScreenAction,
  SCHEDULED_COVERAGE_REQUIRED_REASON,
  type PaidScreenStorePorts,
} from "../src/services/paidScreenSubmission";
import type { CommercialAccount } from "../src/services/cfpayMonetization";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";

function account(overrides: Partial<CommercialAccount> = {}): CommercialAccount {
  return {
    userId: "alice",
    email: "alice@example.com",
    tenantId: "tenant-1",
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    ...overrides,
  };
}

function command(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "goal-screen:manual:alice:income:2026-10-28T00:00:00.000Z",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    shards: [{ shardId: "goal" }],
    ...overrides,
  };
}

function fakePorts(overrides: Partial<PaidScreenStorePorts> = {}): PaidScreenStorePorts {
  return {
    commercial: {
      getAccount: async () => null,
    } as unknown as PaidScreenStorePorts["commercial"],
    subscriptions: {
      listSubscriptions: async () => [],
    } as unknown as PaidScreenStorePorts["subscriptions"],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Routing decision                                                    */
/* ------------------------------------------------------------------ */

describe("resolvePaidScreenAction (#2186)", () => {
  it("flag OFF → free, for manual and scheduled alike", () => {
    expect(
      resolvePaidScreenAction({ monetizationOn: false, trigger: "manual", coverage: null, priceUSD: 0.1 }),
    ).toMatchObject({ action: "free" });
    expect(
      resolvePaidScreenAction({ monetizationOn: false, trigger: "scheduled", scheduleKind: "recurring", coverage: null, priceUSD: 0.1 }),
    ).toMatchObject({ action: "free" });
  });

  it("manual + flag ON → payment workflow, regardless of caller-side coverage", () => {
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "manual", coverage: null, priceUSD: 0.1 }),
    ).toMatchObject({ action: "start_payment" });
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "manual", coverage: "credits", priceUSD: 0.1 }),
    ).toMatchObject({ action: "start_payment" });
  });

  it("scheduled + covered (either kind) → payment workflow", () => {
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", scheduleKind: "recurring", coverage: "subscription_included", priceUSD: 0.1 }),
    ).toMatchObject({ action: "start_payment" });
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", scheduleKind: "recurring", coverage: "credits", priceUSD: 0.1 }),
    ).toMatchObject({ action: "start_payment" });
  });

  it("scheduled + uncovered recurring → skipped, audited reason, explained price", () => {
    const decision = resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", scheduleKind: "recurring", coverage: null, priceUSD: 0.1 });
    expect(decision).toMatchObject({
      action: "skip",
      reason: SCHEDULED_COVERAGE_REQUIRED_REASON,
      priceUSD: 0.1,
    });
    expect(decision.reason).toMatch(/No unattended card charge/);
  });

  it("scheduled + unstated scheduleKind fails closed to recurring → skipped when uncovered", () => {
    const decision = resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", coverage: null, priceUSD: 0.1 });
    expect(decision).toMatchObject({ action: "skip", priceUSD: 0.1 });
  });

  it("scheduled + one-off authorized at submission → payment workflow even when uncovered", () => {
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", scheduleKind: "one_off", authorizedAtSubmission: true, coverage: null, priceUSD: 0.1 }),
    ).toMatchObject({ action: "start_payment" });
  });

  it("scheduled + one-off NOT authorized → coverage-only, skipped when uncovered", () => {
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", scheduleKind: "one_off", authorizedAtSubmission: false, coverage: null, priceUSD: 0.1 }),
    ).toMatchObject({ action: "skip" });
    expect(
      resolvePaidScreenAction({ monetizationOn: true, trigger: "scheduled", scheduleKind: "one_off", coverage: null, priceUSD: 0.1 }),
    ).toMatchObject({ action: "skip" });
  });
});

/* ------------------------------------------------------------------ */
/* Caller-side coverage read                                           */
/* ------------------------------------------------------------------ */

describe("coverageForAccount (#2186)", () => {
  it("subscription included runs win over credits", () => {
    expect(
      coverageForAccount(account({ tier: "Subscribed", includedRunsRemaining: 2, creditsUSD: 5 }), 0.1),
    ).toBe("subscription_included");
  });

  it("zero included runs fall through to credits", () => {
    expect(
      coverageForAccount(account({ tier: "Subscribed", includedRunsRemaining: 0, creditsUSD: 5 }), 0.1),
    ).toBe("credits");
  });

  it("credits at exactly the price cover; a cent below does not", () => {
    expect(coverageForAccount(account({ creditsUSD: 0.1 }), 0.1)).toBe("credits");
    expect(coverageForAccount(account({ creditsUSD: 0.09 }), 0.1)).toBeNull();
  });

  it("no coverage → null", () => {
    expect(coverageForAccount(account(), 0.1)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Verified account resolution                                         */
/* ------------------------------------------------------------------ */

describe("resolvePaidScreenAccount (#2186)", () => {
  it("unbound store fails closed", async () => {
    await expect(
      resolvePaidScreenAccount(
        { commercial: null, subscriptions: null },
        { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: Date.now() },
      ),
    ).rejects.toThrow(/unavailable/);
  });

  it("tenant mismatch throws", async () => {
    const ports = fakePorts({
      commercial: {
        getAccount: async () => ({
          id: "alice",
          tenantId: "tenant-OTHER",
          tier: "Free",
          creditsUSD: 0,
          includedRuns: 0,
          updatedAtMs: 0,
        }),
      } as unknown as PaidScreenStorePorts["commercial"],
    });
    await expect(
      resolvePaidScreenAccount(ports, { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: Date.now() }),
    ).rejects.toThrow(/Tenant mismatch/);
  });

  it("subscription-read failure fails closed, never a run on unverified coverage", async () => {
    const ports = fakePorts({
      subscriptions: {
        listSubscriptions: async () => {
          throw new Error("D1 down");
        },
      } as unknown as PaidScreenStorePorts["subscriptions"],
    });
    await expect(
      resolvePaidScreenAccount(ports, { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: Date.now() }),
    ).rejects.toThrow(/Subscription state unavailable/);
  });

  it("unexpired subscription confers Subscribed at read time", async () => {
    const ports = fakePorts({
      commercial: {
        getAccount: async () => ({
          id: "alice",
          tenantId: "tenant-1",
          tier: "Free",
          creditsUSD: 0,
          includedRuns: 0,
          updatedAtMs: 0,
        }),
      } as unknown as PaidScreenStorePorts["commercial"],
      subscriptions: {
        listSubscriptions: async () => [{ periodEndMs: Date.now() + 86_400_000 }],
      } as unknown as PaidScreenStorePorts["subscriptions"],
    });
    const { account: resolved } = await resolvePaidScreenAccount(
      ports,
      { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: Date.now() },
    );
    expect(resolved.tier).toBe("Subscribed");
  });

  it("lapsed subscription-granted tier falls back to Free", async () => {
    const ports = fakePorts({
      commercial: {
        getAccount: async () => ({
          id: "alice",
          tenantId: "tenant-1",
          tier: "Subscribed",
          tierSource: "subscription",
          creditsUSD: 0,
          includedRuns: 0,
          updatedAtMs: 0,
        }),
      } as unknown as PaidScreenStorePorts["commercial"],
      subscriptions: {
        listSubscriptions: async () => [{ periodEndMs: Date.now() - 1000 }],
      } as unknown as PaidScreenStorePorts["subscriptions"],
    });
    const { account: resolved } = await resolvePaidScreenAccount(
      ports,
      { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: Date.now() },
    );
    expect(resolved.tier).toBe("Free");
  });

  it("missing store row is an implicit Free account, not an error", async () => {
    const { account: resolved } = await resolvePaidScreenAccount(
      fakePorts(),
      { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: Date.now() },
    );
    expect(resolved).toMatchObject({ userId: "alice", tier: "Free", creditsUSD: 0, includedRunsRemaining: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* Submission builder: no double-start, tenant discipline              */
/* ------------------------------------------------------------------ */

describe("buildPaidScreenSubmission (#2186)", () => {
  const input = {
    runRequestId: "goal-screen:manual:alice:income:2026-10-28T00:00:00.000Z",
    family: "goal" as const,
    trigger: "manual" as const,
    tenantId: "tenant-1",
    userId: "alice",
    email: "alice@example.com",
    account: account(),
    screenerCommand: command(),
  };

  it("a retried submission builds identical params (same runRequestId → same workflow instance)", () => {
    expect(buildPaidScreenSubmission(input)).toEqual(buildPaidScreenSubmission(input));
    expect(buildPaidScreenSubmission(input).runRequestId).toBe(input.runRequestId);
    expect(buildPaidScreenSubmission(input).screenerCommand).toBe(input.screenerCommand);
  });

  it("tenant mismatch still throws", () => {
    expect(() =>
      buildPaidScreenSubmission({ ...input, account: account({ tenantId: "tenant-OTHER" }) }),
    ).toThrow(/Tenant mismatch/);
  });

  it("missing identity fails closed", () => {
    expect(() => buildPaidScreenSubmission({ ...input, userId: "" })).toThrow();
    expect(() => buildPaidScreenSubmission({ ...input, tenantId: "" })).toThrow();
  });

  // Issue #2373 (S1b, gate-before-email): the email is the checkout
  // contact, not identity — a covered run submits with no email and
  // the gate demands one only when a checkout is actually minted.
  it("missing email no longer throws at build", () => {
    expect(() => buildPaidScreenSubmission({ ...input, email: "" })).not.toThrow();
  });
});
