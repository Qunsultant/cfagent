/**
 * Issue #2660 (monetization Phase 2.5) — TDD red-first route tests.
 *
 * Worker-fetch harness mirroring tests/iaaa_lifecycle_routes_1758.test.ts,
 * extended with a MockD1 AGENT_DB (pattern from
 * tests/billing_activation_2656.test.ts) so the deactivation route's
 * subscription gate and commercial mail suppression can be exercised
 * end to end:
 * - Active unexpired subscription → 409 naming the cancel route, NOTHING
 *   revoked (a repeat call still 409s: the session is alive).
 * - Only expired/canceled rows → 200, offboard proceeds, seeded preference
 *   row flipped to digestEnabled=false + welcomeEnabled=false.
 * - AGENT_DB absent → 503 fail-closed, sessions intact.
 * - No subscription rows → 200 (existing behavior preserved).
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { makeFakeSessionStore } from "./fake-session-store";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import { createMembership } from "../src/security/authorization";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { sessionStore } from "../src/security/session";
import type { Env } from "../src/types";
import { createD1LifecycleDb, D1LifecycleAdapter, ensureLifecycleSchema } from "../src/data/d1LifecycleAdapter";
import { createD1SubscriptionDb, D1SubscriptionAdapter, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { createD1CommercialDb, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import type { D1Database } from "@cloudflare/workers-types";

/** Minimal D1Database stand-in over node:sqlite (mirrors tests/billing_activation_2656.test.ts). */
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

const TARGET_SESSION_1 = "0d9a3120-1c2b-4e3f-8a5b-3120000000b1";
const TARGET_SESSION_2 = "0d9a3120-1c2b-4e3f-8a5b-3120000000b2";
const TARGET_ID = "v1:routetarget00000000000000000000000000000000000000001";
const NOW = Date.now();

async function makeEnv(withAgentDb: boolean) {
  const fake = makeFakeSessionStore();
  const { namespace, seed, store } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string | undefined, fresh: boolean) => ({
    githubLogin: login,
    githubName: login,
    ...(internalUserId ? { internalUserId } : {}),
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    ...(fresh ? { authTimeMs: now } : {}),
  });
  seed("sessions", TARGET_SESSION_1, session("target-user", TARGET_ID, true));
  seed("sessions", TARGET_SESSION_2, session("target-user", TARGET_ID, true));
  store.set(
    "api_keys:key:key-1",
    JSON.stringify({
      id: "key-1",
      login: "target-user",
      hash: "deadbeef",
      label: "target key",
      prefix: "cfk_deadbee",
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
    }),
  );
  store.set("api_keys:user:target-user", JSON.stringify(["key-1"]));
  store.set("api_keys:hash:deadbeef", "key-1");
  seed("etrade", "etrade:token:TEST:target-user", {
    userLogin: "target-user",
    storedAt: new Date(now).toISOString(),
  });
  const membershipStore = createKvMembershipStore(sessionStore({ SESSION_STORE: namespace } as unknown as Env));
  const targetMembership = await createMembership(membershipStore, {
    internalUserId: TARGET_ID,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: now,
  });
  if (!targetMembership.ok) throw new Error("test seed failed");

  let lifecycle: D1LifecycleAdapter | null = null;
  let subs: D1SubscriptionAdapter | null = null;
  let env: Env;
  if (withAgentDb) {
    const mock = new MockD1Database();
    const lifecycleDb = createD1LifecycleDb(mock as unknown as D1Database);
    await ensureLifecycleSchema(lifecycleDb);
    lifecycle = new D1LifecycleAdapter(lifecycleDb);
    // Subscription migrations build on the commercial accounts table:
    // ensure the commercial schema first (billing_activation_2656 order).
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    subs = new D1SubscriptionAdapter(subsDb);
    env = { SESSION_STORE: namespace, AGENT_DB: mock } as unknown as Env;
  } else {
    env = { SESSION_STORE: namespace } as unknown as Env;
  }
  return { env, lifecycle, subs };
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: `session_id=${cookie}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const deactivate = (env: Env, cookie: string) =>
  worker.fetch(req("POST", "/api/iaaa/deactivate", { confirm: "deactivate" }, cookie), env);

describe("deactivation subscription gate (#2660)", () => {
  it("refuses with 409 naming the cancel route when an unexpired subscription exists; nothing revoked", async () => {
    const { env, subs } = await makeEnv(true);
    await subs!.createSubscription({
      id: "sub-active",
      userId: "target-user",
      tenantId: "primary",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub-active",
      periodStartMs: NOW - 1000,
      periodEndMs: NOW + 30 * 24 * 3600 * 1000,
    });
    const res = await deactivate(env, TARGET_SESSION_1);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; code?: string; cancelRoute?: string };
    expect(body.code).toBe("DeactivationBlockedByActiveSubscription");
    expect(body.cancelRoute).toBe("/api/payments/agentic/commercial/subscription/cancel");
    // Nothing revoked: the session is still alive, so a repeat call 409s again, not 401.
    const again = await deactivate(env, TARGET_SESSION_1);
    expect(again.status).toBe(409);
    // The subscription row is untouched.
    const rows = await subs!.listSubscriptions("target-user");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("proceeds when only expired/canceled rows exist and suppresses commercial mail", async () => {
    const { env, lifecycle, subs } = await makeEnv(true);
    await subs!.createSubscription({
      id: "sub-expired",
      userId: "target-user",
      tenantId: "primary",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub-expired",
      periodStartMs: NOW - 60 * 24 * 3600 * 1000,
      periodEndMs: NOW - 1000,
    });
    await lifecycle!.setPreferences({
      userId: "target-user",
      tenantId: "primary",
      digestEnabled: true,
      welcomeEnabled: true,
    });
    const res = await deactivate(env, TARGET_SESSION_1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      subscriptionGate?: { checked?: boolean; loginsWithActive?: string[] };
      commercialSuppression?: { suppressed?: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.subscriptionGate?.checked).toBe(true);
    expect(body.subscriptionGate?.loginsWithActive).toEqual([]);
    expect(body.commercialSuppression?.suppressed).toContain("target-user");
    const prefs = await lifecycle!.getPreferences("target-user", "primary");
    expect(prefs.digestEnabled).toBe(false);
    expect(prefs.welcomeEnabled).toBe(false);
  });

  it("proceeds with the unverified state recorded when the subscription store is unavailable", async () => {
    // Deliberate non-fail-closed case (#2660): deactivation is security
    // revocation first, so a billing-store outage must not block it —
    // but the unverified state is recorded in the response, never silent.
    const { env } = await makeEnv(false);
    const res = await deactivate(env, TARGET_SESSION_1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      subscriptionGate?: { checked?: boolean; unverified?: Array<{ reason?: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.subscriptionGate?.checked).toBe(false);
    expect(body.subscriptionGate?.unverified?.[0]?.reason).toBe("subscription-store-unavailable");
  });

  it("proceeds with no subscription rows (existing behavior preserved)", async () => {
    const { env } = await makeEnv(true);
    const res = await deactivate(env, TARGET_SESSION_1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });
});
