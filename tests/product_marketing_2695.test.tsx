/** @vitest-environment jsdom */
/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
 *
 * TDD RED first: this suite imports src/data/productMarketing.ts,
 * src/agents/productCatalogRoute.ts, and
 * src/client/ProductCatalogPanel.tsx, none of which exist yet.
 *
 * The marketing layer is pure derivation over caller-supplied data:
 * teaser policy (cap, qualification filter, labeling, link honesty),
 * catalog display derivation (registry names, approved prices only,
 * Phase 3 parity shown as-is, purchase-path pointer or reason),
 * marketing draft composition + copy validation (verified-outcome
 * citations only, guaranteed-profit claims and dark patterns fail
 * closed, never published), funnel events + per-product success
 * metrics (null on empty denominators, never invented), and a
 * teaser email content builder (content only — no send, no trigger).
 * See PHASE4-INVENTORY.md for the reuse boundaries (ads #2658,
 * credits #2657, checkout #2656, lifecycle triggers #2659 all owned
 * elsewhere and NOT built here).
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  TEASER_CANDIDATE_CAP,
  buildTeaser,
  buildTeaserEmail,
  buildCatalogDisplay,
  composeMarketingDraft,
  validateMarketingCopy,
  buildFunnelEvent,
  buildProductSuccessMetrics,
  recordObservation,
  type CatalogDisplayEntry,
  type TeaserCandidateInput,
} from "../src/data/productMarketing";
import {
  buildProductCatalog,
  type ProductEntry,
} from "../src/data/productCatalogue";
import { resolveProductAccess } from "../src/data/productAccess";
import type { PriceEntry } from "../src/data/priceCataloguePorts";
import { handleProductCatalogRoute } from "../src/agents/productCatalogRoute";
import { ProductCatalogPanel } from "../src/client/ProductCatalogPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PRICE_FIXTURE: PriceEntry[] = [
  { family: "stock", priceUSD: 0.02, updatedAtMs: 1, approvalStatus: "approved", approvedBy: "op", approvedAtMs: 1 },
  { family: "goal", priceUSD: 0.1, updatedAtMs: 1, approvalStatus: "proposed", approvedBy: null, approvedAtMs: null },
  { family: "options", priceUSD: 0.05, updatedAtMs: 1, approvalStatus: "approved", approvedBy: "op", approvedAtMs: 1 },
  { family: "strategy", priceUSD: 0.1, updatedAtMs: 1, approvalStatus: "proposed", approvedBy: null, approvedAtMs: null },
];

function catalogEntry(id: string): ProductEntry {
  const entry = buildProductCatalog(PRICE_FIXTURE).find((e) => e.id === id);
  if (!entry) throw new Error(`no catalog entry ${id}`);
  return entry;
}

function candidates(n: number): TeaserCandidateInput[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `SYM${i}`,
    rank: i + 1,
    falsificationCriteria: [`falsified if SYM${i} breaches its level`],
    gatePassed: true,
  }));
}

describe("teaser policy (#2695)", () => {
  it("caps at TEASER_CANDIDATE_CAP in rank order", () => {
    const teaser = buildTeaser(candidates(5), "rank by composite score");
    expect(TEASER_CANDIDATE_CAP).toBe(3);
    expect(teaser.entries.map((e) => e.label)).toEqual(["SYM0", "SYM1", "SYM2"]);
    expect(teaser.cap).toBe(3);
    expect(teaser.totalSupplied).toBe(5);
  });

  it("sorts by rank ascending regardless of input order", () => {
    const input = [candidates(3)[2], candidates(3)[0], candidates(3)[1]];
    const teaser = buildTeaser(input, "rank by composite score");
    expect(teaser.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("excludes unqualified candidates and counts them", () => {
    const input: TeaserCandidateInput[] = [
      { label: "OK", rank: 1, falsificationCriteria: ["falsified if X"], gatePassed: true },
      { label: "NOPE", rank: 2, falsificationCriteria: [], gatePassed: true },
    ];
    const teaser = buildTeaser(input, "rank by composite score");
    expect(teaser.entries.map((e) => e.label)).toEqual(["OK"]);
    expect(teaser.excludedUnqualified).toBe(1);
  });

  it("excludes gate-failed candidates and counts them disjointly", () => {
    const input: TeaserCandidateInput[] = [
      { label: "OK", rank: 1, falsificationCriteria: ["falsified if X"], gatePassed: true },
      { label: "GATEFAIL", rank: 2, falsificationCriteria: [], gatePassed: false },
      { label: "GATEFAIL2", rank: 3, falsificationCriteria: ["falsified if Y"], gatePassed: false },
    ];
    const teaser = buildTeaser(input, "rank by composite score");
    expect(teaser.entries.map((e) => e.label)).toEqual(["OK"]);
    expect(teaser.excludedGateFailed).toBe(2);
    expect(teaser.excludedUnqualified).toBe(0);
  });

  it("labels every entry as a teaser and echoes criteria verbatim", () => {
    const teaser = buildTeaser(candidates(1), "rank by composite score");
    expect(teaser.entries[0].teaser).toBe(true);
    expect(teaser.entries[0].falsificationCriteria).toEqual(["falsified if SYM0 breaches its level"]);
    expect(teaser.rankingCriteria).toBe("rank by composite score");
  });

  it("refuses to build a teaser without stated ranking criteria", () => {
    expect(() => buildTeaser(candidates(1), "   ")).toThrow(/ranking criteria/);
  });

  it("honors an explicit cap override", () => {
    const teaser = buildTeaser(candidates(5), "rank by composite score", 1);
    expect(teaser.entries).toHaveLength(1);
    expect(teaser.cap).toBe(1);
  });
});

describe("teaser email content (#2695)", () => {
  it("states criteria, cap line, and teaser label; links only what is supplied", () => {
    const teaser = buildTeaser(candidates(5), "rank by composite score");
    const email = buildTeaserEmail("options", teaser, {
      fullReportUrl: "https://example.invalid/reports/r1",
      subscriptionUrl: null,
      referralCreditUrl: null,
    });
    expect(email.subject).toContain("options");
    expect(email.body).toContain("rank by composite score");
    expect(email.body).toContain("Showing 3 of 5 qualified candidates");
    expect(email.body).toContain("https://example.invalid/reports/r1");
    expect(email.body).not.toContain("Subscribe");
    expect(email.omittedLinks.map((l) => l.link)).toEqual(
      expect.arrayContaining(["subscription", "referral-credit"]),
    );
  });

  it("includes subscription and referral-credit links only when supplied", () => {
    const teaser = buildTeaser(candidates(1), "rank by composite score");
    const email = buildTeaserEmail("stock", teaser, {
      fullReportUrl: null,
      subscriptionUrl: "https://example.invalid/plans",
      referralCreditUrl: "https://example.invalid/refer",
    });
    expect(email.body).toContain("https://example.invalid/plans");
    expect(email.body).toContain("https://example.invalid/refer");
    expect(email.omittedLinks.map((l) => l.link)).toEqual(["full-report"]);
  });

  it("adds the digest-only unsubscribe footer only when a URL is supplied", () => {
    const teaser = buildTeaser(candidates(1), "rank by composite score");
    const withUrl = buildTeaserEmail("stock", teaser, {}, { unsubscribeUrl: "https://example.invalid/stop" });
    expect(withUrl.body).toContain("https://example.invalid/stop");
    expect(withUrl.body).toContain("Security mail about your account is unaffected");
    const withoutUrl = buildTeaserEmail("stock", teaser, {});
    expect(withoutUrl.body).not.toContain("stop digest mail");
  });
});

describe("catalog display derivation (#2695)", () => {
  it("gives a listed PayPerUse product a gate purchase path and a testnet price label", () => {
    const entry = catalogEntry("options:PayPerUse");
    const access = resolveProductAccess(entry, PRICE_FIXTURE);
    const [display] = buildCatalogDisplay([entry], [access]);
    expect(display.listed).toBe(true);
    expect(display.priceUSD).toBe(0.05);
    expect(display.priceSource).toBe("gate");
    expect(display.priceLabel).toContain("0.05");
    expect(display.realVsSimulated).toContain("testnet");
    expect(display.purchasePath?.route).toBe(entry.gateEndpoint);
    expect(display.parityVerdict).toBe("parity");
  });

  it("shows the stock divergence verdict as-is, never smoothed", () => {
    const entry = catalogEntry("stock:PayPerUse");
    const access = resolveProductAccess(entry, PRICE_FIXTURE);
    const [display] = buildCatalogDisplay([entry], [access]);
    expect(display.parityVerdict).toBe("divergent");
    expect(display.parityNotes.length).toBeGreaterThan(0);
  });

  it("gives an unlisted product no purchase path and its catalog reasons", () => {
    const entry = catalogEntry("goal:PayPerUse");
    expect(entry.listed).toBe(false);
    const access = resolveProductAccess(entry, PRICE_FIXTURE);
    const [display] = buildCatalogDisplay([entry], [access]);
    expect(display.purchasePath).toBeNull();
    expect(display.purchasePathReason).toContain("approved price");
    expect(display.priceUSD).toBeNull();
    expect(display.priceLabel).toBeNull();
  });

  it("points Subscribed at the existing plans surface, never a live recurring checkout claim", () => {
    const entry = catalogEntry("options:Subscribed");
    const access = resolveProductAccess(entry, PRICE_FIXTURE);
    const [display] = buildCatalogDisplay([entry], [access]);
    expect(display.purchasePath?.route).toBe("/payments/agentic/commercial/plans");
    expect(display.purchasePath?.note).toMatch(/2656/);
    expect(display.priceUSD).toBeNull();
  });

  it("gives Free no purchase path and the ungated reason", () => {
    const entry = catalogEntry("stock:Free");
    const access = resolveProductAccess(entry, PRICE_FIXTURE);
    const [display] = buildCatalogDisplay([entry], [access]);
    expect(display.purchasePath).toBeNull();
    expect(display.purchasePathReason).toContain("ungated discovery");
  });

  it("reports missing access records as unknown parity, never assumed", () => {
    const entry = catalogEntry("options:PayPerUse");
    const [display] = buildCatalogDisplay([entry], []);
    expect(display.parityVerdict).toBeNull();
    expect(display.parityNotes.join(" ")).toMatch(/no access record/);
  });
});

describe("marketing draft composition + copy validation (#2695)", () => {
  const listed = () => catalogEntry("options:PayPerUse");

  it("carries catalog identity, requires approval, and is never publishable", () => {
    const draft = composeMarketingDraft(listed(), "facebook");
    expect(draft.productName).toBe(listed().canonicalName);
    expect(draft.text).toContain(listed().canonicalName);
    expect(draft.text).toContain("0.05");
    expect(draft.requiresApproval).toBe(true);
    expect(draft.publishable).toBe(false);
    expect(draft.citation).toBeNull();
  });

  it("truncates a threads draft at the 500 limit", () => {
    const long = `x ${"word ".repeat(200)}`;
    const draft = composeMarketingDraft(listed(), "threads", { message: long });
    expect(draft.text.length).toBeLessThanOrEqual(500);
    expect(draft.truncated).toBe(true);
  });

  it("includes verified citations with source and drops unverified ones with a reason", () => {
    const verified = composeMarketingDraft(listed(), "instagram", {
      citation: { text: "Top-quartile outcome in backtest", verified: true, source: "mas_outcomes" },
    });
    expect(verified.citation?.text).toContain("Top-quartile");
    expect(verified.text).toContain("mas_outcomes");
    const unverified = composeMarketingDraft(listed(), "instagram", {
      citation: { text: "Amazing outcome", verified: false, source: "mas_outcomes" },
    });
    expect(unverified.citation).toBeNull();
    expect(unverified.citationOmittedReason).toMatch(/unverified/);
    expect(unverified.text).not.toContain("Amazing outcome");
  });

  it("rejects guaranteed-profit claims in the message and in citations, even when verified", () => {
    expect(() =>
      composeMarketingDraft(listed(), "facebook", { message: "guaranteed profits every week" }),
    ).toThrow(/guaranteed/);
    expect(() =>
      composeMarketingDraft(listed(), "facebook", {
        citation: { text: "guaranteed returns", verified: true, source: "mas_outcomes" },
      }),
    ).toThrow(/guaranteed/);
    expect(validateMarketingCopy("risk-free profit inside").ok).toBe(false);
    expect(validateMarketingCopy("See the screener catalog.").ok).toBe(true);
  });

  it("rejects fake-scarcity dark patterns", () => {
    expect(() =>
      composeMarketingDraft(listed(), "facebook", { message: "only 3 left, act now or lose out" }),
    ).toThrow();
    expect(validateMarketingCopy("Only 2 spots remaining!").ok).toBe(false);
  });

  it("refuses to advertise an unlisted product", () => {
    expect(() => composeMarketingDraft(catalogEntry("goal:PayPerUse"), "facebook")).toThrow(/unlisted/);
  });

  it("composes Slack drafts as text only, never a postable record", () => {
    const draft = composeMarketingDraft(listed(), "slack");
    expect(draft.channel).toBe("slack");
    expect(draft.publishable).toBe(false);
    expect(draft.truncated).toBe(false);
  });
});

describe("funnel events + success metrics (#2695)", () => {
  it("records stages and computes conversions, with null on empty denominators", () => {
    const events = [
      buildFunnelEvent("discover", "options:PayPerUse"),
      buildFunnelEvent("discover", "options:PayPerUse"),
      buildFunnelEvent("teaser", "options:PayPerUse"),
      buildFunnelEvent("first-run", "options:PayPerUse"),
      buildFunnelEvent("purchase", "options:PayPerUse"),
    ];
    const metrics = buildProductSuccessMetrics("options:PayPerUse", events);
    expect(metrics.discover).toBe(2);
    expect(metrics.teaser).toBe(1);
    expect(metrics.teaserToFirstRun).toBe(1);
    expect(metrics.purchaseToActivation).toBe(0);
    expect(buildProductSuccessMetrics("stock:PayPerUse", []).teaserToFirstRun).toBeNull();
    expect(buildProductSuccessMetrics("stock:PayPerUse", []).purchaseToActivation).toBeNull();
  });

  it("rejects unknown funnel stages", () => {
    expect(() => buildFunnelEvent("viral" as never, "options:PayPerUse")).toThrow(/stage/);
  });

  it("records observations as proposals only, refusing empty ones", () => {
    const record = recordObservation("options:PayPerUse", "teaser→first-run at 50%", "teaserToFirstRun", "raise teaser cap to 5 in a test");
    expect(record.proposedNextAction).toContain("teaser cap");
    expect(() => recordObservation("options:PayPerUse", "  ", "m", "do something")).toThrow();
  });
});

describe("catalog read route (#2695)", () => {
  it("answers 401 without a session, 405 on non-GET, 503 without a catalogue", async () => {
    const unauth = await handleProductCatalogRoute({ session: null, method: "GET", listPrices: async () => PRICE_FIXTURE });
    expect(unauth.status).toBe(401);
    const wrongMethod = await handleProductCatalogRoute({ session: { login: "u1" }, method: "POST", listPrices: async () => PRICE_FIXTURE });
    expect(wrongMethod.status).toBe(405);
    const noCatalogue = await handleProductCatalogRoute({ session: { login: "u1" }, method: "GET", listPrices: null });
    expect(noCatalogue.status).toBe(503);
  });

  it("serves display rows derived from the catalogue, inventing nothing", async () => {
    const res = await handleProductCatalogRoute({ session: { login: "u1" }, method: "GET", listPrices: async () => PRICE_FIXTURE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: CatalogDisplayEntry[] };
    const options = body.products.find((p) => p.id === "options:PayPerUse");
    const goal = body.products.find((p) => p.id === "goal:PayPerUse");
    expect(options?.listed).toBe(true);
    expect(options?.priceUSD).toBe(0.05);
    expect(goal?.listed).toBe(false);
    expect(goal?.priceUSD).toBeNull();
  });
});

describe("catalog panel (#2695)", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function flush(ms = 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("renders real catalog rows and unlisted reasons, fetching only the catalog route", async () => {
    const fixture: CatalogDisplayEntry[] = [
      {
        id: "options:PayPerUse", family: "options", tier: "PayPerUse",
        canonicalName: "Options Screener", servingAgent: "trading",
        priceUSD: 0.05, priceSource: "gate", priceLabel: "$0.05 per call — real (testnet) x402 gate",
        availability: "purchasable", listed: true, unlistedReasons: [],
        parityVerdict: "parity", parityNotes: [],
        purchasePath: { label: "Pay per call", route: "/api/premium/options-scan", note: "Pay at the gate endpoint." },
        purchasePathReason: null, realVsSimulated: "real (testnet)",
      },
      {
        id: "goal:PayPerUse", family: "goal", tier: "PayPerUse",
        canonicalName: "goal × PayPerUse", servingAgent: "screener",
        priceUSD: null, priceSource: null, priceLabel: null,
        availability: "unlisted", listed: false, unlistedReasons: ["missing approved price"],
        parityVerdict: "not-routable", parityNotes: [],
        purchasePath: null, purchasePathReason: "missing approved price", realVsSimulated: null,
      },
    ];
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return { ok: true, status: 200, json: async () => ({ products: fixture }) };
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ProductCatalogPanel />);
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Options Screener");
    expect(text).toContain("0.05");
    expect(text).toContain("missing approved price");
    expect(seen).toEqual(["/api/products/catalog"]);
  });
});
