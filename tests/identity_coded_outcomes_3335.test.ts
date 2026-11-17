/**
 * Issue #3335 — the identity GET failure must name its cause.
 *
 * Diagnosis (~/workspace/cfagent-3256-notes/3335-DIAGNOSIS.md, parent-verified):
 * the identity GET cannot return 202, so #3335 is NOT the #3309 bug. What it
 * CAN return, and what the owner's Network read would have discriminated:
 * 401 (x-user-login absent at dispatch), 503 (AGENT_DB unbound), 503 (schema
 * ensure throws), 503 (resolvePlatformIdentity throws). Before this slice
 * all four collapsed into two generic bodies — 401 FAILURE_AUTH_NO_SESSION
 * with raw text (whose catalog message is E*TRADE-specific, so the handler
 * could not even use codedMessage), and 503
 * FAILURE_COMMERCIAL_STORE_UNAVAILABLE / FAILURE_COMMERCIAL_SERVICE_UNAVAILABLE
 * — so a failing session named no cause. The owner's Network read never
 * landed, so the cause in the original session stays unknown; each mode is
 * now diagnosable instead.
 *
 * RED first: the three FAILURE_IDENTITY_* codes do not exist yet, so the
 * coded-body assertions below fail until the catalog + handler land.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import { codedMessage } from "../src/outcomes/outcomeAspects";
import type { DatabaseORM } from "../src/orm";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors #2219). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  /** When set, SELECTs on the commercial-account table throw (resolve failure). */
  throwOnCommercialSelect = false;
  /** When set, schema-ensure DDL throws (schema-ensure failure). */
  throwOnSchemaEnsure = false;
  prepare(sql: string) {
    const db = this.sqlite;
    if (
      this.throwOnCommercialSelect &&
      /^\s*select/i.test(sql) &&
      sql.includes("commercial_account")
    ) {
      throw new Error("boom-store-failure");
    }
    if (this.throwOnSchemaEnsure && /^\s*create\s+table/i.test(sql)) {
      throw new Error("boom-schema-ensure");
    }
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

async function setup(opts: { throwOnCommercialSelect?: boolean; throwOnSchemaEnsure?: boolean } = {}) {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
  // Flags are set AFTER setup: setup itself must succeed so the
  // failure is the request's, not the fixture's.
  if (opts.throwOnCommercialSelect) mock.throwOnCommercialSelect = true;
  if (opts.throwOnSchemaEnsure) mock.throwOnSchemaEnsure = true;
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: {
      create: vi.fn(async ({ id }: { id: string }) => ({ workflowId: id })),
      get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
    },
    SCREENER_WORKFLOW: {
      create: vi.fn(async ({ id }: { id: string }) => ({ id })),
      get: vi.fn(async () => {
        throw new Error("not found");
      }),
    },
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, mock };
}

const callIdentity = (
  ctx: AgenticPaymentsRouteContext,
  login: string | null,
  opts: { unbound?: boolean } = {},
) => {
  const env = opts.unbound
    ? { ...((ctx.env as unknown as Record<string, unknown>) ?? {}), AGENT_DB: undefined }
    : ctx.env;
  const useCtx = opts.unbound
    ? ({ ...ctx, env } as unknown as AgenticPaymentsRouteContext)
    : ctx;
  const url = new URL("https://agent.internal/api/payments/agentic/commercial/identity");
  const req = new Request(url, {
    method: "GET",
    headers: login ? { "x-user-login": login } : {},
  });
  return handleAgenticPaymentsRoutes(req, url, url.pathname, "sess-1", useCtx);
};

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("identity GET failure modes (#3335) — one distinct coded outcome each", () => {
  it("401 login-absent: FAILURE_IDENTITY_LOGIN_REQUIRED, coded, never the E*TRADE session text", async () => {
    const { ctx } = await setup();
    const res = await callIdentity(ctx, null);
    expect(res?.status).toBe(401);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_IDENTITY_LOGIN_REQUIRED");
    expect(body.error).toBe(codedMessage("FAILURE_IDENTITY_LOGIN_REQUIRED"));
    expect(body.error).not.toContain("E*TRADE");
    expect(body.error).not.toContain("Unauthorized: verified login required.");
  });

  it("503 store-unbound: FAILURE_COMMERCIAL_STORE_UNAVAILABLE, coded", async () => {
    const { ctx } = await setup();
    const res = await callIdentity(ctx, "u1", { unbound: true });
    expect(res?.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");
    expect(body.error).toBe(codedMessage("FAILURE_COMMERCIAL_STORE_UNAVAILABLE"));
  });

  it("503 schema-ensure throw: FAILURE_IDENTITY_SCHEMA_UNAVAILABLE, coded, distinct from store-unbound", async () => {
    const { ctx } = await setup({ throwOnSchemaEnsure: true });
    const res = await callIdentity(ctx, "u1");
    expect(res?.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_IDENTITY_SCHEMA_UNAVAILABLE");
    expect(body.error).toBe(codedMessage("FAILURE_IDENTITY_SCHEMA_UNAVAILABLE"));
    expect(body.code).not.toBe("FAILURE_COMMERCIAL_STORE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("boom-schema-ensure");
  });

  it("503 resolve throw: FAILURE_IDENTITY_READ_FAILED, coded, no raw store text", async () => {
    const { ctx } = await setup({ throwOnCommercialSelect: true });
    const res = await callIdentity(ctx, "u1");
    expect(res?.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_IDENTITY_READ_FAILED");
    expect(body.error).toBe(codedMessage("FAILURE_IDENTITY_READ_FAILED"));
    expect(JSON.stringify(body)).not.toContain("boom-store-failure");
  });

  it("the four failure bodies carry four different codes", async () => {
    const { ctx: ctx401 } = await setup();
    const { ctx: ctxUnbound } = await setup();
    const { ctx: ctxSchema } = await setup({ throwOnSchemaEnsure: true });
    const { ctx: ctxResolve } = await setup({ throwOnCommercialSelect: true });
    const codes = new Set([
      (await bodyOf(await callIdentity(ctx401, null))).code,
      (await bodyOf(await callIdentity(ctxUnbound, "u1", { unbound: true }))).code,
      (await bodyOf(await callIdentity(ctxSchema, "u1"))).code,
      (await bodyOf(await callIdentity(ctxResolve, "u1"))).code,
    ]);
    expect(codes.size).toBe(4);
  });

  it("happy path is unchanged: 200 with SUCCESS_IDENTITY_READ", async () => {
    const { ctx } = await setup();
    const res = await callIdentity(ctx, "u1");
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.code).toBe("SUCCESS_IDENTITY_READ");
    expect(body.userLogin).toBe("u1");
    expect(body.hasAccount).toBe(false);
  });
});
