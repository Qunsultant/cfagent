// @vitest-environment node
/**
 * Issue #3246 (slice 3, sub-issue of #3241) — runs-pack coverage
 * in the native monetization gate.
 *
 * Coverage order (after the grant/Free-allowance branches and
 * after price resolution): subscription included runs first,
 * then the runs-pack balance, then credits, then checkout. A
 * pack run is spent at decision time, inside the gate, and only
 * after price resolution — so a pack never covers a run whose
 * family price is missing or unapproved (NQ7, fail-closed).
 * The pack is family-agnostic: the same balance covers any
 * family's run, once that family's price is approved.
 */
import { describe, expect, it } from "vitest";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
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

async function packGate(opts: { approved?: boolean; balance?: number; checkout?: CheckoutPorts | null } = {}) {
  const balance = new InMemoryRunsPackBalanceAdapter();
  if (opts.balance) await balance.addPackRuns("u1", opts.balance);
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(
      undefined,
      opts.approved === false ? undefined : { approvedBy: "test-operator" },
    ),
    checkout: opts.checkout ?? null,
    runsPackBalance: balance,
  });
  return { gate, balance };
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

describe("native gate: runs-pack coverage (#3246 slice 3)", () => {
  it("a pack balance covers the run after price resolution, spending exactly one pack run", async () => {
    const { gate, balance } = await packGate({ balance: 3 });
    const acct = account();
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toEqual({
      allowed: true,
      status: "paid",
      runRequestId: "run-1",
      priceUSD: 0.1,
      paidVia: "runs_pack",
      productId: "prod-per-run-goal",
      versionId: "cat-goal-default-v1",
    });
    expect(await balance.getBalance("u1")).toBe(2);
    expect(acct.creditsUSD).toBe(0);
  });

  it("a pack balance covers a scheduled run too (coverage satisfies the coverage-only rule)", async () => {
    const { gate, balance } = await packGate({ balance: 2 });
    const decision = await gate.check({
      id: "run-1",
      family: "goal",
      trigger: "scheduled",
      scheduleKind: "recurring",
      account: account(),
    });
    expect(decision).toMatchObject({ allowed: true, paidVia: "runs_pack" });
    expect(await balance.getBalance("u1")).toBe(1);
  });

  it("subscription included runs win over the pack: the pack balance is untouched", async () => {
    const { gate, balance } = await packGate({ balance: 3 });
    const acct = account({ tier: "Subscribed", includedRunsRemaining: 2 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "subscription_included" });
    expect(acct.includedRunsRemaining).toBe(1);
    expect(await balance.getBalance("u1")).toBe(3);
  });

  it("the pack wins over credits: credits are untouched", async () => {
    const { gate, balance } = await packGate({ balance: 2 });
    const acct = account({ creditsUSD: 5 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "runs_pack" });
    expect(acct.creditsUSD).toBe(5);
    expect(await balance.getBalance("u1")).toBe(1);
  });

  it("NQ7: a PROPOSED (unapproved) family price fails closed BEFORE the pack is read", async () => {
    const { gate, balance } = await packGate({ approved: false, balance: 3 });
    await expect(
      gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() }),
    ).rejects.toThrow(/not approved/);
    expect(await balance.getBalance("u1")).toBe(3);
  });

  it("an unbound pack port leaves the credits path unchanged", async () => {
    const gate = unboundGate();
    const acct = account({ creditsUSD: 1 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "credits" });
    expect(acct.creditsUSD).toBe(0.9);
  });

  it("an empty pack balance falls through to credits", async () => {
    const { gate, balance } = await packGate({ balance: 0 });
    const acct = account({ creditsUSD: 1 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: acct });
    expect(decision).toMatchObject({ allowed: true, paidVia: "credits" });
    expect(await balance.getBalance("u1")).toBe(0);
  });

  it("a re-check of the same run id is already_paid and spends no second pack run", async () => {
    const { gate, balance } = await packGate({ balance: 3 });
    const first = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(first).toMatchObject({ allowed: true, paidVia: "runs_pack" });
    expect(await balance.getBalance("u1")).toBe(2);
    const again = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(again).toMatchObject({ allowed: true, status: "already_paid", paidVia: "runs_pack" });
    expect(await balance.getBalance("u1")).toBe(2);
    expect((await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" })).status).toBe(
      "already_paid",
    );
    expect(await balance.getBalance("u1")).toBe(2);
  });
});
