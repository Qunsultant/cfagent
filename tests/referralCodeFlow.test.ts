// @vitest-environment node
/**
 * Issue #3307 (slice 2, sub-issue of #3241) — the D12
 * failure-credit guard in the payment workflow flow.
 *
 * A code-covered run is a FREE run: no charge was taken, so a
 * screener failure after the start must NOT mint a USD
 * replacement-run credit — that would convert a grant into
 * money. The flow skips the issue-failure-credit step for
 * paidVia "code_runs" and returns the honest status
 * "screener_failed_no_credit": no credit claim, no journal
 * credit, no balance re-credit, no failure-credit audit event.
 * Every other paidVia keeps the existing credit path.
 *
 * Harness mirrors tests/payment_workflow_flow.test.ts (#2087)
 * but drives the flow with the REAL native gate (in-memory
 * code-runs balance + approved catalogue price), because the
 * cfpay gate never returns paidVia "code_runs".
 */
import { describe, expect, it, vi } from "vitest";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import type { CommercialAccount } from "../src/services/cfpayMonetization";
import { NativeMonetizationGate } from "../src/services/nativeMonetization";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryCodeRunsBalanceAdapter } from "../src/data/inMemoryReferralCodeAdapter";

function fakeStep(): PaymentWorkflowStep {
  return {
    async waitForEvent(name: string) {
      if (name.includes("approval")) return { payload: { approved: true } };
      return { payload: { claimTxHash: "0xabc" } };
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

const baseParams: PaymentWorkflowParams = {
  runRequestId: "run-1",
  family: "goal",
  trigger: "manual",
  tenantId: "t1",
  userId: "u1",
  email: "u1@example.com",
};

async function codeCoveredDeps(opts: {
  codeRuns?: number;
  startScreener?: PaymentWorkflowDeps["startScreener"];
}): Promise<{
  deps: PaymentWorkflowDeps;
  events: Array<{ type: string }>;
  issueFailureCredit: ReturnType<typeof vi.fn>;
  consumeCoverage: ReturnType<typeof vi.fn>;
  codeRunsBalance: InMemoryCodeRunsBalanceAdapter;
}> {
  const codeRunsBalance = new InMemoryCodeRunsBalanceAdapter();
  if (opts.codeRuns) await codeRunsBalance.addCodeRuns("u1", opts.codeRuns);
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    checkout: null,
    codeRunsBalance,
  });
  const events: Array<{ type: string }> = [];
  const issueFailureCredit = vi.fn(async () => {});
  const consumeCoverage = vi.fn(async () => {});
  const account: CommercialAccount = {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "PayPerUse",
    creditsUSD: 0,
    includedRunsRemaining: 0,
  };
  const deps: PaymentWorkflowDeps = {
    gate,
    account,
    startScreener: opts.startScreener ?? (async (p) => ({ workflowId: `wf-${p.runRequestId}` })),
    recordEvent: async (e) => {
      events.push({ type: e.type });
    },
    issueFailureCredit,
    consumeCoverage,
  };
  return { deps, events, issueFailureCredit, consumeCoverage, codeRunsBalance };
}

describe("payment workflow flow: code-runs failure-credit guard (#3307 slice 2, D12)", () => {
  it("a code-covered run starts, and consumeCoverage is called with paidVia code_runs", async () => {
    const { deps, consumeCoverage } = await codeCoveredDeps({ codeRuns: 2 });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
    expect(out).toMatchObject({ paidVia: "code_runs" });
    expect(consumeCoverage).toHaveBeenCalledWith({ userId: "u1", paidVia: "code_runs", priceUSD: 0.1 });
  });

  it("a failed code-covered run issues NO failure credit and returns screener_failed_no_credit", async () => {
    const { deps, events, issueFailureCredit, codeRunsBalance } = await codeCoveredDeps({
      codeRuns: 2,
      startScreener: async () => {
        throw new Error("screener boom");
      },
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("screener_failed_no_credit");
    expect(out).toMatchObject({ runRequestId: "run-1", screenerError: "screener boom" });
    expect(issueFailureCredit).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "payment.failure_credit_issued")).toBe(false);
    // The spent code run is NOT re-credited in v1 (D12).
    expect(await codeRunsBalance.getBalance("u1")).toBe(1);
  });

  it("a failed non-code run still issues the failure credit (guard is paidVia-scoped)", async () => {
    const { deps, issueFailureCredit } = await codeCoveredDeps({
      codeRuns: 0,
      startScreener: async () => {
        throw new Error("screener boom");
      },
    });
    // No code balance: the PayPerUse account with no credits and
    // no checkout mints a checkout instead — so give the account
    // credits to take the credits-covered path.
    deps.account = { ...deps.account, creditsUSD: 5 };
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("screener_failed_credit_issued");
    expect(issueFailureCredit).toHaveBeenCalledOnce();
  });
});
