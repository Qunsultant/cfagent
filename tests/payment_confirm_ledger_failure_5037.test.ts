import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  createCheckout: vi.fn(),
  executeRefund: vi.fn(),
}));

vi.mock("../src/data/createOrmPorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/createOrmPorts")>();
  return {
    ...actual,
    createOrmPorts: vi.fn(() => ({
      transactions: {
        findById: state.findById,
        update: state.update,
      },
    })),
  };
});

vi.mock("../src/services/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/payments")>();
  return {
    ...actual,
    PaymentGatewayService: vi.fn(function () {
      return {
        createCheckout: state.createCheckout,
        executeRefund: state.executeRefund,
      };
    }),
  };
});

import { createMAS } from "../src/agents/mas";

function makeMAS() {
  const auditCalls: Array<{ action: string; resource: string; detail: unknown }> = [];
  state.findById.mockReset().mockImplementation((id: string) => ({
    id,
    action: "charge",
    amount: 49.99,
    currency: "USD",
    customer: "alice@example.com",
    gateway: "stripe",
    status: "draft",
  }));
  state.update.mockReset().mockImplementation(() => ({}));
  state.createCheckout.mockReset().mockResolvedValue({
    checkoutUrl: "https://checkout.example/pay_1",
    gatewayRef: "gw_ref_123",
  });
  state.executeRefund.mockReset().mockResolvedValue({ refundId: "re_123" });

  const tools = createMAS({
    env: {} as any,
    sessionId: "alice",
    requestId: "req_5037",
    sql: { exec: () => [] as unknown[] },
    audit: (action, resource, detail) => {
      auditCalls.push({ action, resource: String(resource), detail });
    },
  });
  return { tools, auditCalls };
}

describe("Issue #5037 — confirmDraft fails loudly when ledger lookup or update fails", () => {
  it("fails with FAILURE_PAYMENT_LEDGER_LOOKUP_FAILED when findById throws and never calls gateway", async () => {
    const { tools, auditCalls } = makeMAS();
    state.findById.mockImplementation(() => {
      throw new Error("sqlite busy");
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_lookup_err", decision: "approved" }),
    ).rejects.toThrow("FAILURE_PAYMENT_LEDGER_LOOKUP_FAILED");

    expect(state.createCheckout).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => c.action === "payment.confirmed")).toBe(false);
    expect(auditCalls.some((c) => c.action === "payment.confirm_failed")).toBe(true);
  });

  it("fails with FAILURE_PAYMENT_DRAFT_NOT_FOUND when draft does not exist", async () => {
    const { tools, auditCalls } = makeMAS();
    state.findById.mockReturnValue(null);

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_missing", decision: "approved" }),
    ).rejects.toThrow("FAILURE_PAYMENT_DRAFT_NOT_FOUND");

    expect(state.createCheckout).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => c.action === "payment.confirmed")).toBe(false);
  });

  it("fails with FAILURE_PAYMENT_LEDGER_WRITE_FAILED and records payment.ledger_divergence when completed update fails after gateway charge", async () => {
    const { tools, auditCalls } = makeMAS();
    state.update.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_write_err", decision: "approved" }),
    ).rejects.toThrow("FAILURE_PAYMENT_LEDGER_WRITE_FAILED");

    expect(state.createCheckout).toHaveBeenCalledTimes(1);
    expect(auditCalls.some((c) => c.action === "payment.confirmed")).toBe(false);
    expect(
      auditCalls.some(
        (c) =>
          c.action === "payment.ledger_divergence" &&
          (c.detail as any)?.gatewayRef === "gw_ref_123" &&
          (c.detail as any)?.reconcileStatus === "pending_reconcile",
      ),
    ).toBe(true);
  });

  it("fails with FAILURE_PAYMENT_LEDGER_WRITE_FAILED when rejected update fails and never emits payment.rejected", async () => {
    const { tools, auditCalls } = makeMAS();
    state.update.mockImplementation(() => {
      throw new Error("constraint error");
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_reject_err", decision: "rejected" }),
    ).rejects.toThrow("FAILURE_PAYMENT_LEDGER_WRITE_FAILED");

    expect(auditCalls.some((c) => c.action === "payment.rejected")).toBe(false);
    expect(auditCalls.some((c) => c.action === "payment.reject_failed")).toBe(true);
  });
});
