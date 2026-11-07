/**
 * Issue #932: gateway webhook settlement was a silent no-op.
 *
 * External payment webhooks are intercepted in src/server.ts and forwarded
 * to the OrchestratorAgent instance `system_webhook_receiver` — but payment
 * drafts are created in PER-USER instances (POST /payments/create, the MAS
 * draftPayment tool, the MCP draft_payment command), each with its own
 * SQLite store. The settlement UPDATE in the webhook handler therefore ran
 * against the receiver instance's (empty) mas_transactions, matched 0 rows
 * for every real draft, and the handler still returned { received: true }
 * and audited payment.settled_webhook into the wrong instance.
 *
 * The fix, pinned here end to end:
 * - every draft create path records draftId → owning instance in the
 *   SessionStore "payments" bucket (key `draftowner:<draftId>`, value = the
 *   session identity the draft row was written under — the same identity
 *   stored in the row's session_id), written with the store's atomic
 *   consume op so the first owner stands;
 * - the webhook handler, after the unchanged provider + HMAC gates, settles
 *   LOCALLY when the row is in its own store (ownership by possession);
 *   otherwise it resolves the owner from the registry and forwards the
 *   verified webhook (raw body + original headers + an
 *   `x-webhook-settlement-owner` routing header) to the owning instance,
 *   which re-verifies and settles in its own store, so the audit lands in
 *   the owning instance too;
 * - a settlement that matches no draft is LOUD: HTTP 404 with
 *   { received: false, settled: false, unmatched: true }, a structured
 *   `payments.webhook_settlement_unmatched` error event (level error, on
 *   the console-info JSON fallback — #3515 S3), and a
 *   payment.settled_webhook_unmatched audit in the instance that
 *   determined the miss — never a silent { received: true }.
 *
 * Tenant isolation: routing derives ONLY from the registry entry written
 * by the owning instance's own create flow; the webhook payload contributes
 * nothing but the draftId. A settlement hop addressed to another tenant is
 * refused (502, misrouted) and settles nothing.
 *
 * Harness mirrors tests/payment_webhook_default_deny.test.ts (#148) and
 * tests/payment_create_gateway_validation.test.ts (#156): agent-SDK module
 * mocks, one real OrchestratorAgent per instance over its own
 * MockSqlStorage, genuine HMAC signatures via the repo's crypto helper,
 * fetch stubbed at the gateways' real endpoints. The SessionStore fake
 * implements the durableKv JSON wire protocol (get/put/delete/consume)
 * with the same semantics as src/security/sessionStore.ts, and the
 * ORCHESTRATOR_AGENT fake dispatches stub fetches to the addressed agent —
 * together they model the two Durable Object channels the fix uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// src/agents/orchestrator.ts pulls in `cloudflare:`-adjacent SDK entry
// points the node test loader cannot resolve. Mock them with plain
// stand-ins (same pattern as tests/payment_webhook_default_deny.test.ts).
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
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { createMAS } from "../src/agents/mas";
import { DraftPaymentCommand } from "../src/mcps/openaimp/commands";
import { DatabaseORM } from "../src/orm";
import { createStoreKv, type DoNamespaceLike } from "../src/data/durableKv";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const STRIPE_WH_SECRET = "whsec_unit_test_932";
const SENTINEL_TS = "2020-01-01T00:00:00.000Z";

const RECEIVER = "sess-webhook-receiver";
const ALICE = "sess-alice";
const BOB = "sess-bob";
const DAVE = "sess-dave";

/** SessionStore fake: the durableKv JSON wire protocol over a Map. */
class FakeSessionStore {
  entries = new Map<string, { value: string; expiresAt: number | null }>();

  idFromName(name: string) {
    return name;
  }

  get(_id: unknown) {
    const entries = this.entries;
    return {
      fetch: async (req: Request) => {
        const body = (await req.json()) as any;
        const k = `${body.ns}:${body.key}`;
        const now = Date.now();
        const live = () => {
          const e = entries.get(k);
          if (!e) return undefined;
          if (e.expiresAt !== null && e.expiresAt <= now) {
            entries.delete(k);
            return undefined;
          }
          return e;
        };
        switch (body.op) {
          case "get": {
            const e = live();
            return Response.json({ value: e ? e.value : null });
          }
          case "put": {
            entries.set(k, {
              value: body.value,
              expiresAt: typeof body.ttl === "number" ? now + body.ttl * 1000 : null,
            });
            return Response.json({ ok: true });
          }
          case "delete": {
            entries.delete(k);
            return Response.json({ ok: true });
          }
          case "consume": {
            if (live()) return Response.json({ consumed: false });
            entries.set(k, {
              value: body.value ?? "",
              expiresAt: typeof body.ttl === "number" ? now + body.ttl * 1000 : null,
            });
            return Response.json({ consumed: true });
          }
        }
        return Response.json({ error: "bad op" }, { status: 400 });
      },
    };
  }
}

/** ORCHESTRATOR_AGENT fake: stub fetches dispatch to the addressed agent. */
class FakeAgentNamespace {
  agents = new Map<string, OrchestratorAgent>();

  idFromName(name: string) {
    return name;
  }

  idFromString(id: string) {
    return id;
  }

  get(key: unknown) {
    const agents = this.agents;
    return {
      fetch: async (req: Request) => {
        const agent = agents.get(String(key));
        if (!agent) return Response.json({ error: "unknown instance" }, { status: 404 });
        return agent.onRequest(req);
      },
    };
  }
}

interface World {
  env: Env;
  store: FakeSessionStore;
  ns: FakeAgentNamespace;
  agents: Map<string, { agent: OrchestratorAgent; sql: MockSqlStorage }>;
}

function makeWorld(): World {
  const store = new FakeSessionStore();
  const ns = new FakeAgentNamespace();
  const env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: ns as any,
    SESSION_STORE: store as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: STRIPE_WH_SECRET,
  } as Env;

  const agents = new Map<string, { agent: OrchestratorAgent; sql: MockSqlStorage }>();
  for (const identity of [RECEIVER, ALICE, BOB, DAVE]) {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => identity, name: identity },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    agents.set(identity, { agent, sql });
    ns.agents.set(identity, agent);
  }
  return { env, store, ns, agents };
}

/** Fetch stubbed at the gateways' real endpoints, as in the #156 tests. */
function stubGatewayFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "cs_test_932", url: "https://checkout.stripe.com/c/pay/cs_test_932" }),
        } as any;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    })
  );
}

async function stripeSignature(body: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const v1 = await computeHmacSha256Hex(secret, `${ts}.${body}`);
  return `t=${ts},v1=${v1}`;
}

const txRow = (sql: MockSqlStorage, draftId: string) =>
  (Array.from(sql.exec("SELECT * FROM mas_transactions WHERE id = ?", draftId)) as any[])[0];

const auditsOf = (sql: MockSqlStorage, type: string) =>
  Array.from(sql.exec("SELECT * FROM mas_events WHERE type = ?", type)) as any[];

/** Create a draft through the real POST /payments/create route in `identity`'s instance. */
async function createDraftViaRoute(world: World, identity: string): Promise<string> {
  const { agent } = world.agents.get(identity)!;
  const res = await agent.onRequest(
    new Request("https://agent.internal/payments/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 25,
        currency: "USD",
        customer: "Acme Corp",
        gateway: "stripe",
        description: "webhook settlement test draft",
      }),
    })
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  expect(json.success).toBe(true);
  const draftId = json.transaction.id as string;
  // Model time passing between creation and the gateway webhook so the
  // settle UPDATE's updated_at is distinguishable (the #148 sentinel).
  world.agents.get(identity)!.sql.exec("UPDATE mas_transactions SET updated_at = ? WHERE id = ?", SENTINEL_TS, draftId);
  return draftId;
}

/** Deliver a genuinely signed Stripe webhook naming `draftId` to an instance. */
async function postStripeWebhook(
  world: World,
  identity: string,
  draftId: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const body = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { client_reference_id: draftId } },
  });
  const { agent } = world.agents.get(identity)!;
  return agent.onRequest(
    new Request("https://agent.internal/payments/webhook?provider=stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": await stripeSignature(body, STRIPE_WH_SECRET),
        ...extraHeaders,
      },
      body,
    })
  );
}

/** Read the registry exactly as production code does (SessionStore "payments" bucket). */
async function registeredOwner(world: World, draftId: string): Promise<string | null> {
  const kv = createStoreKv({
    namespace: world.env.SESSION_STORE as unknown as DoNamespaceLike,
    namespaceName: "payments",
    legacyFallback: false,
  });
  return kv.get(`draftowner:${draftId}`);
}

describe("gateway webhook settlement routes to the draft-owning instance (#932)", () => {
  let world: World;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    world = makeWorld();
    stubGatewayFetch();
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    infoSpy.mockRestore();
  });

  it("end to end: a draft created in a per-user instance settles from a webhook delivered to the receiver instance", async () => {
    const draftId = await createDraftViaRoute(world, ALICE);

    // The draft lives ONLY in Alice's store, registered to Alice.
    expect(txRow(world.agents.get(ALICE)!.sql, draftId)).toBeTruthy();
    expect(txRow(world.agents.get(RECEIVER)!.sql, draftId)).toBeUndefined();
    expect(await registeredOwner(world, draftId)).toBe(ALICE);

    const res = await postStripeWebhook(world, RECEIVER, draftId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.received).toBe(true);
    expect(json.settled).toBe(true);

    // The OWNING instance's row settled (updated_at advanced past the
    // sentinel — MockSqlStorage applies only parameterized assignments,
    // the #148 assertion style) and the settled audit landed THERE.
    const aliceSql = world.agents.get(ALICE)!.sql;
    expect(txRow(aliceSql, draftId)?.updated_at).not.toBe(SENTINEL_TS);
    const settled = auditsOf(aliceSql, "payment.settled_webhook");
    expect(settled).toHaveLength(1);
    expect(JSON.parse(settled[0].payload).draftId).toBe(draftId);

    // The receiver audited no settlement of its own, and no other
    // instance was touched.
    expect(auditsOf(world.agents.get(RECEIVER)!.sql, "payment.settled_webhook")).toHaveLength(0);
    expect(txRow(world.agents.get(BOB)!.sql, draftId)).toBeUndefined();
    expect(auditsOf(world.agents.get(BOB)!.sql, "payment.settled_webhook")).toHaveLength(0);
  });

  it("an unmatched settlement is loud: 404, unmatched audit in the receiver, structured error event, nothing settled", async () => {
    const res = await postStripeWebhook(world, RECEIVER, "pay_no_such_draft");
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.received).toBe(false);
    expect(json.settled).toBe(false);
    expect(json.unmatched).toBe(true);
    // #3515 S3: the unmatched settlement now travels as a structured
    // payments.webhook_settlement_unmatched event (level error) on the
    // console-info JSON fallback, not a console.error line.
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const unmatchedEvent = events.find((e) => e.operation === "payments.webhook_settlement_unmatched");
    expect(unmatchedEvent).toBeDefined();
    expect(unmatchedEvent?.level).toBe("error");
    expect(unmatchedEvent?.fields.draftId).toBe("pay_no_such_draft");
    expect(String(unmatchedEvent?.fields.message ?? "")).toContain("webhook settlement unmatched");

    const unmatched = auditsOf(world.agents.get(RECEIVER)!.sql, "payment.settled_webhook_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(JSON.parse(unmatched[0].payload).draftId).toBe("pay_no_such_draft");
    expect(auditsOf(world.agents.get(RECEIVER)!.sql, "payment.settled_webhook")).toHaveLength(0);
  });

  it("a registered owner whose row is missing is loud at the owner, and the receiver propagates it", async () => {
    // A registration exists for Dave but no draft row exists anywhere
    // (e.g. the row was removed after registration).
    const kv = createStoreKv({
      namespace: world.env.SESSION_STORE as unknown as DoNamespaceLike,
      namespaceName: "payments",
      legacyFallback: false,
    });
    await kv.put("draftowner:pay_ghost_932", DAVE);

    const res = await postStripeWebhook(world, RECEIVER, "pay_ghost_932");
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.received).toBe(false);
    expect(json.unmatched).toBe(true);

    const unmatched = auditsOf(world.agents.get(DAVE)!.sql, "payment.settled_webhook_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(JSON.parse(unmatched[0].payload).reason).toBe("owner_row_missing");
    expect(auditsOf(world.agents.get(DAVE)!.sql, "payment.settled_webhook")).toHaveLength(0);
  });

  it("tenant isolation, both directions: each webhook settles only its own tenant's draft", async () => {
    const aliceDraft = await createDraftViaRoute(world, ALICE);
    const bobDraft = await createDraftViaRoute(world, BOB);
    const aliceSql = world.agents.get(ALICE)!.sql;
    const bobSql = world.agents.get(BOB)!.sql;

    // Bob's settlement settles Bob's row and leaves Alice's untouched.
    const resBob = await postStripeWebhook(world, RECEIVER, bobDraft);
    expect(resBob.status).toBe(200);
    expect(txRow(bobSql, bobDraft)?.updated_at).not.toBe(SENTINEL_TS);
    expect(txRow(aliceSql, aliceDraft)?.updated_at).toBe(SENTINEL_TS);
    expect(auditsOf(aliceSql, "payment.settled_webhook")).toHaveLength(0);
    expect(auditsOf(bobSql, "payment.settled_webhook")).toHaveLength(1);

    // Alice's settlement then settles Alice's row only.
    const resAlice = await postStripeWebhook(world, RECEIVER, aliceDraft);
    expect(resAlice.status).toBe(200);
    expect(txRow(aliceSql, aliceDraft)?.updated_at).not.toBe(SENTINEL_TS);
  });

  it("a settlement hop addressed to another tenant is refused and settles nothing", async () => {
    const aliceDraft = await createDraftViaRoute(world, ALICE);
    const aliceSql = world.agents.get(ALICE)!.sql;

    // Deliver the webhook straight to Alice's instance but addressed
    // (via the internal routing header) to Bob: Alice must refuse —
    // she never settles on another tenant's behalf.
    const res = await postStripeWebhook(world, ALICE, aliceDraft, {
      "x-webhook-settlement-owner": BOB,
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.received).toBe(false);
    expect(json.settled).toBe(false);
    expect(txRow(aliceSql, aliceDraft)?.updated_at).toBe(SENTINEL_TS);
    expect(auditsOf(aliceSql, "payment.settled_webhook")).toHaveLength(0);
    const unmatched = auditsOf(aliceSql, "payment.settled_webhook_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(JSON.parse(unmatched[0].payload).reason).toBe("misrouted");
  });

  it("a draft in the receiving instance itself still settles locally (ownership by possession)", async () => {
    const draftId = await createDraftViaRoute(world, RECEIVER);
    const res = await postStripeWebhook(world, RECEIVER, draftId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.settled).toBe(true);
    const receiverSql = world.agents.get(RECEIVER)!.sql;
    expect(txRow(receiverSql, draftId)?.updated_at).not.toBe(SENTINEL_TS);
    expect(auditsOf(receiverSql, "payment.settled_webhook")).toHaveLength(1);
  });
});

describe("every draft create path records the owning instance (#932)", () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
    stubGatewayFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the MCP draft_payment command registers its draft's owner", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("sess-mcp");
    const cmd = new DraftPaymentCommand();
    const out = (await cmd.execute(
      { amount: 10, currency: "USD", customer: "Acme Corp", gateway: "stripe" },
      {
        env: world.env,
        orm,
        sessionId: "sess-mcp",
        requestId: "req-932",
        audit: () => {},
      } as any
    )) as any;
    expect(out.draftId).toBeTruthy();
    expect(await registeredOwner(world, out.draftId)).toBe("sess-mcp");
  });

  it("the MAS draftPayment tool registers its draft's owner", async () => {
    const sql = new MockSqlStorage();
    const tools = createMAS({
      env: world.env,
      sessionId: "sess-mas",
      requestId: "req-932",
      sql,
      audit: () => {},
    });
    const payload = (await (tools.draftPayment as any).execute({
      action: "charge",
      amount: 12,
      currency: "USD",
      customer: "Acme Corp",
      gateway: "stripe",
    })) as any;
    expect(payload.draftId).toBeTruthy();
    expect(txRow(sql, payload.draftId)).toBeTruthy();
    expect(await registeredOwner(world, payload.draftId)).toBe("sess-mas");
  });
});
