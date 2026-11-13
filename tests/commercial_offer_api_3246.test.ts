/** @vitest-environment jsdom */
/**
 * Issue #3246 (sub-issue of #3241), slice 2 — offer fetchers and
 * the payload guard in src/client/commercialApi.ts.
 *
 * Pins: the offer routes' paths and bodies; the offerContext
 * contract (present on a mint call only when the purchase was
 * started from an offer, absent otherwise — the key must not even
 * appear on a plain checkout); the structural payload guard
 * (malformed payloads degrade to the fixed copy, never a crash).
 * No new purchase route anywhere: acceptance rides the EXISTING
 * subscription/top-up mint routes.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  getOfferCompare,
  isOfferPayloadView,
  isOfferTrigger,
  postOffer,
  postOfferDismiss,
  subscriptionCheckout,
  topUpCheckout,
  type OfferPayloadView,
} from "../src/client/commercialApi";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}

const calls: Call[] = [];
let responder: (url: string, init?: RequestInit) => unknown = () => ok({});

function installFetch() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return responder(url, init);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  responder = () => ok({});
});

function validPayload(over: Partial<OfferPayloadView> = {}): OfferPayloadView {
  return {
    trigger: "manual_402",
    eligible: true,
    family: "stock",
    current: {
      effectiveTier: "Free",
      heldPlan: null,
      includedRunsRemaining: 0,
      packRunsRemaining: 0,
      creditsUSD: 0,
      freeRunsRemaining: 0,
      segment: "default",
    },
    targets: [],
    downgradeTargets: [],
    unavailableTargets: [],
    runsPacks: [],
    mentions: { referral: null, freeAccess: null },
    perRun: null,
    topUp: null,
    ...over,
  };
}

describe("offer triggers", () => {
  it("recognizes exactly the five server triggers", () => {
    for (const t of ["manual_402", "skip_notice", "trial_end", "quota_exhausted", "ambient"]) {
      expect(isOfferTrigger(t)).toBe(true);
    }
    expect(isOfferTrigger("checkout")).toBe(false);
    expect(isOfferTrigger("")).toBe(false);
    expect(isOfferTrigger(null)).toBe(false);
    expect(isOfferTrigger(42)).toBe(false);
  });
});

describe("offer fetchers", () => {
  it("POSTs /offer with trigger, family, and runRequestId when present", async () => {
    installFetch();
    responder = () => ok(validPayload());
    await postOffer({ trigger: "manual_402", family: "stock", runRequestId: "run-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/payments/agentic/commercial/offer");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ trigger: "manual_402", family: "stock", runRequestId: "run-1" });
  });

  it("omits runRequestId from the /offer body when absent", async () => {
    installFetch();
    responder = () => ok(validPayload());
    await postOffer({ trigger: "quota_exhausted", family: "goal" });
    expect(calls[0].body).toEqual({ trigger: "quota_exhausted", family: "goal" });
    expect(calls[0].body).not.toHaveProperty("runRequestId");
  });

  it("GETs /offer/compare with the family query when given, bare otherwise", async () => {
    installFetch();
    responder = () => ok(validPayload({ trigger: "ambient" }));
    await getOfferCompare("options");
    await getOfferCompare();
    expect(calls[0].url).toBe("/api/payments/agentic/commercial/offer/compare?family=options");
    expect(calls[0].method).toBeUndefined();
    expect(calls[1].url).toBe("/api/payments/agentic/commercial/offer/compare");
  });

  it("POSTs /offer/dismiss with trigger and family", async () => {
    installFetch();
    responder = () => ok({ suppressedUntilMs: 123 });
    const res = await postOfferDismiss({ trigger: "manual_402", family: "stock" });
    expect(res).toEqual({ suppressedUntilMs: 123 });
    expect(calls[0].url).toBe("/api/payments/agentic/commercial/offer/dismiss");
    expect(calls[0].body).toEqual({ trigger: "manual_402", family: "stock" });
  });

  it("surfaces the HTTP status on an offer failure", async () => {
    installFetch();
    responder = () => err(503);
    await expect(postOffer({ trigger: "manual_402", family: "stock" })).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("offerContext on the existing mint routes", () => {
  it("subscription checkout carries offerContext when provided", async () => {
    installFetch();
    responder = () => ok({ checkoutRequestId: "c1", checkoutUrl: "https://x", checkoutSessionId: "s1", plan: {} });
    await subscriptionCheckout({
      planId: "plan-1",
      email: "u@example.com",
      offerContext: { trigger: "manual_402", shownAtMs: 999 },
    });
    expect(calls[0].url).toBe("/api/payments/agentic/commercial/subscription/checkout");
    expect(calls[0].body).toEqual({
      planId: "plan-1",
      email: "u@example.com",
      offerContext: { trigger: "manual_402", shownAtMs: 999 },
    });
  });

  it("plain subscription checkout sends NO offerContext key at all", async () => {
    installFetch();
    responder = () => ok({ checkoutRequestId: "c1", checkoutUrl: "https://x", checkoutSessionId: "s1", plan: {} });
    await subscriptionCheckout({ planId: "plan-1", email: "u@example.com" });
    expect(calls[0].body).toEqual({ planId: "plan-1", email: "u@example.com" });
    expect(calls[0].body).not.toHaveProperty("offerContext");
  });

  it("top-up checkout carries offerContext when provided and omits it otherwise", async () => {
    installFetch();
    responder = () => ok({ topUpRequestId: "t1" });
    await topUpCheckout({ amountUSD: 10, rail: "card", email: "u@example.com", offerContext: { trigger: "ambient" } });
    expect(calls[0].url).toBe("/api/payments/agentic/commercial/top-up/checkout");
    expect(calls[0].body).toMatchObject({ offerContext: { trigger: "ambient" } });
    calls.length = 0;
    await topUpCheckout({ amountUSD: 10, rail: "card", email: "u@example.com" });
    expect(calls[0].body).not.toHaveProperty("offerContext");
  });
});

describe("isOfferPayloadView", () => {
  it("accepts a well-formed payload", () => {
    expect(isOfferPayloadView(validPayload())).toBe(true);
  });

  it("rejects non-objects, unknown triggers, and non-boolean eligibility", () => {
    expect(isOfferPayloadView(null)).toBe(false);
    expect(isOfferPayloadView("x")).toBe(false);
    expect(isOfferPayloadView({ ...validPayload(), trigger: "bogus" })).toBe(false);
    expect(isOfferPayloadView({ ...validPayload(), eligible: "yes" })).toBe(false);
  });

  it("rejects a missing or half-shaped current side", () => {
    const { current: _dropped, ...noCurrent } = validPayload();
    expect(isOfferPayloadView(noCurrent)).toBe(false);
    expect(
      isOfferPayloadView(validPayload({ current: { ...validPayload().current, creditsUSD: "0" as never } })),
    ).toBe(false);
    expect(
      isOfferPayloadView(
        validPayload({
          current: {
            ...validPayload().current,
            heldPlan: { planId: "p" } as never,
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects non-array target groups and malformed targets", () => {
    expect(isOfferPayloadView({ ...validPayload(), targets: null })).toBe(false);
    expect(
      isOfferPayloadView({ ...validPayload(), targets: [{ productId: "p" }] }),
    ).toBe(false);
    expect(
      isOfferPayloadView({ ...validPayload(), downgradeTargets: "none" }),
    ).toBe(false);
    expect(isOfferPayloadView({ ...validPayload(), mentions: null })).toBe(false);
  });

  it("accepts a held plan carrying currentPriceUSD, and rejects one missing it", () => {
    const heldPlan = {
      planId: "plan-basic-1",
      productId: "prod-basic",
      name: "Basic",
      heldPriceUSD: 44.99,
      currentPriceUSD: 49.99,
      billingPeriod: "monthly" as const,
      includedRuns: 20,
      periodEndMs: 1790000000000,
      billingManaged: false,
    };
    expect(
      isOfferPayloadView(validPayload({ current: { ...validPayload().current, heldPlan } })),
    ).toBe(true);
    expect(
      isOfferPayloadView(
        validPayload({
          current: { ...validPayload().current, heldPlan: { ...heldPlan, currentPriceUSD: null } },
        }),
      ),
    ).toBe(true);
    const { currentPriceUSD: _dropped, ...withoutCurrent } = heldPlan;
    expect(
      isOfferPayloadView(
        validPayload({ current: { ...validPayload().current, heldPlan: withoutCurrent as never } }),
      ),
    ).toBe(false);
  });

  it("rejects a malformed runsPack row and accepts a well-formed one", () => {
    const pack = {
      productId: "prod-pack-10",
      name: "Pack of 10",
      versionId: "packver-10",
      runs: 10,
      priceUSD: 4.99,
      effectiveFromMs: 1700000000000,
    };
    expect(isOfferPayloadView(validPayload({ runsPacks: [pack] }))).toBe(true);
    const { runs: _dropped, ...withoutRuns } = pack;
    expect(isOfferPayloadView(validPayload({ runsPacks: [withoutRuns as never] }))).toBe(false);
    expect(
      isOfferPayloadView(validPayload({ runsPacks: [{ ...pack, priceUSD: "4.99" as never }] })),
    ).toBe(false);
    expect(isOfferPayloadView({ ...validPayload(), runsPacks: "none" })).toBe(false);
  });
});
