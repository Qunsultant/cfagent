/**
 * Issue #2222 (program #2218, slice 4) — account administration
 * surface: the platform-accounts routes.
 *
 *   GET  /platform/accounts/self        self-service account view
 *   POST /platform/accounts/setup       self-service account setup
 *   GET  /platform/accounts/lookup      operator lookup by userId
 *
 * Session-scoped ALWAYS: every endpoint derives its subject from
 * the verified session login (x-user-login), never from a
 * client-supplied tenantId; the self endpoints ignore a userId
 * query/body entirely, and the lookup endpoint is operator-gated
 * (env COMMERCIAL_STORE_OPERATORS UNION the store operator list,
 * empty = deny — the #2680 idiom reused from agenticPayments).
 *
 * The setup flow is the destination of slice 1's paid-path
 * no-account message: it reuses the subscription-purchase
 * auto-create derivation (tenant = resolved tenant ?? login,
 * Free tier), never a client-supplied tenant. It never gates
 * free runs — setup is opt-in and the free path proceeds
 * without an account exactly as today.
 *
 * Credit/tier MUTATION is deliberately NOT a new endpoint here:
 * it already exists as the operator-gated
 * POST /payments/agentic/commercial/account (upsert) and
 * POST /payments/agentic/commercial/account/credits routes, and
 * the panel wires to those. No new credit-granting path is
 * invented by this slice.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { PriceCatalogue } from "../src/data/priceCataloguePorts";
import type { StoreOperators } from "../src/data/storeOperatorsPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountRouteContext,
  type PlatformAccountPorts,
} from "../src/agents/routes/platformAccounts";

function makePorts(overrides: Partial<PlatformAccountPorts> = {}): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    ...overrides,
  };
}

function makeCtx(
  ports: PlatformAccountPorts,
  env: Record<string, unknown> = {},
): PlatformAccountRouteContext {
  return { env: env as never, audit: vi.fn(), ports } as PlatformAccountRouteContext;
}

function req(method: string, path: string, login?: string, body?: unknown): Request {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(
  ctx: PlatformAccountRouteContext,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const url = new URL(request.url);
  const res = await handlePlatformAccountRoutes(request, url, url.pathname, "session-1", ctx);
  if (!res) return null;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("platform account routes (#2222)", () => {
  it("returns null for non-matching paths", async () => {
    const ctx = makeCtx(makePorts());
    expect(await call(ctx, req("GET", "/platform/accounts/nope", "alice"))).toBeNull();
    expect(await call(ctx, req("GET", "/other", "alice"))).toBeNull();
  });

  it("self read requires a verified login (401 without one)", async () => {
    const ctx = makeCtx(makePorts());
    const res = await call(ctx, req("GET", "/platform/accounts/self"));
    expect(res?.status).toBe(401);
  });

  it("self read with no account reports hasAccount false, never a guessed tenant", async () => {
    const ctx = makeCtx(makePorts());
    const res = await call(ctx, req("GET", "/platform/accounts/self", "alice"));
    expect(res?.status).toBe(200);
    const identity = res?.body.identity as Record<string, unknown>;
    expect(identity.userLogin).toBe("alice");
    expect(identity.hasAccount).toBe(false);
    expect(identity.tenantId).toBeNull();
    expect(identity.tier).toBe("Free");
    expect(identity.creditsUSD).toBe(0);
    expect(identity.includedRunsRemaining).toBe(0);
    expect(res?.body.subscriptions).toEqual([]);
    expect(res?.body.catalogueAvailable).toBe(true);
    const catalogue = res?.body.catalogue as Array<Record<string, unknown>>;
    expect(catalogue.map((e) => e.family).sort()).toEqual(["options", "stock"]);
    // Seeded catalogue rows are PROPOSED until an operator approves them (#2547).
    expect(catalogue.every((e) => e.approvalStatus === "proposed")).toBe(true);
  });

  it("self read ignores a userId query: it never returns another user's account", async () => {
    const ports = makePorts();
    await ports.commercial!.upsertAccount({
      userId: "victim",
      tenantId: "tenant-victim",
      tier: "PayPerUse",
      creditsUSD: 9,
      includedRuns: 4,
    });
    const ctx = makeCtx(ports);
    const res = await call(ctx, req("GET", "/platform/accounts/self?userId=victim", "alice"));
    expect(res?.status).toBe(200);
    const identity = res?.body.identity as Record<string, unknown>;
    expect(identity.userLogin).toBe("alice");
    expect(identity.hasAccount).toBe(false);
  });

  it("setup creates a Free account from the session login and is idempotent", async () => {
    const ports = makePorts();
    const ctx = makeCtx(ports);
    const first = await call(ctx, req("POST", "/platform/accounts/setup", "alice"));
    expect(first?.status).toBe(200);
    expect(first?.body.created).toBe(true);
    const identity = first?.body.identity as Record<string, unknown>;
    expect(identity.hasAccount).toBe(true);
    expect(identity.tenantId).toBe("alice");
    expect(identity.tier).toBe("Free");
    const stored = await ports.commercial!.getAccount("alice");
    expect(stored?.tenantId).toBe("alice");
    expect(stored?.tier).toBe("Free");
    const second = await call(ctx, req("POST", "/platform/accounts/setup", "alice"));
    expect(second?.status).toBe(200);
    expect(second?.body.created).toBe(false);
    expect((second?.body.identity as Record<string, unknown>).tenantId).toBe("alice");
  });

  it("setup never trusts a client-supplied tenantId in the body", async () => {
    const ports = makePorts();
    const ctx = makeCtx(ports);
    const res = await call(ctx, req("POST", "/platform/accounts/setup", "alice", { tenantId: "evil-tenant" }));
    expect(res?.status).toBe(200);
    expect((res?.body.identity as Record<string, unknown>).tenantId).toBe("alice");
  });

  it("setup preserves an existing account's tenant instead of overwriting it", async () => {
    const ports = makePorts();
    await ports.commercial!.upsertAccount({
      userId: "alice",
      tenantId: "tenant-real",
      tier: "PayPerUse",
      creditsUSD: 3,
      includedRuns: 1,
    });
    const ctx = makeCtx(ports);
    const res = await call(ctx, req("POST", "/platform/accounts/setup", "alice"));
    expect(res?.body.created).toBe(false);
    expect((res?.body.identity as Record<string, unknown>).tenantId).toBe("tenant-real");
  });

  it("self read reflects tier, credits, included runs, and subscriptions", async () => {
    const ports = makePorts();
    await ports.commercial!.upsertAccount({
      userId: "alice",
      tenantId: "tenant-alice",
      tier: "Subscribed",
      tierSource: "subscription",
      creditsUSD: 7.5,
      includedRuns: 2,
    });
    const now = Date.now();
    await ports.subscriptions!.createSubscription({
      id: "sub-1",
      userId: "alice",
      tenantId: "tenant-alice",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "pay-1",
      periodStartMs: now - 1000,
      periodEndMs: now + 86_400_000,
    });
    const ctx = makeCtx(ports);
    const res = await call(ctx, req("GET", "/platform/accounts/self", "alice"));
    expect(res?.status).toBe(200);
    const identity = res?.body.identity as Record<string, unknown>;
    expect(identity.tier).toBe("Subscribed");
    expect(identity.creditsUSD).toBe(7.5);
    expect(identity.includedRunsRemaining).toBe(2);
    const subs = res?.body.subscriptions as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(1);
    expect(subs[0].planId).toBe("plan-pro");
    expect(subs[0].periodEndMs).toBe(now + 86_400_000);
  });

  it("lookup requires a verified login, a userId, and operator status", async () => {
    const ports = makePorts();
    await ports.commercial!.upsertAccount({
      userId: "bob",
      tenantId: "tenant-bob",
      tier: "Free",
      creditsUSD: 1,
      includedRuns: 0,
    });
    const ctx = makeCtx(ports);
    expect((await call(ctx, req("GET", "/platform/accounts/lookup?userId=bob")))?.status).toBe(401);
    // The gate runs before validation, so a non-operator gets 403
    // even with a missing userId; an operator gets the 400.
    expect((await call(ctx, req("GET", "/platform/accounts/lookup", "alice")))?.status).toBe(403);
    const opCtx = makeCtx(ports, { COMMERCIAL_STORE_OPERATORS: "op-env" });
    expect((await call(opCtx, req("GET", "/platform/accounts/lookup", "op-env")))?.status).toBe(400);
    expect(
      (await call(ctx, req("GET", "/platform/accounts/lookup?userId=bob", "alice")))?.status,
    ).toBe(403);
    // A store-operator row also grants lookup (env UNION store, #2680).
    await ports.operators!.addOperator({ login: "op-store", addedBy: "bootstrap" });
    const asStoreOp = await call(ctx, req("GET", "/platform/accounts/lookup?userId=bob", "op-store"));
    expect(asStoreOp?.status).toBe(200);
    expect((asStoreOp?.body.identity as Record<string, unknown>).userLogin).toBe("bob");
    // An env-listed operator grants lookup too.
    const envCtx = makeCtx(ports, { COMMERCIAL_STORE_OPERATORS: "op-env, other" });
    const asEnvOp = await call(envCtx, req("GET", "/platform/accounts/lookup?userId=bob", "op-env"));
    expect(asEnvOp?.status).toBe(200);
    expect((asEnvOp?.body.identity as Record<string, unknown>).tenantId).toBe("tenant-bob");
  });

  it("lookup of an unknown user reports hasAccount false, not an error", async () => {
    const ctx = makeCtx(makePorts(), { COMMERCIAL_STORE_OPERATORS: "op-env" });
    const res = await call(ctx, req("GET", "/platform/accounts/lookup?userId=ghost", "op-env"));
    expect(res?.status).toBe(200);
    expect((res?.body.identity as Record<string, unknown>).hasAccount).toBe(false);
  });

  it("unbound stores fail closed with 503, never a silent Free view", async () => {
    const ctx = makeCtx(
      {
        commercial: null,
        subscriptions: null,
        prices: null,
        operators: null,
      },
      { COMMERCIAL_STORE_OPERATORS: "op-env" },
    );
    expect((await call(ctx, req("GET", "/platform/accounts/self", "alice")))?.status).toBe(503);
    expect((await call(ctx, req("POST", "/platform/accounts/setup", "alice")))?.status).toBe(503);
    expect(
      (await call(ctx, req("GET", "/platform/accounts/lookup?userId=bob", "op-env")))?.status,
    ).toBe(503);
  });

  it("an unbound catalogue is reported as unavailable, not as an empty price list", async () => {
    const ports = makePorts({ prices: null });
    const ctx = makeCtx(ports);
    const res = await call(ctx, req("GET", "/platform/accounts/self", "alice"));
    expect(res?.status).toBe(200);
    expect(res?.body.catalogueAvailable).toBe(false);
    expect(res?.body.catalogue).toEqual([]);
  });

  it("setup audits the creation, and a replay audits nothing new", async () => {
    const ports = makePorts();
    const ctx = makeCtx(ports);
    await call(ctx, req("POST", "/platform/accounts/setup", "alice"));
    await call(ctx, req("POST", "/platform/accounts/setup", "alice"));
    const audit = ctx.audit as unknown as ReturnType<typeof vi.fn>;
    const created = audit.mock.calls.filter(
      (c: unknown[]) => c[0] === "platform.account.created",
    );
    expect(created).toHaveLength(1);
    expect(created[0][2]).toMatchObject({ userLogin: "alice", tenantId: "alice" });
  });
});
