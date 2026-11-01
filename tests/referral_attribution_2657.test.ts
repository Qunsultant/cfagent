// @vitest-environment node
/**
 * Issue #2657 ([Monetization Phase 2.2] Referral credits ledger +
 * earn/vest/redeem + redemption, sub-issue of #2405).
 *
 * Correction of record: the referral-credit LEDGER already exists via CBO
 * #2208 (port + adapters + operator rules + pay-per-use conversion). This
 * slice builds ONLY the missing layer #2208 named as follow-up: a durable
 * referrer→referred attribution store (set-once, tenant-scoped), an operator
 * attribution route, and automatic earn on a referred user's first verified
 * paid submit. Subscription redemption stays deferred: the acceptance line
 * reads pay-per-use AND/OR subscription, and #2208's validator keeps
 * redemptionScope pay-per-run-only.
 *
 * TDD red: ReferralAttribution, recordAttribution/getAttribution, migration
 * 0031, the attribute route, and the submit-path auto-earn trigger do not
 * exist yet — every test below must fail until the implementation lands.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
} from "../src/data/d1LifecycleAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import { MIGRATION_0031_REFERRAL_ATTRIBUTION } from "../src/data/migrationRunner";
import { agentReferralAttributions } from "../src/data/drizzleSchema";
import type { LifecycleStore } from "../src/data/lifecyclePorts";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { convertReferralCreditsForRun } from "../src/services/referralCredits";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function makeD1Store(): Promise<D1LifecycleAdapter> {
  const mock = new MockD1Database();
  const db = createD1LifecycleDb(mock as unknown as D1Database);
  const adapter = new D1LifecycleAdapter(db);
  await ensureLifecycleSchema(db);
  return adapter;
}

describe("referral attribution port conformance (#2657)", () => {
  const adapters: Array<{ name: string; make: () => Promise<LifecycleStore> }> = [
    { name: "d1", make: makeD1Store },
    { name: "in-memory", make: async () => new InMemoryLifecycleAdapter() },
  ];
  for (const { name, make } of adapters) {
    describe(`adapter: ${name}`, () => {
      it("records an attribution and reads it back", async () => {
        const store = await make();
        const row = await store.recordAttribution({
          referrerUserId: "ref1",
          referredUserId: "u1",
          tenantId: "t1",
        });
        expect(row.referrerUserId).toBe("ref1");
        expect(row.referredUserId).toBe("u1");
        expect(row.tenantId).toBe("t1");
        expect(row.source).toBe("operator");
        const read = await store.getAttribution("u1");
        expect(read).toEqual(row);
      });

      it("replaying the same attribution returns the existing row (set-once)", async () => {
        const store = await make();
        const first = await store.recordAttribution({
          referrerUserId: "ref1",
          referredUserId: "u1",
          tenantId: "t1",
        });
        const second = await store.recordAttribution({
          referrerUserId: "ref1",
          referredUserId: "u1",
          tenantId: "t1",
        });
        expect(second).toEqual(first);
      });

      it("a different referrer for the same referred user throws (no silent overwrite)", async () => {
        const store = await make();
        await store.recordAttribution({
          referrerUserId: "ref1",
          referredUserId: "u1",
          tenantId: "t1",
        });
        await expect(
          store.recordAttribution({
            referrerUserId: "ref2",
            referredUserId: "u1",
            tenantId: "t1",
          }),
        ).rejects.toThrow();
        expect((await store.getAttribution("u1"))?.referrerUserId).toBe("ref1");
      });

      it("self-referral and blank ids/tenant throw", async () => {
        const store = await make();
        await expect(
          store.recordAttribution({
            referrerUserId: "u1",
            referredUserId: "u1",
            tenantId: "t1",
          }),
        ).rejects.toThrow();
        await expect(
          store.recordAttribution({
            referrerUserId: "",
            referredUserId: "u1",
            tenantId: "t1",
          }),
        ).rejects.toThrow();
        await expect(
          store.recordAttribution({
            referrerUserId: "ref1",
            referredUserId: "u1",
            tenantId: "",
          }),
        ).rejects.toThrow();
      });

      it("getAttribution is null when no attribution exists, and attribution alone earns nothing", async () => {
        const store = await make();
        expect(await store.getAttribution("nobody")).toBeNull();
        await store.recordAttribution({
          referrerUserId: "ref1",
          referredUserId: "u1",
          tenantId: "t1",
        });
        expect(await store.redeemableBalance("ref1")).toBe(0);
        expect(await store.listEarnings("ref1")).toEqual([]);
      });
    });
  }
});

describe("referral attribution structural pins (#2657)", () => {
  it("migration 0031 DDL and Drizzle schema agree on columns", () => {
    const rawColumns = getTableConfig(agentReferralAttributions).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) =>
          s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
    const block = MIGRATION_0031_REFERRAL_ATTRIBUTION.sql.split(
      "CREATE TABLE IF NOT EXISTS agent_referral_attributions (",
    )[1].split(");")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)]
      .map((m) => m[1])
      .filter(
        (c) =>
          !["PRIMARY", "FOREIGN", "UNIQUE", "CONSTRAINT", "CHECK"].includes(c),
      );
    expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
  });

  it("attribution table is separate from failure-credit claim tables", () => {
    expect(MIGRATION_0031_REFERRAL_ATTRIBUTION.sql).not.toContain(
      "agent_credit_claims",
    );
    expect(MIGRATION_0031_REFERRAL_ATTRIBUTION.sql).not.toContain(
      "agent_credit_redemptions",
    );
  });
});

describe("referral attribution routes + auto-earn trigger (#2657)", () => {
  async function setup(opts?: { monetization?: boolean }) {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const binding = {
      create: vi.fn(async ({ id }: { id: string }) => ({ id })),
      get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
    };
    const screenerBinding = {
      create: vi.fn(async ({ id }: { id: string }) => ({ id })),
      get: vi.fn(async () => {
        throw new Error("not found");
      }),
    };
    const env: Record<string, unknown> = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
      PAYMENT_WORKFLOW: binding,
      SCREENER_WORKFLOW: screenerBinding,
    };
    if (opts?.monetization) env.MONETIZATION_ENABLED = "true";
    const audit = vi.fn();
    const ctx = {
      env,
      getOrm: () => ({}),
      audit,
    } as unknown as AgenticPaymentsRouteContext;
    return { ctx, audit, binding };
  }

  const req = (method: string, path: string, login: string | null, body?: unknown) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const call = (
    ctx: AgenticPaymentsRouteContext,
    method: string,
    path: string,
    login: string | null,
    body?: unknown,
  ) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
  };

  const submitBody = {
    family: "goal",
    email: "u1@example.com",
    screenerCommand: {
      jobId: "job-1",
      type: "run-screen",
      source: "test",
      trigger: "manual",
      userLogin: "u1",
      shards: [{ shardId: "goal" }],
      role: "parent",
    },
  };

  async function account(ctx: AgenticPaymentsRouteContext, userId: string, tenantId: string, tier: string) {
    const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId,
      tenantId,
      tier,
    });
    expect(res?.status).toBe(200);
  }

  async function balance(ctx: AgenticPaymentsRouteContext, login: string, userId: string) {
    const res = await call(
      ctx,
      "GET",
      `/payments/agentic/commercial/referral/balance?userId=${userId}`,
      login,
    );
    expect(res?.status).toBe(200);
    return (await res?.json()) as {
      totalEarnedUSD: number;
      redeemableUSD: number;
      attribution: { referrerUserId: string; source: string } | null;
    };
  }

  it("attribute is operator-only and audits", async () => {
    const { ctx, audit } = await setup();
    const anon = await call(ctx, "POST", "/payments/agentic/commercial/referral/attribute", null, {
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    expect(anon?.status).toBe(401);
    const nonOp = await call(ctx, "POST", "/payments/agentic/commercial/referral/attribute", "u1", {
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    expect(nonOp?.status).toBe(403);
    const ok = await call(ctx, "POST", "/payments/agentic/commercial/referral/attribute", "op1", {
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    expect(ok?.status).toBe(200);
    const body = (await ok?.json()) as { attribution: { referrerUserId: string } };
    expect(body.attribution.referrerUserId).toBe("ref1");
    expect(audit).toHaveBeenCalledWith(
      "commercial.referral.attributed",
      "payments",
      expect.objectContaining({ referredUserId: "u1", referrerUserId: "ref1" }),
    );
    const b = await balance(ctx, "u1", "u1");
    expect(b.attribution?.referrerUserId).toBe("ref1");
  });

  it("first paid submit auto-earns for the attributed referrer (flag ON); second submit earns nothing more", async () => {
    const { ctx, audit } = await setup({ monetization: true });
    await account(ctx, "u1", "t1", "Free");
    await call(ctx, "POST", "/payments/agentic/commercial/referral/attribute", "op1", {
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { status: string }).status).toBe("payment_started");
    const b = await balance(ctx, "ref1", "ref1");
    expect(b.totalEarnedUSD).toBe(0.5);
    expect(b.redeemableUSD).toBe(0);
    expect(audit).toHaveBeenCalledWith(
      "commercial.referral.earned",
      "payments",
      expect.objectContaining({ trigger: "auto", referredUserId: "u1", referrerUserId: "ref1" }),
    );
    const res2 = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res2?.status).toBe(200);
    expect((await balance(ctx, "ref1", "ref1")).totalEarnedUSD).toBe(0.5);
  });

  it("flag-OFF free submit earns nothing; unattributed submit earns nothing", async () => {
    const { ctx } = await setup();
    await account(ctx, "u1", "t1", "Free");
    await call(ctx, "POST", "/payments/agentic/commercial/referral/attribute", "op1", {
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    expect((await balance(ctx, "ref1", "ref1")).totalEarnedUSD).toBe(0);

    const { ctx: ctx2 } = await setup({ monetization: true });
    await account(ctx2, "u2", "t1", "Free");
    const res2 = await call(ctx2, "POST", "/payments/agentic/commercial/submit", "u2", {
      ...submitBody,
      email: "u2@example.com",
      screenerCommand: { ...submitBody.screenerCommand, userLogin: "u2" },
    });
    expect(res2?.status).toBe(200);
    expect((await balance(ctx2, "ref1", "ref1")).totalEarnedUSD).toBe(0);
  });

  it("tenant-mismatched attribution never earns and audits the failure", async () => {
    const { ctx, audit } = await setup({ monetization: true });
    await account(ctx, "u1", "t2", "Free");
    await call(ctx, "POST", "/payments/agentic/commercial/referral/attribute", "op1", {
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    expect((await balance(ctx, "ref1", "ref1")).totalEarnedUSD).toBe(0);
    expect(audit).toHaveBeenCalledWith(
      "commercial.referral.earn_failed",
      "payments",
      expect.objectContaining({ referredUserId: "u1" }),
    );
  });
});

describe("referral full loop: attribute → earn → vest → redeem (#2657)", () => {
  it("vested earnings convert into commercial credit exactly, unvested never convert", async () => {
    const lifecycle = new InMemoryLifecycleAdapter();
    const commercial = new InMemoryCommercialAdapter();
    await lifecycle.recordAttribution({
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    // Immediate vesting for the loop proof (operator rule, not a code constant).
    await lifecycle.setRules({ earnAmountUSD: 0.5, vestingDelayMs: 0, redemptionScope: "pay-per-run" });
    const earning = await lifecycle.recordEarning({
      referrerUserId: "ref1",
      referredUserId: "u1",
      tenantId: "t1",
    });
    expect(earning.amountUSD).toBe(0.5);
    expect(await lifecycle.redeemableBalance("ref1")).toBe(0.5);
    const converted = await convertReferralCreditsForRun({
      lifecycle,
      commercial,
      userId: "ref1",
      tenantId: "t1",
      amountUSD: 0.5,
      runRequestId: "run-loop-1",
    });
    expect(converted.redeemedUSD).toBe(0.5);
    expect((await commercial.getAccount("ref1"))?.creditsUSD).toBe(0.5);
    expect(await lifecycle.redeemableBalance("ref1")).toBe(0);
  });
});
