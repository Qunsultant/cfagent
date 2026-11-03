// @vitest-environment node
/**
 * Issue #2945 (Monetization Phase 2.17, program #2405) — cfpay as a
 * separate channel: minimal wiring within the card's actual operations.
 *
 * TDD: this file is written FIRST. It fails until the channel service
 * lands. The card (ADR 0026, fetched live 2026-11-02) publishes NO
 * response schemas, so every retrieve judgment here is allowlist-based
 * and fail-closed: paid statuses are an explicit allowlist, requestId /
 * email mismatches refuse, and no amount is ever read from a guessed
 * cfpay field. Price protection is the approved catalogue price plus
 * the operator-attested channel fixed price at mint, plus totals-level
 * reconciliation — never an assumed amount.
 */
import { describe, expect, it, vi } from "vitest";
import {
  confirmChannelPurchase,
  mintChannelPurchase,
  reconcileChannel,
  type CfpayChannelClient,
  type ChannelDraft,
  type ChannelDraftStore,
} from "../src/services/cfpayChannel";
import { BusinessError } from "../src/outcomes/outcomeAspects";

class MemoryDrafts implements ChannelDraftStore {
  readonly rows = new Map<string, ChannelDraft>();
  async createDraft(draft: ChannelDraft): Promise<ChannelDraft> {
    this.rows.set(draft.id, { ...draft });
    return { ...draft };
  }
  async getDraft(id: string): Promise<ChannelDraft | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async markFulfilled(
    id: string,
    update: { fulfilledAtMs: number; paymentIntentId: string | null; fulfilSkippedReason: string | null },
  ): Promise<ChannelDraft> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown channel draft ${id}.`);
    const next: ChannelDraft = { ...row, status: "fulfilled", ...update };
    this.rows.set(id, next);
    return { ...next };
  }
  async listFulfilled(): Promise<ChannelDraft[]> {
    return [...this.rows.values()].filter((d) => d.status === "fulfilled").map((d) => ({ ...d }));
  }
  async listByUser(userLogin: string): Promise<ChannelDraft[]> {
    return [...this.rows.values()].filter((d) => d.userLogin === userLogin).map((d) => ({ ...d }));
  }
}

function stubClient(overrides: Partial<CfpayChannelClient> = {}): CfpayChannelClient & {
  calls: { create: unknown[]; status: unknown[]; fulfil: unknown[] };
} {
  const calls: { create: unknown[]; status: unknown[]; fulfil: unknown[] } = { create: [], status: [], fulfil: [] };
  const base: CfpayChannelClient = {
    createCheckout: async (input) => {
      calls.create.push(input);
      return { ok: true, data: { ok: true, requestId: input.requestId, status: "created" } };
    },
    getStatus: async (requestId) => {
      calls.status.push(requestId);
      return { ok: true, data: { ok: true, requestId, status: "paid" } };
    },
    fulfil: async (requestId, paymentIntentId) => {
      calls.fulfil.push({ requestId, paymentIntentId });
      return { ok: true, data: { ok: true, requestId, status: "fulfilled" } };
    },
    listPayments: async () => ({ ok: true, data: { ok: true, payments: [] } }),
    paymentsTotals: async () => ({ ok: true, data: { ok: true, total: 0 } }),
  };
  return { ...base, ...overrides, calls };
}

function catalogue(approved: Record<string, number | null>) {
  return { getApprovedPrice: async (family: string) => approved[family] ?? null };
}

function mintedDraft(overrides: Partial<ChannelDraft> = {}): ChannelDraft {
  return {
    id: "cfpay-draft-1",
    userLogin: "u1",
    tenantId: "u1",
    email: "u1@example.test",
    family: "options",
    expectedPriceUSD: 0.05,
    status: "minted",
    createdAtMs: 1000,
    fulfilledAtMs: null,
    paymentIntentId: null,
    fulfilSkippedReason: null,
    ...overrides,
  };
}

describe("mintChannelPurchase", () => {
  it("mints a draft and calls checkout.create with the draft id as request and requestId", async () => {
    const drafts = new MemoryDrafts();
    const cfpay = stubClient();
    const { draft, cfpay: cfpayData } = await mintChannelPurchase(
      { drafts, catalogue: catalogue({ options: 0.05 }), channelFixedPriceUSD: 0.05, cfpay },
      { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "options" },
    );
    expect(draft.id.startsWith("cfpay-")).toBe(true);
    expect(draft.status).toBe("minted");
    expect(draft.expectedPriceUSD).toBe(0.05);
    expect(cfpay.calls.create).toEqual([{ requestId: draft.id, email: "u1@example.test", request: draft.id }]);
    expect(cfpayData).toEqual({ ok: true, requestId: draft.id, status: "created" });
    expect(await drafts.getDraft(draft.id)).not.toBeNull();
  });

  it("refuses when no approved catalogue price exists (proposed seeds never charge)", async () => {
    const drafts = new MemoryDrafts();
    await expect(
      mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: null }), channelFixedPriceUSD: 0.05, cfpay: stubClient() },
        { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "options" },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_NOT_CONFIGURED" });
    expect(drafts.rows.size).toBe(0);
  });

  it("refuses when the operator has not attested a channel fixed price", async () => {
    const drafts = new MemoryDrafts();
    await expect(
      mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: 0.05 }), channelFixedPriceUSD: null, cfpay: stubClient() },
        { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "options" },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_NOT_CONFIGURED" });
    expect(drafts.rows.size).toBe(0);
  });

  it("refuses when the catalogue price does not equal the attested channel price", async () => {
    const drafts = new MemoryDrafts();
    await expect(
      mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: 0.05 }), channelFixedPriceUSD: 0.02, cfpay: stubClient() },
        { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "options" },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_PRICE_MISMATCH" });
    expect(drafts.rows.size).toBe(0);
  });

  it("refuses an invalid family and a bad email, and never persists a draft when cfpay fails", async () => {
    const drafts = new MemoryDrafts();
    await expect(
      mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: 0.05 }), channelFixedPriceUSD: 0.05, cfpay: stubClient() },
        { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "bogus" },
      ),
    ).rejects.toThrow(/Invalid price family/);
    await expect(
      mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: 0.05 }), channelFixedPriceUSD: 0.05, cfpay: stubClient() },
        { userLogin: "u1", tenantId: "u1", email: "not-an-email", family: "options" },
      ),
    ).rejects.toThrow(/email is required/);
    const failing = stubClient({ createCheckout: async () => ({ ok: false, error: "HTTP 500" }) });
    await expect(
      mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: 0.05 }), channelFixedPriceUSD: 0.05, cfpay: failing },
        { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "options" },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_UNAVAILABLE" });
    expect(drafts.rows.size).toBe(0);
  });
});

describe("confirmChannelPurchase", () => {
  function setup(overrides: { client?: CfpayChannelClient; draft?: ChannelDraft } = {}) {
    const drafts = new MemoryDrafts();
    const draft = mintedDraft(overrides.draft);
    drafts.rows.set(draft.id, { ...draft });
    const cfpay = overrides.client ?? stubClient();
    const adjustCredits = vi.fn(async (userId: string, delta: number) => ({ userId, creditsUSD: delta }));
    const recordTransaction = vi.fn(async () => ({ id: `tx_${draft.id}` }));
    const audit = vi.fn();
    return { drafts, cfpay, adjustCredits, recordTransaction, audit, draft };
  }

  it("fulfils on a paid retrieve: fulfil called with the status payment intent, credit topped up, tx recorded", async () => {
    const paidWithIntent = stubClient({
      getStatus: async (requestId) => ({
        ok: true,
        data: { ok: true, requestId, status: "paid", paymentIntentId: "pi_test_1" },
      }),
    });
    const s = setup({ client: paidWithIntent });
    const out = await confirmChannelPurchase(
      { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
      { userLogin: "u1", channelRequestId: s.draft.id },
    );
    expect(out.draft.status).toBe("fulfilled");
    expect(out.draft.paymentIntentId).toBe("pi_test_1");
    expect(out.draft.fulfilSkippedReason).toBeNull();
    expect(s.cfpay.calls.fulfil).toEqual([{ requestId: s.draft.id, paymentIntentId: "pi_test_1" }]);
    expect(s.adjustCredits).toHaveBeenCalledWith("u1", 0.05);
    expect(s.recordTransaction).toHaveBeenCalledTimes(1);
    expect(s.audit).toHaveBeenCalledWith(
      "commercial.channel.fulfilled",
      expect.objectContaining({ channelRequestId: s.draft.id, userId: "u1" }),
    );
  });

  it("fulfils without a payment intent: fulfil skipped for a stated reason, credit still granted", async () => {
    const s = setup();
    const out = await confirmChannelPurchase(
      { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
      { userLogin: "u1", channelRequestId: s.draft.id },
    );
    expect(out.draft.status).toBe("fulfilled");
    expect(out.draft.fulfilSkippedReason).toBe("no_payment_intent");
    expect(s.cfpay.calls.fulfil).toEqual([]);
    expect(s.adjustCredits).toHaveBeenCalledWith("u1", 0.05);
  });

  it("refuses unknown drafts, non-owners, and replays, with no side effects", async () => {
    const s = setup();
    await expect(
      confirmChannelPurchase(
        { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
        { userLogin: "u1", channelRequestId: "cfpay-nope" },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_UNKNOWN_PURCHASE" });
    await expect(
      confirmChannelPurchase(
        { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
        { userLogin: "u2", channelRequestId: s.draft.id },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_FORBIDDEN" });
    const fulfilled = setup({ draft: mintedDraft({ status: "fulfilled", fulfilledAtMs: 2000 }) });
    await expect(
      confirmChannelPurchase(
        { drafts: fulfilled.drafts, cfpay: fulfilled.cfpay, adjustCredits: fulfilled.adjustCredits, recordTransaction: fulfilled.recordTransaction, audit: fulfilled.audit },
        { userLogin: "u1", channelRequestId: fulfilled.draft.id },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_REPLAY" });
    expect(s.adjustCredits).not.toHaveBeenCalled();
    expect(s.recordTransaction).not.toHaveBeenCalled();
  });

  it("refuses unpaid, unknown-vocabulary, requestId-mismatched, and email-mismatched retrieves", async () => {
    const cases: Array<{ data: unknown; code: string }> = [
      { data: { ok: true, requestId: "cfpay-draft-1", status: "unpaid" }, code: "FAILURE_CHANNEL_NOT_PAID" },
      { data: { ok: true, requestId: "cfpay-draft-1", status: "mystery_state" }, code: "FAILURE_CHANNEL_NOT_PAID" },
      { data: { ok: true, requestId: "cfpay-other", status: "paid" }, code: "FAILURE_CHANNEL_NOT_PAID" },
      { data: { ok: true, requestId: "cfpay-draft-1", status: "paid", email: "someone-else@example.test" }, code: "FAILURE_CHANNEL_NOT_PAID" },
    ];
    for (const c of cases) {
      const client = stubClient({ getStatus: async () => ({ ok: true, data: c.data }) });
      const s = setup({ client });
      await expect(
        confirmChannelPurchase(
          { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
          { userLogin: "u1", channelRequestId: s.draft.id },
        ),
      ).rejects.toMatchObject({ code: c.code });
      expect(s.adjustCredits).not.toHaveBeenCalled();
      expect(s.recordTransaction).not.toHaveBeenCalled();
    }
  });

  it("accepts every documented paid vocabulary, and refuses a failed fulfil with no credit", async () => {
    for (const status of ["paid", "completed", "fulfilled", "succeeded", "PAID"]) {
      const client = stubClient({ getStatus: async (requestId) => ({ ok: true, data: { ok: true, requestId, status } }) });
      const s = setup({ client });
      const out = await confirmChannelPurchase(
        { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
        { userLogin: "u1", channelRequestId: s.draft.id },
      );
      expect(out.draft.status).toBe("fulfilled");
    }
    const failFulfil = stubClient({
      getStatus: async (requestId) => ({ ok: true, data: { ok: true, requestId, status: "paid", paymentIntentId: "pi_test_9" } }),
      fulfil: async () => ({ ok: false, error: "HTTP 500" }),
    });
    const s = setup({ client: failFulfil });
    await expect(
      confirmChannelPurchase(
        { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
        { userLogin: "u1", channelRequestId: s.draft.id },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_FULFIL_FAILED" });
    expect(s.adjustCredits).not.toHaveBeenCalled();
    expect(s.recordTransaction).not.toHaveBeenCalled();
    expect((await s.drafts.getDraft(s.draft.id))?.status).toBe("minted");
  });

  it("refuses when the cfpay retrieve itself is unavailable", async () => {
    const down = stubClient({ getStatus: async () => ({ ok: false, error: "HTTP 503" }) });
    const s = setup({ client: down });
    await expect(
      confirmChannelPurchase(
        { drafts: s.drafts, cfpay: s.cfpay, adjustCredits: s.adjustCredits, recordTransaction: s.recordTransaction, audit: s.audit },
        { userLogin: "u1", channelRequestId: s.draft.id },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_CHANNEL_UNAVAILABLE" });
    expect(s.adjustCredits).not.toHaveBeenCalled();
  });
});

describe("reconcileChannel", () => {
  function fulfilledDrafts(n: number, price: number): ChannelDraftStore {
    const drafts = new MemoryDrafts();
    for (let i = 0; i < n; i++) {
      drafts.rows.set(`cfpay-r${i}`, mintedDraft({ id: `cfpay-r${i}`, status: "fulfilled", fulfilledAtMs: 2000, expectedPriceUSD: price }));
    }
    return drafts;
  }

  it("reports match when extractable cfpay totals agree with local fulfilled totals", async () => {
    const out = await reconcileChannel({
      drafts: fulfilledDrafts(2, 0.05),
      cfpay: stubClient({ paymentsTotals: async () => ({ ok: true, data: { ok: true, total: 0.1 } }) }),
    });
    expect(out.verdict).toBe("match");
    expect(out.local).toEqual({ count: 2, totalUSD: 0.1 });
  });

  it("reports mismatch when extractable cfpay totals disagree", async () => {
    const out = await reconcileChannel({
      drafts: fulfilledDrafts(2, 0.05),
      cfpay: stubClient({ paymentsTotals: async () => ({ ok: true, data: { ok: true, total: 0.07 } }) }),
    });
    expect(out.verdict).toBe("mismatch");
    expect(out.local.totalUSD).toBe(0.1);
  });

  it("reports unverifiable when cfpay totals expose no comparable number, with the payload verbatim", async () => {
    const payload = { ok: true, note: "totals live elsewhere" };
    const out = await reconcileChannel({
      drafts: fulfilledDrafts(1, 0.05),
      cfpay: stubClient({ paymentsTotals: async () => ({ ok: true, data: payload }) }),
    });
    expect(out.verdict).toBe("unverifiable");
    expect(out.cfpay.totals).toEqual(payload);
  });

  it("reports unverifiable when the cfpay totals call itself fails", async () => {
    const out = await reconcileChannel({
      drafts: fulfilledDrafts(1, 0.05),
      cfpay: stubClient({ paymentsTotals: async () => ({ ok: false, error: "HTTP 503" }) }),
    });
    expect(out.verdict).toBe("unverifiable");
    expect(out.reason).toMatch(/totals unavailable/);
  });
});

describe("channel outcome codes resolve through the single resolver", () => {
  it("every channel code used by the service resolves to a catalog entry", async () => {
    const { resolveOutcome } = await import("../src/outcomes/outcomeAspects");
    for (const code of [
      "FAILURE_CHANNEL_NOT_CONFIGURED",
      "FAILURE_CHANNEL_PRICE_MISMATCH",
      "FAILURE_CHANNEL_NOT_PAID",
      "FAILURE_CHANNEL_REPLAY",
      "FAILURE_CHANNEL_UNAVAILABLE",
      "FAILURE_CHANNEL_FULFIL_FAILED",
      "FAILURE_CHANNEL_UNKNOWN_PURCHASE",
      "FAILURE_CHANNEL_FORBIDDEN",
      "SUCCESS_CHANNEL_PURCHASE_FULFILLED",
    ]) {
      expect(resolveOutcome(code).resolved).toBe(true);
    }
  });

  it("service failures carry their catalog code as BusinessError", async () => {
    const drafts = new MemoryDrafts();
    try {
      await mintChannelPurchase(
        { drafts, catalogue: catalogue({ options: null }), channelFixedPriceUSD: 0.05, cfpay: stubClient() },
        { userLogin: "u1", tenantId: "u1", email: "u1@example.test", family: "options" },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessError);
      expect((err as BusinessError).code).toBe("FAILURE_CHANNEL_NOT_CONFIGURED");
    }
  });
});
