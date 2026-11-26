/**
 * Issue #2137 (checkout follow-ups): paid-submission ownership.
 *
 * Part A runs the new CommercialStore methods against both
 * adapters (in-memory + real Drizzle over node:sqlite): record /
 * read, first-record-wins on re-record, unknown reads null.
 *
 * Part B runs the route contract through
 * handleAgenticPaymentsRoutes: submit records the verified
 * session login as owner; submission-status then returns 200
 * only to that owner, 403 to another verified user, 404 for an
 * unknown workflowId, 401 unauthenticated, and 503 when the
 * store is unavailable (fail closed). The pre-existing
 * "unguessable id" standard is replaced, not supplemented.
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
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import type { CommercialStore } from "../src/data/commercialPorts";
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

async function makeStores(): Promise<{ memory: CommercialStore; d1: CommercialStore }> {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  return { memory: new InMemoryCommercialAdapter(), d1: new D1CommercialAdapter(db) };
}

describe("paid-submission port (#2137 follow-ups)", () => {
  it("records and reads back; unknown reads null", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      const record = await store.recordPaidSubmission({
        workflowId: "wf-1",
        userId: "u1",
        runRequestId: "run-1",
      });
      expect(record.userId).toBe("u1");
      expect(record.runRequestId).toBe("run-1");
      expect(await store.getPaidSubmission("wf-1")).toMatchObject({
        workflowId: "wf-1",
        userId: "u1",
        runRequestId: "run-1",
      });
      expect(await store.getPaidSubmission("wf-nope")).toBeNull();
    }
  });

  it("first record wins: a re-record cannot steal ownership", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      await store.recordPaidSubmission({ workflowId: "wf-2", userId: "u1", runRequestId: "run-2" });
      const second = await store.recordPaidSubmission({
        workflowId: "wf-2",
        userId: "attacker",
        runRequestId: "run-3",
      });
      expect(second.userId).toBe("u1");
      expect((await store.getPaidSubmission("wf-2"))?.userId).toBe("u1");
    }
  });

  it("rejects empty workflowId, userId, or runRequestId", async () => {
    const { memory, d1 } = await makeStores();
    for (const store of [memory, d1]) {
      await expect(
        store.recordPaidSubmission({ workflowId: "", userId: "u1", runRequestId: "run-1" }),
      ).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
      await expect(
        store.recordPaidSubmission({ workflowId: "wf-3", userId: "", runRequestId: "run-1" }),
      ).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
    }
  });
});

async function setup() {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
  };
  const screenerBinding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id: `screen-${id}` })),
    get: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
  const env = {
    // Phase 3 (#6550): monetization is ON via
    // environment.config.json; with no resolved account the paid
    // submit path fails closed with 403 before reaching the
    // credit-redemption / payment branches. These tests pin
    // submission ownership, not the paid path, so the free path
    // (flag OFF) stays on here.
    MONETIZATION_ENABLED: "false",
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

const submitBody = {
  family: "goal",
  tenantId: "t1",
  email: "u1@example.com",
  screenerCommand,
};

describe("submission-status ownership (#2137 follow-ups)", () => {
  it("submit records the owner; only the owner reads the status", async () => {
    const { ctx, db } = await setup();
    const submitted = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(submitted?.status).toBe(200);
    const sub = (await submitted?.json()) as { status: string; workflowId: string; runRequestId: string };
    expect(sub.status).toBe("payment_started");
    expect(sub.workflowId).toBe(sub.runRequestId);

    const store = new D1CommercialAdapter(db);
    expect((await store.getPaidSubmission(sub.workflowId))?.userId).toBe("u1");

    const owner = await call(
      ctx,
      "GET",
      `/payments/agentic/commercial/submission-status?workflowId=${sub.workflowId}`,
      "u1",
    );
    expect(owner?.status).toBe(200);
    expect(((await owner?.json()) as { status: string }).status).toBe("completed");
  });

  it("another verified user gets 403 on someone else's submission", async () => {
    const { ctx } = await setup();
    const submitted = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    const sub = (await submitted?.json()) as { workflowId: string };
    const other = await call(
      ctx,
      "GET",
      `/payments/agentic/commercial/submission-status?workflowId=${sub.workflowId}`,
      "u2",
    );
    expect(other?.status).toBe(403);
  });

  it("an unknown workflowId gets 404, not a binding read", async () => {
    const { ctx, binding } = await setup();
    const res = await call(
      ctx,
      "GET",
      "/payments/agentic/commercial/submission-status?workflowId=wf-never-submitted",
      "u1",
    );
    expect(res?.status).toBe(404);
    expect(binding.get).not.toHaveBeenCalled();
  });

  it("unauthenticated gets 401 and a missing workflowId gets 400", async () => {
    const { ctx } = await setup();
    const anon = await call(
      ctx,
      "GET",
      "/payments/agentic/commercial/submission-status?workflowId=wf-1",
      null,
    );
    expect(anon?.status).toBe(401);
    const missing = await call(ctx, "GET", "/payments/agentic/commercial/submission-status", "u1");
    expect(missing?.status).toBe(400);
  });

  it("fails closed with 503 when the store is unavailable", async () => {
    const { ctx } = await setup();
    const noDbCtx = {
      ...ctx,
      env: { ...(ctx.env as Record<string, unknown>), AGENT_DB: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const res = await call(
      noDbCtx,
      "GET",
      "/payments/agentic/commercial/submission-status?workflowId=wf-1",
      "u1",
    );
    expect(res?.status).toBe(503);
  });

  it("a credit-redeemed submission is owned by its submitter too", async () => {
    const { ctx, db } = await setup();
    const store = new D1CommercialAdapter(db);
    await store.recordCreditClaim({ creditRunId: "run-9", userId: "u1", family: "goal", amountUSD: 0.1 });
    const submitted = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(submitted?.status).toBe(200);
    const sub = (await submitted?.json()) as { status: string; workflowId: string };
    expect(sub.status).toBe("redeemed_started");
    const other = await call(
      ctx,
      "GET",
      `/payments/agentic/commercial/submission-status?workflowId=${sub.workflowId}`,
      "u2",
    );
    expect(other?.status).toBe(403);
    const owner = await call(
      ctx,
      "GET",
      `/payments/agentic/commercial/submission-status?workflowId=${sub.workflowId}`,
      "u1",
    );
    expect(owner?.status).toBe(200);
  });
});
