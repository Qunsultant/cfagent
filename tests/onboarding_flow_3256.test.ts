/**
 * Issue #3256 (sub-issue of #3241) — Signup → Trial onboarding flow.
 *
 * RED first: the onboarding port, migration 0042, the
 * /platform/onboarding/state routes, and the firstRunApi additions
 * (setupAccount, onboarding state, E*TRADE status, account self
 * view) do not exist yet.
 *
 * Server-side onboarding state is keyed by the VERIFIED session
 * login only: a client-supplied userLogin/tenantId in the POST body
 * is never read, and the tenantId is stamped server-side from the
 * resolved platform identity. A second login gets its own state
 * and its own trial offer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getTableName, isTable } from "drizzle-orm";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import * as drizzleSchema from "../src/data/drizzleSchema";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import type { PlatformAccountPorts } from "../src/agents/routes/platformAccounts";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import {
  FirstRunApiError,
  setupAccount,
  fetchOnboardingState,
  saveOnboardingState,
  fetchETradeStatus,
  startETradeOAuth,
  fetchAccountSelf,
} from "../src/client/firstRunApi";
import { codedMessage } from "../src/outcomes/outcomeAspects";

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch;
}

// Migration 0042 ------------------------------------------------------------

describe("migration 0042 — onboarding state (#3256)", () => {
  it("is registered with a CREATE TABLE for agent_onboarding_state, and the table exists in the drizzle schema", () => {
    const migration = ALL_MIGRATIONS.find((m) => m.version === 42);
    expect(migration).toBeDefined();
    expect(migration!.name).toBe("0042_onboarding_state");
    expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS agent_onboarding_state");
    expect(migration!.sql).toContain("user_login TEXT PRIMARY KEY");
    const drizzleNames = new Set(
      Object.values(drizzleSchema)
        .filter(isTable)
        .map((t) => getTableName(t)),
    );
    expect(drizzleNames.has("agent_onboarding_state")).toBe(true);
  });
});

// Port ----------------------------------------------------------------------

describe("onboarding port (#3256)", () => {
  it("reads absent as null, round-trips per login, and isolates a second login", async () => {
    const store = new InMemoryOnboardingAdapter();
    expect(await store.getOnboardingState("onb-user-a")).toBeNull();
    const saved = await store.saveOnboardingState({
      userLogin: "onb-user-a",
      tenantId: "tenant-a",
      currentStep: 2,
      completedAtMs: null,
      trialPlanId: "plan-trial",
      trialStartedAtMs: 1234,
      updatedAtMs: 1234,
    });
    expect(saved.currentStep).toBe(2);
    expect(saved.trialPlanId).toBe("plan-trial");
    const reread = await store.getOnboardingState("onb-user-a");
    expect(reread?.currentStep).toBe(2);
    // A second login starts fresh: no shared step, no shared trial.
    expect(await store.getOnboardingState("onb-user-b")).toBeNull();
  });
});

// Routes --------------------------------------------------------------------

function makePorts(overrides: Partial<PlatformAccountPorts> = {}): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
    ...overrides,
  };
}

function makeCtx(
  ports: PlatformAccountPorts,
  env: Record<string, unknown> = {},
): PlatformAccountRouteContext & { audit: ReturnType<typeof vi.fn> } {
  return { env: env as never, audit: vi.fn(), ports } as PlatformAccountRouteContext & {
    audit: ReturnType<typeof vi.fn>;
  };
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

describe("onboarding state routes (#3256)", () => {
  it("GET returns null state for a user who never started, and POST then GET round-trips the step", async () => {
    const ctx = makeCtx(makePorts());
    const empty = await call(ctx, req("GET", "/platform/onboarding/state", "onb-route-a"));
    expect(empty?.status).toBe(200);
    expect(empty?.body.state).toBeNull();

    const saved = await call(
      ctx,
      req("POST", "/platform/onboarding/state", "onb-route-a", { currentStep: 3 }),
    );
    expect(saved?.status).toBe(200);
    const state = saved?.body.state as Record<string, unknown>;
    expect(state.userLogin).toBe("onb-route-a");
    expect(state.currentStep).toBe(3);
    expect(state.completedAtMs).toBeNull();

    const reread = await call(ctx, req("GET", "/platform/onboarding/state", "onb-route-a"));
    expect((reread?.body.state as Record<string, unknown>).currentStep).toBe(3);
  });

  it("POST ignores a client-supplied userLogin/tenantId and stamps the verified session instead", async () => {
    const ctx = makeCtx(makePorts());
    const saved = await call(
      ctx,
      req("POST", "/platform/onboarding/state", "onb-route-b", {
        userLogin: "mallory",
        tenantId: "evil-tenant",
        currentStep: 2,
      }),
    );
    expect(saved?.status).toBe(200);
    const state = saved?.body.state as Record<string, unknown>;
    expect(state.userLogin).toBe("onb-route-b");
    expect(state.tenantId).not.toBe("evil-tenant");
  });

  it("stamps tenantId from the resolved account once setup created one", async () => {
    const ctx = makeCtx(makePorts());
    const setup = await call(ctx, req("POST", "/platform/accounts/setup", "onb-route-c", {}));
    expect(setup?.status).toBe(200);
    const saved = await call(
      ctx,
      req("POST", "/platform/onboarding/state", "onb-route-c", { currentStep: 2 }),
    );
    const state = saved?.body.state as Record<string, unknown>;
    expect(state.tenantId).toBe("onb-route-c");
  });

  it("completion stamps completedAtMs server-side and audits once on the transition", async () => {
    const ctx = makeCtx(makePorts());
    const done = await call(
      ctx,
      req("POST", "/platform/onboarding/state", "onb-route-d", { currentStep: 5, completed: true }),
    );
    expect(done?.status).toBe(200);
    const state = done?.body.state as Record<string, unknown>;
    expect(typeof state.completedAtMs).toBe("number");
    expect((state.completedAtMs as number) > 0).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith(
      "platform.onboarding.completed",
      "payments",
      expect.objectContaining({ userLogin: "onb-route-d" }),
    );
    const auditCalls = ctx.audit.mock.calls.filter(
      (c) => (c as unknown[])[0] === "platform.onboarding.completed",
    );
    expect(auditCalls).toHaveLength(1);
  });

  it("keeps a second login's state separate from the first", async () => {
    const ctx = makeCtx(makePorts());
    await call(ctx, req("POST", "/platform/onboarding/state", "onb-user-1", { currentStep: 4 }));
    await call(ctx, req("POST", "/platform/onboarding/state", "onb-user-2", { currentStep: 2 }));
    const first = await call(ctx, req("GET", "/platform/onboarding/state", "onb-user-1"));
    const second = await call(ctx, req("GET", "/platform/onboarding/state", "onb-user-2"));
    expect((first?.body.state as Record<string, unknown>).currentStep).toBe(4);
    expect((second?.body.state as Record<string, unknown>).currentStep).toBe(2);
  });

  it("rejects a missing or out-of-range currentStep with 400", async () => {
    const ctx = makeCtx(makePorts());
    for (const body of [{}, { currentStep: 0 }, { currentStep: 6 }, { currentStep: "3" }]) {
      const res = await call(ctx, req("POST", "/platform/onboarding/state", "onb-route-e", body));
      expect(res?.status).toBe(400);
    }
  });

  it("fails closed: 401 with no verified login, 503 with the onboarding store unbound", async () => {
    const ctx = makeCtx(makePorts());
    const anon = await call(ctx, req("GET", "/platform/onboarding/state"));
    expect(anon?.status).toBe(401);
    const anonPost = await call(
      ctx,
      req("POST", "/platform/onboarding/state", undefined, { currentStep: 2 }),
    );
    expect(anonPost?.status).toBe(401);

    const unbound = makeCtx(makePorts({ onboarding: null }));
    const get503 = await call(unbound, req("GET", "/platform/onboarding/state", "onb-route-f"));
    expect(get503?.status).toBe(503);
    const post503 = await call(
      unbound,
      req("POST", "/platform/onboarding/state", "onb-route-f", { currentStep: 2 }),
    );
    expect(post503?.status).toBe(503);
  });

  it("records the started trial plan on the state row", async () => {
    const ctx = makeCtx(makePorts());
    const saved = await call(
      ctx,
      req("POST", "/platform/onboarding/state", "onb-route-g", {
        currentStep: 3,
        trialPlanId: "plan-starter",
      }),
    );
    const state = saved?.body.state as Record<string, unknown>;
    expect(state.trialPlanId).toBe("plan-starter");
    expect(typeof state.trialStartedAtMs).toBe("number");
  });
});

// Client API ----------------------------------------------------------------

describe("setupAccount (#3256)", () => {
  it("POSTs /api/platform/accounts/setup and returns created + identity, never sending an identity header", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenHeaders: Record<string, string> = {};
    stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "";
      seenHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit | undefined).entries(),
      );
      return Response.json({
        created: true,
        identity: {
          userLogin: "onb-api-user",
          tenantId: "onb-api-user",
          hasAccount: true,
          tier: "Free",
          creditsUSD: 0,
          includedRunsRemaining: 0,
        },
        subscriptions: [],
        catalogue: [],
        catalogueAvailable: true,
      });
    });
    const result = await setupAccount();
    expect(seenUrl).toBe("/api/platform/accounts/setup");
    expect(seenMethod).toBe("POST");
    expect(seenHeaders["x-user-login"]).toBeUndefined();
    expect(result.created).toBe(true);
    expect(result.identity.hasAccount).toBe(true);
    expect(result.identity.tenantId).toBe("onb-api-user");
  });

  it("surfaces HTTP failures as a typed error with the status", async () => {
    stubFetch(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
    const err = await setupAccount().catch((e) => e);
    expect(err).toBeInstanceOf(FirstRunApiError);
    expect((err as FirstRunApiError).status).toBe(401);
  });

  it("polls a 202 async-job receipt and returns created + identity once the job completes (#3309)", async () => {
    let calls = 0;
    stubFetch((url) => {
      calls += 1;
      if (calls === 1) {
        expect(url).toBe("/api/platform/accounts/setup");
        return Response.json(
          { jobId: "job-3309", status: "queued", statusUrl: "/api/jobs/job-3309" },
          { status: 202 },
        );
      }
      return Response.json({
        jobId: "job-3309",
        capability: "http.request",
        status: "completed",
        responseStatus: 200,
        result: {
          body: JSON.stringify({
            created: true,
            identity: {
              userLogin: "onb-api-user",
              tenantId: "onb-api-user",
              hasAccount: true,
              tier: "Free",
              creditsUSD: 0,
              includedRunsRemaining: 0,
            },
          }),
          headers: { "content-type": "application/json" },
        },
      });
    });
    const result = await setupAccount();
    expect(result.created).toBe(true);
    expect(result.identity.hasAccount).toBe(true);
    expect(result.identity.tenantId).toBe("onb-api-user");
    expect(calls).toBe(2);
  });

  it("a 202 whose job completes with created:false returns the existing account (#3309)", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { jobId: "job-3309", status: "queued", statusUrl: "/api/jobs/job-3309" },
          { status: 202 },
        );
      }
      return Response.json({
        jobId: "job-3309",
        capability: "http.request",
        status: "completed",
        responseStatus: 200,
        result: {
          body: JSON.stringify({
            created: false,
            identity: {
              userLogin: "onb-api-user",
              tenantId: "onb-api-user",
              hasAccount: true,
              tier: "Free",
              creditsUSD: 0,
              includedRunsRemaining: 0,
            },
          }),
          headers: { "content-type": "application/json" },
        },
      });
    });
    const result = await setupAccount();
    expect(result.created).toBe(false);
    expect(result.identity.hasAccount).toBe(true);
    expect(calls).toBe(2);
  });

  it("a failed async job surfaces a coded error, never the raw job error text (#3309)", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { jobId: "job-3309", status: "queued", statusUrl: "/api/jobs/job-3309" },
          { status: 202 },
        );
      }
      return Response.json({
        jobId: "job-3309",
        capability: "http.request",
        status: "failed",
        error: "D1 explode: raw store detail",
      });
    });
    const err = await setupAccount().catch((e) => e);
    expect(err).toBeInstanceOf(FirstRunApiError);
    expect((err as FirstRunApiError).status).toBe(500);
    expect((err as FirstRunApiError).code).toBe("FAILURE_ASYNC_JOB_FAILED");
    expect((err as Error).message).toBe(codedMessage("FAILURE_ASYNC_JOB_FAILED"));
    expect((err as Error).message).not.toContain("D1 explode");
  });

  it("a still-processing 408 surfaces the coded timeout message (#3309)", async () => {
    stubFetch(() =>
      Response.json(
        {
          error: "The request is still processing. The job will continue in the background.",
          jobId: "job-3309",
          statusUrl: "/api/jobs/job-3309",
        },
        { status: 408 },
      ),
    );
    const err = await setupAccount().catch((e) => e);
    expect(err).toBeInstanceOf(FirstRunApiError);
    expect((err as FirstRunApiError).status).toBe(408);
    expect((err as FirstRunApiError).code).toBe("FAILURE_ASYNC_JOB_STILL_PROCESSING");
    expect((err as Error).message).toBe(codedMessage("FAILURE_ASYNC_JOB_STILL_PROCESSING"));
  });
});

describe("onboarding state client API (#3256)", () => {
  const stateBody = {
    userLogin: "onb-api-user",
    tenantId: "onb-api-user",
    currentStep: 3,
    completedAtMs: null,
    trialPlanId: "plan-starter",
    trialStartedAtMs: 1700000000000,
    updatedAtMs: 1700000000000,
  };

  it("GETs the state and parses it; a null state stays null", async () => {
    stubFetch((url) => {
      expect(url).toBe("/api/platform/onboarding/state");
      return Response.json({ state: stateBody });
    });
    const state = await fetchOnboardingState();
    expect(state?.currentStep).toBe(3);
    expect(state?.trialPlanId).toBe("plan-starter");

    stubFetch(() => Response.json({ state: null }));
    expect(await fetchOnboardingState()).toBeNull();
  });

  it("POSTs only the caller-supplied fields — never userLogin or tenantId", async () => {
    let seenBody: Record<string, unknown> = {};
    let seenUrl = "";
    stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({ state: stateBody });
    });
    await saveOnboardingState({ currentStep: 5, completed: true });
    expect(seenUrl).toBe("/api/platform/onboarding/state");
    expect(Object.keys(seenBody).sort()).toEqual(["completed", "currentStep"].sort());
    expect(seenBody.userLogin).toBeUndefined();
    expect(seenBody.tenantId).toBeUndefined();
  });

  it("rejects a malformed state body instead of rendering garbage", async () => {
    stubFetch(() => Response.json({ state: { currentStep: 9 } }));
    await expect(fetchOnboardingState()).rejects.toBeInstanceOf(FirstRunApiError);
  });

  it("polls a 202 async-job receipt for the state save (#3309)", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { jobId: "job-3309", status: "queued", statusUrl: "/api/jobs/job-3309" },
          { status: 202 },
        );
      }
      return Response.json({
        jobId: "job-3309",
        capability: "http.request",
        status: "completed",
        responseStatus: 200,
        result: {
          // The server echoes the state it saved, not the fixture.
          body: JSON.stringify({ state: { ...stateBody, currentStep: 5, completed: true } }),
          headers: { "content-type": "application/json" },
        },
      });
    });
    const saved = await saveOnboardingState({ currentStep: 5, completed: true });
    expect(saved?.currentStep).toBe(5);
    expect(calls).toBe(2);
  });
});

describe("fetchETradeStatus (#3256)", () => {
  it("GETs the oauth status endpoint and parses authenticated + environment", async () => {
    let seenUrl = "";
    stubFetch((url) => {
      seenUrl = url;
      return Response.json({
        authenticated: true,
        userLogin: "onb-api-user",
        environment: "TEST",
        tokenScopes: {},
      });
    });
    const status = await fetchETradeStatus();
    expect(seenUrl).toBe("/api/etrade/oauth/status");
    expect(status.authenticated).toBe(true);
    expect(status.environment).toBe("TEST");
  });

  it("parses an unauthenticated status as not connected", async () => {
    stubFetch(() =>
      Response.json({ authenticated: false, userLogin: "onb-api-user", environment: "TEST", tokenScopes: {} }),
    );
    expect((await fetchETradeStatus()).authenticated).toBe(false);
  });

  it("startETradeOAuth navigates to the real OAuth start in redirect mode", () => {
    const assign = vi.fn();
    (globalThis as unknown as { location: unknown }).location = { assign };
    try {
      startETradeOAuth();
    } finally {
      delete (globalThis as unknown as { location?: unknown }).location;
    }
    expect(assign).toHaveBeenCalledWith("/api/etrade/oauth/start?mode=redirect");
  });
});

describe("fetchAccountSelf (#3256)", () => {
  it("GETs the self view and parses subscriptions including a trial provider row", async () => {
    stubFetch((url) => {
      expect(url).toBe("/api/platform/accounts/self");
      return Response.json({
        identity: {
          userLogin: "onb-api-user",
          tenantId: "onb-api-user",
          hasAccount: true,
          tier: "Subscribed",
          creditsUSD: 0,
          includedRunsRemaining: 5,
        },
        subscriptions: [
          {
            id: "sub-trial-1",
            planId: "plan-starter",
            provider: "trial",
            providerStatus: "trialing",
            status: "trialing",
            periodStartMs: 1700000000000,
            periodEndMs: 1700604800000,
            canceledAtMs: null,
          },
        ],
        catalogue: [],
        catalogueAvailable: true,
      });
    });
    const view = await fetchAccountSelf();
    expect(view.identity.includedRunsRemaining).toBe(5);
    expect(view.subscriptions).toHaveLength(1);
    expect(view.subscriptions[0].provider).toBe("trial");
    expect(view.subscriptions[0].periodEndMs).toBe(1700604800000);
  });
});
