// @vitest-environment node
/**
 * Issue #5606 (G-3, coded errors): per-site pins for the typed
 * BusinessError conversions.
 *
 * Every throw site the slice converted must reject with a catalog
 * code (never a raw message), and every converted route catch must
 * answer with a coded body. A regression here means a raw store or
 * provider message reaches a client again.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import {
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1BillingCustomerDb,
  D1BillingCustomerAdapter,
  ensureBillingCustomerSchema,
} from "../src/data/d1BillingCustomerAdapter";
import {
  createD1RefundDb,
  D1RefundAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryProductAdapter } from "../src/data/inMemoryProductAdapter";
import { InMemoryBillingAdapter } from "../src/services/inMemoryBillingAdapter";
import { InMemoryRefundPolicyAdapter } from "../src/data/inMemoryRefundAdapter";
import { InMemoryUsageEventStore } from "../src/data/inMemoryCanonicalReportStoreAdapters";
import { DoSqliteUsageEventStore } from "../src/data/doSqliteUsageEventAdapter";
import {
  DuplicateUsageEventError,
  type CanonicalReportStoreSqlExecutor,
} from "../src/data/canonicalReportStorePorts";
import { activateSubscription } from "../src/services/subscriptionActivation";
import { activateTrialSubscription } from "../src/services/trialSubscriptionActivation";
import { moveSubscriptionToVersion } from "../src/services/versionMoves";
import { validateRefundRequest } from "../src/data/refundPorts";
import { assertPriceFamily } from "../src/data/priceCataloguePorts";
import { issueReferralCode } from "../src/services/referralCodes";
import { getOutcome } from "../src/outcomes/outcomeAspects";
import type { DatabaseORM } from "../src/orm";

const NOW = 1_800_000_000_000;
const MS_PER_DAY = 86_400_000;
const INVALID = "FAILURE_COMMERCIAL_REQUEST_INVALID";
const CONFLICT = "FAILURE_COMMERCIAL_CONFLICT";
const NOT_FOUND = "FAILURE_COMMERCIAL_NOT_FOUND";
const FORBIDDEN = "FAILURE_COMMERCIAL_FORBIDDEN";

describe("coded errors #5606: subscription activation throws carry catalog codes", () => {
  async function setup() {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const created = await subs.createPlan({
      id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10, trialDays: 14,
    });
    await subs.approvePlan(created.id, "test-operator");
    const plan = (await subs.getPlan(created.id))!;
    return { subs, store, plan };
  }

  it("an inactive plan is REQUEST_INVALID, a tenant mismatch is FORBIDDEN, a replay is CONFLICT", async () => {
    const { subs, store, plan } = await setup();
    await expect(
      activateSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: { ...plan, active: false }, providerPaymentRef: "sub-a", nowMs: NOW }),
    ).rejects.toMatchObject({ code: INVALID });
    // v5: the mismatch guard only fires when an account already
    // exists — the first activation auto-creates the account in
    // the requested tenant, so a t2 attempt before any activation
    // succeeds instead of mismatching. Activate in t1 first.
    await activateSubscription({ subs, store, userId: "u1", tenantId: "t1", plan, providerPaymentRef: "sub-c", nowMs: NOW });
    await expect(
      activateSubscription({ subs, store, userId: "u1", tenantId: "t2", plan, providerPaymentRef: "sub-b", nowMs: NOW }),
    ).rejects.toMatchObject({ code: FORBIDDEN });
    await expect(
      activateSubscription({ subs, store, userId: "u1", tenantId: "t1", plan, providerPaymentRef: "sub-c", nowMs: NOW }),
    ).rejects.toMatchObject({ code: CONFLICT });
  });

  it("trial plan-state refusals are CONFLICT (N2: the wrapper preserves the 409)", async () => {
    const { subs, store } = await setup();
    // Unapproved plan: the assert throws REQUEST_INVALID, the
    // trial wrapper translates it to CONFLICT — the route keeps 409.
    const unapproved = await subs.createPlan({
      id: "draft", name: "Draft", priceUSD: 5, periodDays: 30, includedRuns: 0, trialDays: 7,
    });
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: unapproved, nowMs: NOW }),
    ).rejects.toMatchObject({ code: CONFLICT });
    // A plan with no trial at all refuses the same way.
    const noTrial = await subs.createPlan({
      id: "plain", name: "Plain", priceUSD: 5, periodDays: 30, includedRuns: 0,
    });
    await subs.approvePlan(noTrial.id, "test-operator");
    const plain = (await subs.getPlan(noTrial.id))!;
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: plain, nowMs: NOW }),
    ).rejects.toMatchObject({ code: CONFLICT });
  });

  it("a second trial of the same plan is CONFLICT; a cross-tenant trial is FORBIDDEN", async () => {
    const { subs, store, plan } = await setup();
    await activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan, nowMs: NOW });
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan, nowMs: NOW }),
    ).rejects.toMatchObject({ code: CONFLICT });
    const other = await subs.createPlan({
      id: "team", name: "Team", priceUSD: 40, periodDays: 30, includedRuns: 5, trialDays: 7,
    });
    await subs.approvePlan(other.id, "test-operator");
    const team = (await subs.getPlan(other.id))!;
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t2", plan: team, nowMs: NOW }),
    ).rejects.toMatchObject({ code: FORBIDDEN });
  });
});

describe("coded errors #5606: version moves, credits, refunds, validators", () => {
  it("a move of a missing subscription is NOT_FOUND; a cross-product move is CONFLICT", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const products = new InMemoryProductAdapter();
    await expect(
      moveSubscriptionToVersion({ subs, store, products, subscriptionId: "nope", toVersionId: "v9", movedBy: "op1", nowMs: NOW }),
    ).rejects.toMatchObject({ code: NOT_FOUND });
    const prodA = await products.createProduct({ id: "prod-a", name: "A", kind: "subscription" });
    const prodB = await products.createProduct({ id: "prod-b", name: "B", kind: "subscription" });
    const v1 = await subs.createPlan({ id: "v1", name: "V1", priceUSD: 10, periodDays: 30, includedRuns: 0, productId: prodA.id });
    const v2 = await subs.createPlan({ id: "v2", name: "V2", priceUSD: 10, periodDays: 30, includedRuns: 0, productId: prodB.id });
    await subs.approvePlan(v1.id, "op1");
    await subs.approvePlan(v2.id, "op1");
    const sub = await subs.createSubscription({
      id: "sub-1", userId: "u1", tenantId: "t1", planId: v1.id, provider: "trial",
      providerPaymentRef: "trial-1", periodStartMs: NOW, periodEndMs: NOW + 30 * MS_PER_DAY,
    });
    await expect(
      moveSubscriptionToVersion({ subs, store, products, subscriptionId: sub.id, toVersionId: v2.id, movedBy: "op1", nowMs: NOW }),
    ).rejects.toMatchObject({ code: CONFLICT });
  });

  it("a redeemed credit replays as FAILURE_CREDIT_ALREADY_REDEEMED (the slice's one new code)", async () => {
    const store = new InMemoryCommercialAdapter();
    await store.redeemCredit("run-1", "run-2");
    await expect(store.redeemCredit("run-1", "run-3")).rejects.toMatchObject({
      code: "FAILURE_CREDIT_ALREADY_REDEEMED",
    });
  });

  it("refund policy refusals are FAILURE_REFUND_POLICY_REFUSAL; a future paid date is REQUEST_INVALID", async () => {
    const policy = await new InMemoryRefundPolicyAdapter().getPolicy();
    if (!policy) throw new Error("seed policy missing");
    const base = { rail: "crypto" as const, amountUSD: 5, originalAmountUSD: 10, originalPaidAtMs: NOW };
    expect(() => validateRefundRequest(policy, base, NOW + MS_PER_DAY)).toThrowError(
      expect.objectContaining({ code: "FAILURE_REFUND_POLICY_REFUSAL" }),
    );
    expect(() =>
      // v5: a FULL refund — the seed policy disallows partials
      // (allowPartial: false), and that refusal fires before the
      // future-date check. Equal amounts isolate the date rule.
      validateRefundRequest(policy, { ...base, rail: "card" as const, amountUSD: 10, originalPaidAtMs: NOW + MS_PER_DAY }, NOW),
    ).toThrowError(expect.objectContaining({ code: INVALID }));
  });

  it("validators throw REQUEST_INVALID, never a raw field message", async () => {
    expect(() => assertPriceFamily("bogus")).toThrowError(expect.objectContaining({ code: INVALID }));
    const subs = new InMemorySubscriptionAdapter();
    await expect(
      subs.createPlan({ name: "", priceUSD: 10, periodDays: 30, includedRuns: 0 }),
    ).rejects.toMatchObject({ code: INVALID });
    const billing = new InMemoryBillingAdapter(() => NOW);
    await expect(
      billing.createProviderSubscription({ customerId: "", priceId: "price_1" }),
    ).rejects.toMatchObject({ code: INVALID });
    await expect(billing.retrieveProviderSubscription("sub_missing")).rejects.toMatchObject({ code: NOT_FOUND });
    // A referral code with no issuer is an invalid request, not a 500.
    await expect(
      issueReferralCode({} as never, {
        productId: "prod-a", kind: "user", issuerLogin: "  ", issuerKind: "user",
        referrerUserId: "u1", tenantScope: null, nowMs: NOW,
      }),
    ).rejects.toMatchObject({ code: INVALID });
  });

  it("a usage-event duplicate is typed at the adapter boundary on both stores", () => {
    const row = {
      id: "evt-1", userLogin: "u1", runId: "run-1", category: "screen", createdAt: "2026-11-19T00:00:00.000Z", detailJson: null, tenantId: null,
    };
    const mem = new InMemoryUsageEventStore();
    mem.insertEvent(row);
    expect(() => mem.insertEvent(row)).toThrow(DuplicateUsageEventError);
    // DO adapter: a SQLite constraint error becomes the typed error…
    const colliding = new DoSqliteUsageEventStore({
      exec: () => { throw new Error("UNIQUE constraint failed: usage_events.id"); },
    } as unknown as CanonicalReportStoreSqlExecutor);
    expect(() => colliding.insertEvent(row)).toThrow(DuplicateUsageEventError);
    // …and any other store failure propagates unchanged.
    const broken = new DoSqliteUsageEventStore({
      exec: () => { throw new Error("disk I/O error"); },
    } as unknown as CanonicalReportStoreSqlExecutor);
    expect(() => broken.insertEvent(row)).toThrow(/disk I\/O error/);
  });
});

describe("coded errors #5606: routes answer coded bodies", () => {
  class MockD1Database {
    readonly sqlite = new DatabaseSync(":memory:");
    prepare(sql: string) {
      const db = this.sqlite;
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              const info = db.prepare(sql).run(...(params as any[]));
              return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
            },
            async all() {
              return { results: db.prepare(sql).all(...(params as any[])) };
            },
            async first() {
              return db.prepare(sql).get(...(params as any[])) ?? null;
            },
            async raw() {
              return db.prepare(sql).all(...(params as any[])).map((row: any) => Object.values(row));
            },
          };
        },
      };
    }
  }

  async function setup() {
    const mock = new MockD1Database();
    await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    await ensureJournalSchema(createD1JournalDb(mock as unknown as D1Database));
    const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
    await ensureBillingPolicySchema(policyDb);
    await ensureBillingCustomerSchema(createD1BillingCustomerDb(mock as unknown as D1Database));
    const refundDb = createD1RefundDb(mock as unknown as D1Database);
    await ensureRefundSchema(refundDb);
    const env: Record<string, unknown> = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
      MONETIZATION_ENABLED: "true",
    };
    const ctx = {
      env,
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    const subs = new D1SubscriptionAdapter(subsDb);
    const commercial = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
    return { ctx, subs, commercial };
  }

  const call = (ctx: AgenticPaymentsRouteContext, method: string, path: string, login: string | null, body?: unknown) => {
    const url = new URL(`https://agent.internal${path}`);
    const req = new Request(url, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleAgenticPaymentsRoutes(req, url, url.pathname, "sess-1", ctx);
  };

  it("a credit adjustment for a missing account is 400 REQUEST_INVALID with the catalog message", async () => {
    const { ctx } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/account/credits", "op1", { userId: "ghost", deltaUSD: 5 });
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as any;
    expect(body.code).toBe(INVALID);
    // v5: codedOutcomeResponse returns the PLAIN catalog business
    // message (not the bracketed codedMessage rendering) — see the
    // v2 billing-shape revert. Assert the plain message.
    expect(body.error ?? body.message).toBe(getOutcome(INVALID)?.businessMessage);
    expect(JSON.stringify(body)).not.toContain("No commercial account");
  });

  it("a duplicate plan create is 409 CONFLICT", async () => {
    const { ctx } = await setup();
    const plan = { id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 };
    const first = await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", plan);
    expect(first?.status).toBeLessThan(300);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", plan);
    expect(res?.status).toBe(409);
    expect(((await res?.json()) as any).code).toBe(CONFLICT);
  });

  it("a grant for a missing account is 400 REQUEST_INVALID", async () => {
    const { ctx, subs } = await setup();
    const created = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    await subs.approvePlan(created.id, "op1");
    const res = await call(ctx, "POST", "/payments/agentic/commercial/subscription/grant", "op1", {
      userId: "ghost", planId: "pro", tenantId: "t1",
    });
    expect(res?.status).toBe(400);
    expect(((await res?.json()) as any).code).toBe(INVALID);
  });

  it("a refund request for an unapproved kind is 422 REFUND_POLICY_REFUSAL (N4)", async () => {
    const { ctx } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/refunds", "op1", {
      kind: "subscription", originalPaymentRef: "pi_missing", amountUSD: 5, reason: "changed my mind",
    });
    expect(res?.status).toBe(422);
    const body = (await res?.json()) as any;
    expect(body.code).toBe("FAILURE_REFUND_POLICY_REFUSAL");
    expect(JSON.stringify(body)).not.toContain("not owner-approved");
  });
});

describe("coded errors #5606: grep pins on the other converted route files", () => {
  const readSrc = (p: string) => require("node:fs").readFileSync(p, "utf8") as string;

  it("no raw error text reaches a client from the other converted route files", () => {
    const bad: string[] = [];
    // v5: payments.ts:998 is the slice's DOCUMENTED exception
    // (comment at :995–997: MCP command throw, route answers a
    // coded 404) — the sibling pin counts it as the exactly-one
    // regex site, so it is excluded here, nowhere else.
    // (#6102 shifted the line from :995: the branch added 3 lines
    // above it in payments.ts; the line itself is unchanged.)
    const documentedExceptions = new Set(["src/agents/routes/payments.ts:998"]);
    for (const file of [
      "src/agents/routes/platformTenants.ts",
      "src/agents/routes/platformAccounts.ts",
      "src/agents/routes/platformChannels.ts",
      "src/agents/routes/payments.ts",
      "src/agents/routes/premium.ts",
      "src/agents/routes/meter.ts",
      "src/agents/routes/adsRevenueReferrals.ts",
      "src/agents/routes/audit.ts",
    ]) {
      readSrc(file).split("\n").forEach((line, idx) => {
        if (documentedExceptions.has(`${file}:${idx + 1}`)) return;
        if (
          /Response\.json\([^)]*err\.message/.test(line) ||
          /error:\s*err\.message/.test(line) ||
          /const message = err\.message/.test(line) ||
          /\.test\((message|err\.message)/.test(line) ||
          /startsWith\([^)]*message\)/.test(line)
        ) {
          bad.push(`${file}:${idx + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(bad, "raw err.message passthroughs / regex classifications").toEqual([]);
  });

  it("meter.ts classifies duplicates by type, never by storage-dialect text", () => {
    const src = readSrc("src/agents/routes/meter.ts");
    // v5: the dialect strings appear in the file's header COMMENT
    // (prose about the table's UNIQUE/PRIMARY KEY shape), not in
    // code — strip comments before matching, code only.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/UNIQUE constraint|PRIMARY KEY/);
    expect(src).toContain("DuplicateUsageEventError");
  });

  it("payments.ts keeps exactly one regex-over-message site: the documented confirm-draft 404 exception", () => {
    // G6:975 — the throw site is the MCP command
    // src/mcps/openaimp/commands.ts:810, which FS-5 (no MCP) leaves
    // unconverted; the route keeps the regex but answers a coded
    // 404 with a generic message. Any second site is a regression.
    const src = readSrc("src/agents/routes/payments.ts");
    const hits = src.split("\n").filter((l) => /\.test\((message|err\.message)/.test(l));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("not found");
  });
});
