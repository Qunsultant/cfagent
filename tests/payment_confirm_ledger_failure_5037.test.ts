import { describe, expect, it, vi } from "vitest";
import { createMasTools } from "../src/agents/mas";

function makeDeps(overrides: {
  findById?: (id: string) => any;
  update?: (id: string, patch: any) => any;
  createCheckout?: (args: any) => Promise<any>;
} = {}) {
  const auditCalls: Array<{ action: string; resource: string; detail: unknown }> = [];
  const audit = vi.fn((action: string, resource: string, detail: unknown) => {
    auditCalls.push({ action, resource, detail });
  });
  const ormPorts = {
    transactions: {
      findById: vi.fn(
        overrides.findById ??
          ((id: string) => ({
            id,
            action: "charge",
            amount: 49.99,
            currency: "USD",
            customer: "alice@example.com",
            gateway: "stripe",
            status: "draft",
          })),
      ),
      update: vi.fn(overrides.update ?? (() => ({}))),
    },
  } as any;
  const paymentGateway = {
    createCheckout: vi.fn(
      overrides.createCheckout ??
        (async () => ({
          checkoutUrl: "https://checkout.example/pay_1",
          gatewayRef: "gw_ref_123",
        })),
    ),
    executeRefund: vi.fn(async () => ({ refundId: "re_123" })),
  } as any;
  const tools = createMasTools({
    sessionId: "alice",
    userDid: "did:web:alice",
    ormPorts,
    paymentGateway,
    audit,
  } as any);
  return { tools, ormPorts, paymentGateway, auditCalls };
}

describe("Issue #5037 — confirmDraft fails loudly when ledger lookup or update fails", () => {
  it("fails with FAILURE_PAYMENT_LEDGER_LOOKUP_FAILED when findById throws and never calls gateway", async () => {
    const { tools, paymentGateway, auditCalls } = makeDeps({
      findById: () => {
        throw new Error("sqlite busy");
      },
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_lookup_err", decision: "approved" }),
    ).rejects.toThrow("FAILURE_PAYMENT_LEDGER_LOOKUP_FAILED");

    expect(paymentGateway.createCheckout).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => c.action === "payment.confirmed")).toBe(false);
    expect(auditCalls.some((c) => c.action === "payment.confirm_failed")).toBe(true);
  });

  it("fails with FAILURE_PAYMENT_DRAFT_NOT_FOUND when draft does not exist", async () => {
    const { tools, paymentGateway, auditCalls } = makeDeps({
      findById: () => null,
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_missing", decision: "approved" }),
    ).rejects.toThrow("FAILURE_PAYMENT_DRAFT_NOT_FOUND");

    expect(paymentGateway.createCheckout).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => c.action === "payment.confirmed")).toBe(false);
  });

  it("fails with FAILURE_PAYMENT_LEDGER_WRITE_FAILED and records payment.ledger_divergence when completed update fails after gateway charge", async () => {
    const { tools, paymentGateway, auditCalls } = makeDeps({
      update: () => {
        throw new Error("disk full");
      },
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_write_err", decision: "approved" }),
    ).rejects.toThrow("FAILURE_PAYMENT_LEDGER_WRITE_FAILED");

    expect(paymentGateway.createCheckout).toHaveBeenCalledTimes(1);
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
    const { tools, auditCalls } = makeDeps({
      update: () => {
        throw new Error("constraint error");
      },
    });

    await expect(
      (tools.confirmDraft as any).execute({ draftId: "pay_reject_err", decision: "rejected" }),
    ).rejects.toThrow("FAILURE_PAYMENT_LEDGER_WRITE_FAILED");

    expect(auditCalls.some((c) => c.action === "payment.rejected")).toBe(false);
    expect(auditCalls.some((c) => c.action === "payment.reject_failed")).toBe(true);
  });
});
