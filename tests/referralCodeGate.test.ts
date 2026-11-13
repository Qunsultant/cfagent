// @vitest-environment node
/**
 * Issue #3307 (slice 2, sub-issue of #3241) — code-runs coverage
 * in the native monetization gate.
 *
 * Coverage order (after the grant/Free-allowance branches and
 * after price resolution): subscription included runs first,
 * then the code-runs balance, then the runs-pack balance, then
 * credits, then checkout. A code run is spent at decision time,
 * inside the gate, and only after price resolution — so a code
 * never covers a run whose family price is missing or unapproved
 * (NQ7, fail-closed). The balance is family-agnostic: the same
 * balance covers any family's run, once that family's price is
 * approved. No journal entry: a code run is a granted run, not a
 * purchase.
 */
import { describe, expect, it } from "vitest";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryCodeRunsBalanceAdapter } from "../src/data/inMemoryReferralCodeAdapter";
import { InMemoryRunsPackBalanceAdapter } from "../src/data/inMemoryRunsPackAdapter";
import type { CheckoutPorts } from "../src/services/checkoutPorts";

function account(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "PayPerUse",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    ...overrides,
  };
}

async function codeGate(opts: {
  approved?: boolean;
  codeRuns?: number;
  packRuns?: number;
  checkout?: CheckoutPorts | null;
} = {}) {
  const codeRunsBalance = new InMemoryCodeRunsBalanceAdapter();
  if (opts.codeRuns) await codeRunsBalance.addCodeRuns("u1", opts.codeRuns);
  const runsPackBalance = new InMemoryRunsPackBalanceAdapter();
  if (opts.packRuns) await runsPackBalance.addPackRuns("u1", opts.packRuns);
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(
      undefined,
      opts.approved === false ? undefined : { approvedBy: "test-operator" },
    ),
    checkout: opts.checkout ?? null,
    codeRunsBalance,
    runsPackBalance,
  });
  return { gate, codeRunsBalance, runsPackBalance };
}

function unboundGate(opts: { approved?: boolean } = {}) {
  return new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(
      undefined,
      opts.approved === false ? undefined : { approvedBy: "test-operator" },
    ),
    checkout: null,
  });
}

describe("native gate: code-runs coverage (#3307 slice 2)", () => {
  it("a code-runs balance covers the run after price resolution, spending exactly one code run", async () => {
    const { gate, codeRunsBalance } = await codeGate({ codeRuns: 3 });
    const acct = account();
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toEqual({
      allowed: true,
      status: "paid",
      runRequestId: "run-1",
      priceUSD: 0.1,
      paidVia: "code_runs",
      productId: "prod-per-run-goal",
      versionId: "cat-goal-default-v1",
    });
    expect(await codeRunsBalance.getBalance("u1")).toBe(2);
    expect(acct.creditsUSD).toBe(0);
  });

  it("a code-runs balance covers a scheduled run too (coverage satisfies the coverage-only rule)", async () => {
    const { gate, codeRunsBalance } = await codeGate({ codeRuns: 2 });
    const decision = await gate.check({
      id: "run-1",
      family: "goal",
      trigger: "scheduled",
      scheduleKind: "recurring",
      account: account(),
    });
    expect(decision).toMatchObject({ allowed: true, paidVia: "code_runs" });
    expect(await codeRunsBalance.getBalance("u1")).toBe(1);
  });

  it("subscription included runs win over code runs: the code balance is untouched", async () => {
    const { gate, codeRunsBalance } = await codeGate({ codeRuns: 3 });
    const acct = account({ tier: "Subscribed", includedRunsRemaining: 2 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "subscription_included" });
    expect(acct.includedRunsRemaining).toBe(1);
    expect(await codeRunsBalance.getBalance("u1")).toBe(3);
  });

  it("code runs win over the runs-pack balance: the pack balance is untouched", async () => {
    const { gate, codeRunsBalance, runsPackBalance } = await codeGate({ codeRuns: 2, packRuns: 2 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(decision).toMatchObject({ allowed: true, paidVia: "code_runs" });
    expect(await codeRunsBalance.getBalance("u1")).toBe(1);
    expect(await runsPackBalance.getBalance("u1")).toBe(2);
  });

  it("an empty code balance falls through to the pack balance", async () => {
    const { gate, runsPackBalance } = await codeGate({ codeRuns: 0, packRuns: 2 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(decision).toMatchObject({ allowed: true, paidVia: "runs_pack" });
    expect(await runsPackBalance.getBalance("u1")).toBe(1);
  });

  it("code runs win over credits: credits are untouched", async () => {
    const { gate, codeRunsBalance } = await codeGate({ codeRuns: 2 });
    const acct = account({ creditsUSD: 5 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "code_runs" });
    expect(acct.creditsUSD).toBe(5);
    expect(await codeRunsBalance.getBalance("u1")).toBe(1);
  });

  it("NQ7: a PROPOSED (unapproved) family price fails closed BEFORE the code balance is read", async () => {
    const { gate, codeRunsBalance } = await codeGate({ approved: false, codeRuns: 3 });
    await expect(
      gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() }),
    ).rejects.toThrow(/not approved/);
    expect(await codeRunsBalance.getBalance("u1")).toBe(3);
  });

  it("an unbound code-runs port leaves the pack path unchanged", async () => {
    const gate = unboundGate();
    const acct = account({ creditsUSD: 1 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "credits" });
    expect(acct.creditsUSD).toBe(0.9);
  });

  it("an empty code balance falls through to credits", async () => {
    const { gate, codeRunsBalance } = await codeGate({ codeRuns: 0 });
    const acct = account({ creditsUSD: 1 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "credits" });
    expect(await codeRunsBalance.getBalance("u1")).toBe(0);
  });

  it("a code-runs store error falls through to credits (fail-closed, never a free run on a blip)", async () => {
    const throwingBalance = {
      getBalance: async () => 3,
      addCodeRuns: async () => 3,
      consumeCodeRun: async () => {
        throw new Error("store blip");
      },
    };
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
      checkout: null,
      codeRunsBalance: throwingBalance,
    });
    const acct = account({ creditsUSD: 1 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "credits" });
    expect(acct.creditsUSD).toBe(0.9);
  });

  it("a re-check of the same run id is already_paid and spends no second code run", async () => {
    const { gate, codeRunsBalance } = await codeGate({ codeRuns: 3 });
    const first = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(first).toMatchObject({ allowed: true, paidVia: "code_runs" });
    expect(await codeRunsBalance.getBalance("u1")).toBe(2);
    const again = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(again).toMatchObject({ allowed: true, status: "already_paid", paidVia: "code_runs" });
    expect(await codeRunsBalance.getBalance("u1")).toBe(2);
    expect((await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" })).status).toBe(
      "already_paid",
    );
    expect(await codeRunsBalance.getBalance("u1")).toBe(2);
  });
});
