/**
 * Issues #2015/#2020 — commercial store endpoints + the dedicated
 * paid-submission route, tested through handleAgenticPaymentsRoutes.
 *
 * D1 is shared, so there is no canonical-instance hop: the handler
 * builds the store adapter straight from ctx.env.AGENT_DB. Tests
 * supply a MockD1Database (node:sqlite, the slice0 pattern) with
 * migration 0007 applied, so the real Drizzle adapter runs.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import type { DatabaseORM } from "../src/orm";

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

async function setup() {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
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
  const env = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: binding,
    SCREENER_WORKFLOW: screenerBinding,
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, binding, screenerBinding, db };
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

const screenerCommand = {
  jobId: "job-1",
  type: "run-screen",
  source: "test",
  trigger: "manual",
  userLogin: "u1",
  shards: [{ shardId: "goal" }],
  role: "parent",
};

describe("commercial store endpoints (#2015)", () => {
  it("operator upserts; self reads; others are refused; bad tiers are 400", async () => {
    const { ctx } = await setup();
    const created = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 5,
      includedRuns: 2,
    });
    expect(created?.status).toBe(200);
    expect(((await created?.json()) as { record: { tier: string } }).record.tier).toBe("Subscribed");
    const forbidden = await call(ctx, "POST", "/payments/agentic/commercial/account", "u1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
    });
    expect(forbidden?.status).toBe(403);
    const badTier = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Premium",
    });
    expect(badTier?.status).toBe(400);
    const self = await call(ctx, "GET", "/payments/agentic/commercial/account?userId=u1", "u1");
    expect(self?.status).toBe(200);
    const other = await call(ctx, "GET", "/payments/agentic/commercial/account?userId=u1", "u2");
    expect(other?.status).toBe(403);
    const anon = await call(ctx, "GET", "/payments/agentic/commercial/account?userId=u1", null);
    expect(anon?.status).toBe(401);
  });

  it("operator upsert audit carries previous → new effective tier (#2522)", async () => {
    const { ctx } = await setup();
    // First upsert: no prior row → previous Free, new PayPerUse.
    const first = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1", tenantId: "t1", tier: "PayPerUse", creditsUSD: 0, includedRuns: 0,
    });
    expect(first?.status).toBe(200);
    const firstAudit = (ctx.audit as any).mock.calls.find(([t]: [string]) => t === "commercial.account.upserted");
    expect(firstAudit).toBeDefined();
    expect(firstAudit[2].previousEffectiveTier).toBe("Free");
    expect(firstAudit[2].newEffectiveTier).toBe("PayPerUse");
    // Second upsert: PayPerUse → Subscribed (operator grant, so
    // it survives even with no subscription row).
    const second = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1", tenantId: "t1", tier: "Subscribed", creditsUSD: 0, includedRuns: 0,
    });
    expect(second?.status).toBe(200);
    const audits = (ctx.audit as any).mock.calls.filter(([t]: [string]) => t === "commercial.account.upserted");
    expect(audits).toHaveLength(2);
    expect(audits[1][2].previousEffectiveTier).toBe("PayPerUse");
    expect(audits[1][2].newEffectiveTier).toBe("Subscribed");
  });

  it("credits adjust with a floor; tenant settings are operator-only", async () => {
    const { ctx } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "PayPerUse",
      creditsUSD: 10,
      includedRuns: 1,
    });
    const adjusted = await call(ctx, "POST", "/payments/agentic/commercial/account/credits", "op1", {
      userId: "u1",
      deltaUSD: -3,
    });
    expect(((await adjusted?.json()) as { record: { creditsUSD: number } }).record.creditsUSD).toBe(7);
    const below = await call(ctx, "POST", "/payments/agentic/commercial/account/credits", "op1", {
      userId: "u1",
      deltaUSD: -100,
    });
    expect(below?.status).toBe(400);
    const def = await call(ctx, "GET", "/payments/agentic/commercial/tenant-settings?tenantId=t1", "op1");
    expect(((await def?.json()) as { adsEnabled: boolean }).adsEnabled).toBe(true);
    const userRead = await call(ctx, "GET", "/payments/agentic/commercial/tenant-settings?tenantId=t1", "u1");
    expect(userRead?.status).toBe(403);
    const set = await call(ctx, "POST", "/payments/agentic/commercial/tenant-settings", "op1", {
      tenantId: "t1",
      adsEnabled: false,
    });
    expect(set?.status).toBe(200);
  });

  it("unbound AGENT_DB fails closed on money endpoints", async () => {
    const { ctx } = await setup();
    const noDbCtx = {
      ...ctx,
      env: { ...(ctx.env as Record<string, unknown>), AGENT_DB: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const res = await call(noDbCtx, "GET", "/payments/agentic/commercial/account?userId=u1", "u1");
    expect(res?.status).toBe(503);
  });
});

describe("dedicated paid-submission route (#2015)", () => {
  const submitBody = {
    family: "goal",
    tenantId: "t1",
    email: "u1@example.com",
    screenerCommand,
  };

  it("rejects anonymous, invalid, and recurring submissions; resolved tenant wins over a mismatched client tenant (#2219)", async () => {
    const { ctx, binding } = await setup();
    const anon = await call(ctx, "POST", "/payments/agentic/commercial/submit", null, submitBody);
    expect(anon?.status).toBe(401);
    const badFamily = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      family: "crypto",
    });
    expect(badFamily?.status).toBe(400);
    const recurring = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      scheduleKind: "recurring",
    });
    expect(recurring?.status).toBe(400);
    const noJob = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      screenerCommand: { type: "run-screen" },
    });
    expect(noJob?.status).toBe(400);
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t2",
      tier: "Free",
    });
    // #2219: a client-supplied tenantId is untrusted input, never
    // identity — the resolved account tenant (t2) wins over the
    // body's t1, and the submission proceeds instead of 403ing.
    const mismatch = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(mismatch?.status).toBe(200);
    const createArg = (binding.create as unknown as { mock: { calls: Array<Array<{ params: { tenantId: string } }>> } }).mock.calls[0][0];
    expect(createArg.params.tenantId).toBe("t2");
  });

  it("starts the payment workflow for a new run with the stored account", async () => {
    const { ctx, binding } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Subscribed",
      creditsUSD: 0,
      includedRuns: 3,
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { status: string; workflowId: string; runRequestId: string };
    expect(body.status).toBe("payment_started");
    expect(body.runRequestId.startsWith("run-")).toBe(true);
    expect(binding.create).toHaveBeenCalledOnce();
    const createArg = (binding.create as unknown as { mock: { calls: Array<Array<{ id: string; params: { account: { tier: string } } }>> } }).mock.calls[0][0];
    expect(createArg.id).toBe(body.runRequestId);
    expect(createArg.params.account.tier).toBe("Subscribed");
  });

  it("stamps the screener command owner from the verified session, never a caller claim (#2137)", async () => {
    const { ctx, binding } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      screenerCommand: { ...screenerCommand, userLogin: "attacker" },
    });
    expect(res?.status).toBe(200);
    const createArg = (binding.create as unknown as { mock: { calls: Array<Array<{ params: { screenerCommand: { userLogin: string } } }>> } }).mock.calls[0][0];
    expect(createArg.params.screenerCommand.userLogin).toBe("u1");
  });

  it("fails closed when the store or the binding is unavailable", async () => {    const { ctx } = await setup();
    const noDbCtx = {
      ...ctx,
      env: { ...(ctx.env as Record<string, unknown>), AGENT_DB: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const noStore = await call(noDbCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(noStore?.status).toBe(503);
    const noBindingCtx = {
      ...ctx,
      env: { ...(ctx.env as Record<string, unknown>), PAYMENT_WORKFLOW: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const noBinding = await call(noBindingCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(noBinding?.status).toBe(503);
  });

  it("redeems a credit and starts the screener directly", async () => {
    const { ctx, db, screenerBinding } = await setup();
    const { D1CommercialAdapter } = await import("../src/data/d1CommercialAdapter");
    const store = new D1CommercialAdapter(db);
    await store.recordCreditClaim({ creditRunId: "run-9", userId: "u1", family: "goal", amountUSD: 0.1 });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { status: string; creditRunId: string; workflowId: string };
    expect(body.status).toBe("redeemed_started");
    expect(body.creditRunId).toBe("run-9");
    expect(screenerBinding.create).toHaveBeenCalledOnce();
    // The claim is spent: a second submission pays normally.
    const second = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(((await second?.json()) as { status: string }).status).toBe("payment_started");
    expect(await store.findUnredeemedCredit("u1", "goal")).toBeNull();
  });

  it("does not burn a credit when the screener port is unavailable", async () => {
    const { ctx, db } = await setup();
    const { D1CommercialAdapter } = await import("../src/data/d1CommercialAdapter");
    const store = new D1CommercialAdapter(db);
    await store.recordCreditClaim({ creditRunId: "run-9", userId: "u1", family: "goal", amountUSD: 0.1 });
    const noPortCtx = {
      ...ctx,
      env: { ...(ctx.env as Record<string, unknown>), SCREENER_WORKFLOW: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const res = await call(noPortCtx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(503);
    expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({ creditRunId: "run-9", amountUSD: 0.1, productId: null, versionId: null, priceUSD: null });
  });

  it("reports submission status through the binding", async () => {
    // #2137 follow-ups: status reads are owner-only, so the
    // submission must be recorded first (via the submit route);
    // the ownership matrix itself lives in
    // paid_submission_ownership.test.ts.
    const { ctx } = await setup();
    const submitted = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(submitted?.status).toBe(200);
    const sub = (await submitted?.json()) as { workflowId: string };
    const res = await call(ctx, "GET", `/payments/agentic/commercial/submission-status?workflowId=${sub.workflowId}`, "u1");
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { status: string }).status).toBe("completed");
    const anon = await call(ctx, "GET", `/payments/agentic/commercial/submission-status?workflowId=${sub.workflowId}`, null);
    expect(anon?.status).toBe(401);
  });
});

describe("free-run allowance routes (#3315)", () => {
  it("operator reads the seeded allowances; non-operators are refused", async () => {
    const { ctx } = await setup();
    const res = await call(ctx, "GET", "/payments/agentic/commercial/free-run-allowance", "op1");
    expect(res?.status).toBe(200);
    // The GET ensure applies migration 0044, so a fresh store
    // reads the seeded allowances — the only place the decided
    // value lives (#3315: no code constant).
    expect(await res?.json()).toEqual({
      allowances: [
        { family: "stock", runs: 10 },
        { family: "goal", runs: 10 },
        { family: "options", runs: 10 },
        { family: "strategy", runs: 10 },
      ],
      code: "SUCCESS_FREE_RUN_ALLOWANCE_READ",
    });
    const userRead = await call(ctx, "GET", "/payments/agentic/commercial/free-run-allowance", "u1");
    expect(userRead?.status).toBe(403);
    const anon = await call(ctx, "GET", "/payments/agentic/commercial/free-run-allowance", null);
    expect(anon?.status).toBe(401);
  });

  it("operator sets one family, audited; invalid family or runs are 400; non-operators are refused", async () => {
    const { ctx } = await setup();
    const set = await call(ctx, "POST", "/payments/agentic/commercial/free-run-allowance", "op1", {
      family: "goal",
      runs: 25,
    });
    expect(set?.status).toBe(200);
    expect(await set?.json()).toEqual({ family: "goal", runs: 25, code: "SUCCESS_FREE_RUN_ALLOWANCE_UPDATED" });
    const audit = (ctx.audit as any).mock.calls.find(
      ([t]: [string]) => t === "commercial.free_run_allowance.set",
    );
    expect(audit).toBeDefined();
    expect(audit[2]).toMatchObject({ family: "goal", runs: 25, operator: "op1" });
    const reread = await call(ctx, "GET", "/payments/agentic/commercial/free-run-allowance", "op1");
    const body = (await reread?.json()) as { allowances: Array<{ family: string; runs: number | null }> };
    expect(body.allowances.find((row) => row.family === "goal")).toEqual({ family: "goal", runs: 25 });
    expect(body.allowances.find((row) => row.family === "stock")).toEqual({ family: "stock", runs: 10 });
    const forbidden = await call(ctx, "POST", "/payments/agentic/commercial/free-run-allowance", "u1", {
      family: "goal",
      runs: 25,
    });
    expect(forbidden?.status).toBe(403);
    const badFamily = await call(ctx, "POST", "/payments/agentic/commercial/free-run-allowance", "op1", {
      family: "nope",
      runs: 5,
    });
    expect(badFamily?.status).toBe(400);
    const badRuns = await call(ctx, "POST", "/payments/agentic/commercial/free-run-allowance", "op1", {
      family: "goal",
      runs: -1,
    });
    expect(badRuns?.status).toBe(400);
    const fractional = await call(ctx, "POST", "/payments/agentic/commercial/free-run-allowance", "op1", {
      family: "goal",
      runs: 2.5,
    });
    expect(fractional?.status).toBe(400);
  });

  it("a zero allowance disables free runs for that family", async () => {
    const { ctx } = await setup();
    const set = await call(ctx, "POST", "/payments/agentic/commercial/free-run-allowance", "op1", {
      family: "stock",
      runs: 0,
    });
    expect(set?.status).toBe(200);
    const reread = await call(ctx, "GET", "/payments/agentic/commercial/free-run-allowance", "op1");
    const body = (await reread?.json()) as { allowances: Array<{ family: string; runs: number | null }> };
    expect(body.allowances.find((row) => row.family === "stock")).toEqual({ family: "stock", runs: 0 });
  });
});
