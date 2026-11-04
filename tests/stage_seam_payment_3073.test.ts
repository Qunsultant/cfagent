/**
 * Issue #3073 - payment's seam: one boundary message per completed step.
 *
 * What these pins protect, in the order the failure modes bit us before:
 *   1. every declared payment step that RUNS emits exactly one boundary -
 *      so a new step cannot be added without a message;
 *   2. the message that arrives is family-tagged and references a real
 *      artifact key (persist-then-publish), not a bare "done";
 *   3. a broken queue never changes the payment's outcome.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PAYMENT_STEP_IDS,
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import { createStageBoundaryEmitter } from "../src/workflows/stageBoundaryEmitter";
import { STAGE_IDS_BY_FAMILY, STAGE_FAMILIES, stageMessage } from "../src/workflows/stageMessage";
import { STOCK_STAGE_IDS } from "../src/workflows/stageMessage";

const params = {
  runRequestId: "run-1",
  family: "stock",
  trigger: "manual",
  tenantId: "tenant-1",
  userId: "user-1",
  email: "owner@example.com",
  account: { tenantId: "tenant-1" },
} as unknown as PaymentWorkflowParams;

function fakeStep(): PaymentWorkflowStep & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    waitForEvent: async () => ({ payload: {} }),
    do: async <T,>(name: string, fn: () => Promise<T>) => {
      ran.push(name);
      return fn();
    },
  };
}

const freeDeps = (boundaries: string[]) =>
  ({
    account: { tenantId: "tenant-1" },
    gate: { check: async () => ({ status: "free", priceUSD: 0 }) },
    recordEvent: async () => undefined,
    consumeCoverage: async () => undefined,
    startScreener: async () => ({ workflowId: "wf-1" }),
    issueFailureCredit: async () => undefined,
    stageBoundary: async ({ stageId }: { stageId: string }) => {
      boundaries.push(stageId);
    },
  }) as unknown as PaymentWorkflowDeps;

describe("payment stage seam (#3073)", () => {
  it("emits one boundary per step that actually ran, in order", async () => {
    const boundaries: string[] = [];
    const step = fakeStep();
    await runPaymentWorkflowFlow(params, freeDeps(boundaries), step);
    expect(step.ran.length).toBeGreaterThan(0);
    expect(boundaries).toEqual(step.ran);
    for (const stageId of boundaries) expect(PAYMENT_STEP_IDS).toContain(stageId);
  });

  it("a throwing boundary emitter never changes the outcome", async () => {
    // The property is equivalence, not a particular verdict: whatever the flow
    // decides with a working seam, it must decide the same with a broken one.
    const baseline = await runPaymentWorkflowFlow(params, freeDeps([]), fakeStep());
    const deps = freeDeps([]);
    (deps as unknown as { stageBoundary: () => Promise<void> }).stageBoundary = async () => {
      throw new Error("queue down");
    };
    const broken = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(broken).toEqual(baseline);
  });
});

describe("the family seam (#3073)", () => {
  it("every family has a declared id set, and stock's matches STOCK_STAGE_IDS", () => {
    expect(STAGE_IDS_BY_FAMILY.stock).toEqual([...STOCK_STAGE_IDS]);
    for (const family of STAGE_FAMILIES) {
      expect(STAGE_IDS_BY_FAMILY[family].length).toBeGreaterThan(0);
    }
  });

  it("refuses a stage id that does not belong to the declared family", () => {
    expect(() =>
      stageMessage({
        runId: "run-1",
        family: "payment",
        stageId: "plan",
        artifactKeys: ["k"],
        userLogin: "owner",
      }),
    ).toThrow(/not a declared payment stage id/);
  });

  it("namespaces non-stock idempotency keys and keeps stock's historical shape", () => {
    const stock = stageMessage({
      runId: "run-1",
      stageId: "plan",
      artifactKeys: ["k"],
      userLogin: "owner",
    });
    expect(stock.idempotencyKey).toBe("run-1::plan");
    const payment = stageMessage({
      runId: "run-1",
      family: "payment",
      stageId: "gate-check",
      artifactKeys: ["k"],
      userLogin: "owner",
    });
    expect(payment.idempotencyKey).toBe("run-1::payment::gate-check");
  });

  it("publishes a family-tagged message referencing the step's durable record", async () => {
    const sent: Array<{ family?: string; stageId: string; artifactKeys: string[] }> = [];
    const emit = createStageBoundaryEmitter({
      family: "payment",
      runId: "run-1",
      userLogin: "owner@example.com",
      queue: { send: async (body: unknown) => sent.push(body as never) },
      warn: () => undefined,
    });
    await expect(emit({ stageId: "gate-check" })).resolves.toBe("published");
    expect(sent[0]?.family).toBe("payment");
    expect(sent[0]?.stageId).toBe("gate-check");
    expect(sent[0]?.artifactKeys[0]).toBe("workflow:payment:run-1:gate-check");
  });

  it("degrades to a logged skip when no queue is bound, without throwing", async () => {
    const warn = vi.fn();
    const emit = createStageBoundaryEmitter({
      family: "payment",
      runId: "run-1",
      userLogin: "owner@example.com",
      queue: null,
      warn,
    });
    await expect(emit({ stageId: "gate-check" })).resolves.toBe("skipped");
    expect(warn).toHaveBeenCalled();
  });

  it("reports a malformed boundary instead of throwing it into the flow", async () => {
    const warn = vi.fn();
    const emit = createStageBoundaryEmitter({
      family: "payment",
      runId: "run-1",
      userLogin: "owner@example.com",
      queue: { send: async () => undefined },
      warn,
    });
    await expect(emit({ stageId: "not-a-payment-step" })).resolves.toBe("malformed");
    expect(warn).toHaveBeenCalled();
  });
});
