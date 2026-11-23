// @vitest-environment node
/**
 * Issue #6172 (slice 2 of the universal execution context) — the
 * API layer carries the one validated ExecutionContext.
 *
 * The resolution happens once per request at the fetch boundary
 * (src/security/apiRequestContext.ts), is carried unchanged through
 * the request on the request object, and is read by the
 * request-observability wrapper (http.request event scope + fields)
 * and the SLO recorder (dimensioned samples) — no null identity
 * fields on API observations, no handler re-derives its own slice.
 *
 * TDD red-first: the boundary module, the wrapper hook, the
 * recorder dimensions accessor, and the SLO handler's context
 * audit base do not exist yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

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

// The fetch-stack end-to-end cases run the REAL resolver against
// stub stores: the commercial stub carries an account (so the
// identity resolves a tenant), the subscription stub carries no
// rows (tier falls back to the account tier).
const commercialStub = vi.hoisted(() => ({
  getAccount: async (_userId: string) => ({
    userId: "user-e2e",
    tenantId: "tenant-e2e",
    tier: "Free",
    tierSource: "operator",
    creditsUSD: 0,
    includedRuns: 0,
  }),
  getTenantBrokerSelection: async (_tenantId: string) => null,
  getTenantDataProviderSelection: async (_tenantId: string) => null,
  getTenantSloUptimeTargetRatio: async (_tenantId: string) => null,
  getTenantSloP95LatencyMaxMs: async (_tenantId: string) => null,
}));
const subscriptionStub = vi.hoisted(() => ({
  listSubscriptions: async (_userId: string) => [],
}));
vi.mock("../src/data/createCommercialPorts", () => ({
  createCommercialAdapter: () => commercialStub,
  ensureCommercialSchema: async () => undefined,
}));
vi.mock("../src/data/createSubscriptionPorts", () => ({
  createSubscriptionAdapter: () => subscriptionStub,
  ensureSubscriptionSchema: async () => undefined,
}));

import {
  establishApiRequestContext,
  requestExecutionContext,
  setRequestExecutionContext,
  type ApiRequestContextOutcome,
} from "../src/security/apiRequestContext";
import {
  withRequestObservability,
  type ApiRequestObservation,
} from "../src/observability/aspects";
import { sessionRefFor } from "../src/observability/observabilityPorts";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import {
  createOtelMetricsRecorder,
  type OtelMetricsRecorder,
} from "../src/observability/otelMetricsRecorder";
import type { OtelMetricsSettings } from "../src/observability/otelMetrics";
import { serverOtelMetricsRecorder } from "../src/observability/serverMetrics";
import {
  handleSloRoutes,
  OTEL_SLO_ROUTE,
  type OtelSloRouteDeps,
} from "../src/server/routes/otelSlo";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { ExecutionContext } from "../src/security/executionContext";
import type { SessionData } from "../src/types";
import type { Env } from "../src/types";
import type { PlatformContextResult } from "../src/security/platformContext";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { sessionStore } from "../src/security/session";
import worker from "../src/server";
import { makeFakeSessionStore } from "./fake-session-store";

function fakeContext(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: "tenant-1",
    principalId: "user-1",
    principalType: "human",
    initiatingPrincipalId: "user-1",
    taskId: "http:trace-1",
    serviceId: "api",
    environment: "sandbox",
    policyVersion: "execution-context-1",
    correlationId: "trace-1",
    sessionId: "sess-1",
    traceId: "trace-1",
    dispatchMode: "manual",
    execMode: "sync",
    ...over,
  };
}

function fakeSession(over: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "octocat",
    githubAvatar: "",
    githubName: "octocat",
    createdAt: 1000,
    firstCreatedAt: 1000,
    internalUserId: "user-1",
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: 1000,
    lastActivityMs: 1000,
    sessionVersion: 1,
    ...over,
  } as SessionData;
}

function fakeResolvedResult(context: ExecutionContext): PlatformContextResult {
  return {
    ok: true,
    context,
    broker: "alpaca",
    screenProvider: "alpaca",
    tier: "Free",
    runBroker: {
      brokerId: "alpaca",
      mode: "sandbox",
      modeSource: "tenant-default",
      accountId: null,
      source: "tenant-default",
    },
    factsFromCache: false,
  } as unknown as PlatformContextResult;
}

function defaultSettings(
  overrides: Partial<OtelMetricsSettings> = {},
): OtelMetricsSettings {
  return {
    exportIntervalMs: 60000,
    freeTierDailyWriteLimit: 100000,
    freeTierDailyReadQueryLimit: 10000,
    healthPipelineMaxFailureRate: 0.05,
    sloResourceRowsReadMaxPct: 0.7,
    ...overrides,
  };
}

function liveRecorder(): { recorder: OtelMetricsRecorder } {
  const provider = new MeterProvider();
  const meter = provider.getMeter("cfagent-metrics-test-6172");
  const recorder = createOtelMetricsRecorder({
    meter,
    settings: defaultSettings(),
    isEnabled: () => true,
  });
  return { recorder };
}

describe("requestExecutionContext carrier", () => {
  it("round-trips the outcome for the same request object", () => {
    const req = new Request("https://agent.internal/api/x");
    const outcome: ApiRequestContextOutcome = {
      outcome: "resolved",
      context: fakeContext(),
    };
    setRequestExecutionContext(req, outcome);
    expect(requestExecutionContext(req)).toBe(outcome);
  });

  it("is isolated per request object", () => {
    const a = new Request("https://agent.internal/api/a");
    const b = new Request("https://agent.internal/api/b");
    setRequestExecutionContext(a, {
      outcome: "resolved",
      context: fakeContext(),
    });
    expect(requestExecutionContext(b)).toBeUndefined();
    expect(requestExecutionContext(a)?.outcome).toBe("resolved");
  });

  it("returns undefined when nothing was set", () => {
    expect(
      requestExecutionContext(new Request("https://agent.internal/api/x")),
    ).toBeUndefined();
  });
});

describe("establishApiRequestContext boundary", () => {
  const env = {} as Env;

  it("no session → absent, resolver never called, no refusal", async () => {
    const req = new Request("https://agent.internal/api/x");
    let resolveCalls = 0;
    const { outcome, refusal } = await establishApiRequestContext(req, env, {
      authenticate: async () => null,
      resolve: async () => {
        resolveCalls += 1;
        return fakeResolvedResult(fakeContext());
      },
    });
    expect(outcome).toEqual({ outcome: "absent" });
    expect(resolveCalls).toBe(0);
    expect(refusal).toBeNull();
    expect(requestExecutionContext(req)).toEqual({ outcome: "absent" });
  });

  it("wired session → resolved with the boundary's fixed inputs, carried identically", async () => {
    const req = new Request("https://agent.internal/api/x", {
      headers: {
        traceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    const context = fakeContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      correlationId: "4bf92f3577b34da6a3ce929d0e0e4736",
      taskId: "http:4bf92f3577b34da6a3ce929d0e0e4736",
    });
    let captured: unknown = null;
    const { outcome, refusal } = await establishApiRequestContext(req, env, {
      authenticate: async () => ({
        session: fakeSession(),
        sessionId: "sess-1",
      }),
      resolve: async (_sources, input) => {
        captured = input;
        return fakeResolvedResult(context);
      },
    });
    expect(outcome).toEqual({ outcome: "resolved", context });
    expect(refusal).toBeNull();
    // The carrier holds the IDENTICAL context object the resolver
    // returned — not a copy, not a re-derived slice.
    expect(requestExecutionContext(req)).toEqual({
      outcome: "resolved",
      context,
    });
    const input = captured as Record<string, unknown>;
    expect(input.principalId).toBe("user-1");
    expect(input.sessionId).toBe("sess-1");
    expect(input.taskId).toBe("http:4bf92f3577b34da6a3ce929d0e0e4736");
    expect(input.serviceId).toBe("api");
    expect(input.permission).toBe("task:read");
    expect(input.environment).toBe("sandbox");
    expect(input.dispatchMode).toBe("manual");
    expect(input.execMode).toBe("sync");
    expect(input.correlationId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(input.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("legacy session (no internalUserId) → denied NO_PRINCIPAL, observe proceeds, enforce refuses 403", async () => {
    const deniedLogs: Array<Record<string, unknown>> = [];
    const legacy = fakeSession({ internalUserId: undefined });
    delete (legacy as Record<string, unknown>).internalUserId;

    const observe = await establishApiRequestContext(
      new Request("https://agent.internal/api/x"),
      env,
      {
        authenticate: async () => ({ session: legacy, sessionId: "sess-old" }),
        resolve: async () => fakeResolvedResult(fakeContext()),
        logDenied: (fields) => {
          deniedLogs.push(fields);
        },
      },
    );
    expect(observe.outcome).toEqual({
      outcome: "denied",
      code: "NO_PRINCIPAL",
      error: expect.any(String),
    });
    expect(observe.refusal).toBeNull();
    expect(deniedLogs).toHaveLength(1);
    expect(deniedLogs[0].code).toBe("NO_PRINCIPAL");

    const enforce = await establishApiRequestContext(
      new Request("https://agent.internal/api/x"),
      { EXECUTION_CONTEXT_MODE: "enforce" } as unknown as Env,
      {
        authenticate: async () => ({ session: legacy, sessionId: "sess-old" }),
        resolve: async () => fakeResolvedResult(fakeContext()),
        logDenied: () => {},
      },
    );
    expect(enforce.outcome.outcome).toBe("denied");
    expect(enforce.refusal).not.toBeNull();
    expect(enforce.refusal!.status).toBe(403);
    const body = (await enforce.refusal!.json()) as Record<string, unknown>;
    expect(body.code).toBe("NO_PRINCIPAL");
    expect(typeof body.error).toBe("string");
  });

  it("resolver denial → denied with the resolver's code, observe proceeds, enforce refuses", async () => {
    const deniedLogs: Array<Record<string, unknown>> = [];
    const denial: PlatformContextResult = {
      ok: false,
      code: "PDP_DENIED",
      error: "the PDP refused the boundary permission",
    };
    const observe = await establishApiRequestContext(
      new Request("https://agent.internal/api/x"),
      env,
      {
        authenticate: async () => ({
          session: fakeSession(),
          sessionId: "sess-1",
        }),
        resolve: async () => denial,
        logDenied: (fields) => {
          deniedLogs.push(fields);
        },
      },
    );
    expect(observe.outcome).toEqual({
      outcome: "denied",
      code: "PDP_DENIED",
      error: "the PDP refused the boundary permission",
    });
    expect(observe.refusal).toBeNull();
    expect(deniedLogs).toHaveLength(1);
    expect(deniedLogs[0].code).toBe("PDP_DENIED");

    const enforce = await establishApiRequestContext(
      new Request("https://agent.internal/api/x"),
      { EXECUTION_CONTEXT_MODE: "enforce" } as unknown as Env,
      {
        authenticate: async () => ({
          session: fakeSession(),
          sessionId: "sess-1",
        }),
        resolve: async () => denial,
        logDenied: () => {},
      },
    );
    expect(enforce.refusal).not.toBeNull();
    expect(enforce.refusal!.status).toBe(403);
    const body = (await enforce.refusal!.json()) as Record<string, unknown>;
    expect(body.code).toBe("PDP_DENIED");
  });

  it("a denial never reaches the resolver's principal from a login: no session id is a principal", async () => {
    // A session whose ONLY identifier is the GitHub login (no
    // internalUserId) must not resolve with the login as the
    // principal — the contract forbids a login as a principal id.
    let resolveCalls = 0;
    const { outcome } = await establishApiRequestContext(
      new Request("https://agent.internal/api/x"),
      env,
      {
        authenticate: async () => ({
          session: fakeSession({ internalUserId: undefined }),
          sessionId: "sess-login-only",
        }),
        resolve: async () => {
          resolveCalls += 1;
          return fakeResolvedResult(fakeContext());
        },
      },
    );
    expect(outcome.outcome).toBe("denied");
    expect(resolveCalls).toBe(0);
  });
});

describe("withRequestObservability reads the carried context", () => {
  it("a resolved context fills the http.request scope + fields and the observation dimensions", async () => {
    const sink = new InMemoryObservabilityAdapter();
    let observed: ApiRequestObservation | undefined;
    const context = fakeContext();
    const wrapped = withRequestObservability(
      async () => new Response("ok", { status: 200 }),
      {
        sinkFor: () => sink,
        nowMs: () => 5000,
        contextForRequest: () => ({ outcome: "resolved", context }),
        onRequestObserved: (obs) => {
          observed = obs;
        },
      },
    );
    const res = await wrapped(
      new Request("https://agent.internal/api/x"),
      {},
    );
    expect(res.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    const [e] = sink.events;
    expect(e.type).toBe("http.request");
    expect(e.tenantId).toBe("tenant-1");
    expect(e.actorId).toBe("user-1");
    expect(e.agentId).toBeNull();
    expect(e.runId).toBeNull();
    expect(e.sessionRef).toBe(sessionRefFor("sess-1"));
    expect(e.traceId).toBe("trace-1");
    expect(e.fields.dispatchMode).toBe("manual");
    expect(e.fields.execMode).toBe("sync");
    expect(e.fields.environment).toBe("sandbox");
    expect(e.fields.contextStatus).toBe("resolved");
    expect(observed).toBeDefined();
    expect(observed!.dimensions).toEqual({
      tenantId: "tenant-1",
      dispatchMode: "manual",
      execMode: "sync",
      environment: "sandbox",
    });
  });

  it("a denied context is named on the event (contextStatus) with null identity fields", async () => {
    const sink = new InMemoryObservabilityAdapter();
    let observed: ApiRequestObservation | undefined;
    const wrapped = withRequestObservability(
      async () => new Response("ok", { status: 200 }),
      {
        sinkFor: () => sink,
        nowMs: () => 5000,
        contextForRequest: () => ({
          outcome: "denied",
          code: "NO_PRINCIPAL",
          error: "no principal",
        }),
        onRequestObserved: (obs) => {
          observed = obs;
        },
      },
    );
    await wrapped(new Request("https://agent.internal/api/x"), {});
    const [e] = sink.events;
    expect(e.tenantId).toBeNull();
    expect(e.actorId).toBeNull();
    expect(e.fields.contextStatus).toBe("denied");
    expect(observed!.dimensions).toBeUndefined();
  });

  it("no context hook → today's nulls, unchanged", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const wrapped = withRequestObservability(
      async () => new Response("ok", { status: 200 }),
      { sinkFor: () => sink, nowMs: () => 5000 },
    );
    await wrapped(new Request("https://agent.internal/api/x"), {});
    const [e] = sink.events;
    expect(e.tenantId).toBeNull();
    expect(e.actorId).toBeNull();
    expect(e.fields.contextStatus).toBe("absent");
  });
});

describe("otelMetricsRecorder dimensioned samples", () => {
  it("stores dimensioned samples and exposes them for the per-dimension evaluation", () => {
    const { recorder } = liveRecorder();
    recorder.recordApiRequest({
      status: 200,
      durationMs: 120,
      dimensions: {
        tenantId: "tenant-1",
        dispatchMode: "manual",
        execMode: "sync",
        environment: "sandbox",
      },
    });
    recorder.recordApiRequest({ status: 200, durationMs: 80 });
    const samples = recorder.apiRequestSamples();
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({
      durationMs: 120,
      tenantId: "tenant-1",
      dispatchMode: "manual",
      execMode: "sync",
      environment: "sandbox",
    });
    expect(samples[1]).toEqual({ durationMs: 80 });
  });

  it("aggregate counts and p95 are unchanged by dimensions", () => {
    const { recorder } = liveRecorder();
    recorder.recordApiRequest({
      status: 200,
      durationMs: 10,
      dimensions: { tenantId: "t1", dispatchMode: "manual", execMode: "sync", environment: "sandbox" },
    });
    recorder.recordApiRequest({
      status: 200,
      durationMs: 20,
      dimensions: { tenantId: "t1", dispatchMode: "manual", execMode: "sync", environment: "sandbox" },
    });
    recorder.recordApiRequest({
      status: 500,
      durationMs: 100,
      dimensions: { tenantId: "t2", dispatchMode: "scheduled", execMode: "async", environment: "live" },
    });
    const counts = recorder.apiRequestCounts();
    expect(counts.total).toBe(3);
    expect(counts.failed).toBe(1);
    expect(counts.latencySamples).toBe(3);
    const evaluation = recorder.evaluateAndRecordSlo({
      uptimeTargetRatio: 0.99,
      p95LatencyMaxMs: 500,
    });
    expect(evaluation.totalRequests).toBe(3);
    expect(evaluation.latencySamples).toBe(3);
    expect(evaluation.p95Latency.valueMs).toBe(100);
  });
});

describe("handleSloRoutes reads the carried context for its audit base", () => {
  function sloDeps(
    auditEvents: Array<Record<string, unknown>>,
  ): OtelSloRouteDeps {
    return {
      requireSession: async () => fakeSession(),
      isPlatformAdmin: async () => true,
      audit: async (_env, input) => {
        auditEvents.push(input as unknown as Record<string, unknown>);
        return true;
      },
      commercial: () =>
        commercialStub as unknown as CommercialStore,
      recorder: () => liveRecorder().recorder,
    };
  }

  it("with a carried context the audit names the context's tenant, principal, and correlation", async () => {
    const auditEvents: Array<Record<string, unknown>> = [];
    const req = new Request(`https://agent.internal${OTEL_SLO_ROUTE}`);
    setRequestExecutionContext(req, {
      outcome: "resolved",
      context: fakeContext({
        tenantId: "tenant-ctx",
        principalId: "user-ctx",
        initiatingPrincipalId: "user-ctx",
        correlationId: "corr-ctx",
      }),
    });
    const res = await handleSloRoutes(
      req,
      {} as Env,
      new URL(req.url),
      OTEL_SLO_ROUTE,
      sloDeps(auditEvents),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].actorPrincipalId).toBe("user-ctx");
    expect(auditEvents[0].initiatingPrincipalId).toBe("user-ctx");
    expect(auditEvents[0].tenantId).toBe("tenant-ctx");
    expect(auditEvents[0].correlationId).toBe("corr-ctx");
  });

  it("without a carried context the audit base falls back to the session + env values", async () => {
    const auditEvents: Array<Record<string, unknown>> = [];
    const req = new Request(`https://agent.internal${OTEL_SLO_ROUTE}`);
    const res = await handleSloRoutes(
      req,
      {} as Env,
      new URL(req.url),
      OTEL_SLO_ROUTE,
      sloDeps(auditEvents),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].actorPrincipalId).toBe("user-1");
    expect(typeof auditEvents[0].correlationId).toBe("string");
    expect(auditEvents[0].correlationId).not.toBe("corr-ctx");
  });
});

describe("fetch-stack end to end: boundary → handler → observation", () => {
  const HOUR = 60 * 60 * 1000;

  function makeEnv(mode?: string) {
    const { namespace, seed } = makeFakeSessionStore();
    const env: Record<string, unknown> = {
      SESSION_STORE: namespace,
      IAAA_WIRING_ENABLED: "1",
      TENANT_BROKER_ID: "alpaca",
    };
    if (mode !== undefined) env.EXECUTION_CONTEXT_MODE = mode;
    return { env: env as unknown as Env, seed };
  }

  function seedWired(
    seed: ReturnType<typeof makeFakeSessionStore>["seed"],
    id: string,
    login: string,
    internalUserId: string,
  ) {
    const now = Date.now();
    seed("sessions", id, {
      githubLogin: login,
      githubAvatar: "",
      githubName: login,
      createdAt: now - HOUR,
      firstCreatedAt: now - HOUR,
      internalUserId,
      providerIssuer: "https://github.com",
      providerSubject: "42",
      authTimeMs: now - 60_000,
      lastActivityMs: now - 60_000,
      sessionVersion: 1,
    });
  }

  function seedLegacy(
    seed: ReturnType<typeof makeFakeSessionStore>["seed"],
    id: string,
    login: string,
  ) {
    const now = Date.now();
    seed("sessions", id, {
      githubLogin: login,
      githubAvatar: "",
      githubName: login,
      createdAt: now - HOUR,
      firstCreatedAt: now - HOUR,
      providerIssuer: "https://github.com",
      providerSubject: "42",
      authTimeMs: now - 60_000,
      lastActivityMs: now - 60_000,
      sessionVersion: 1,
    });
  }

  const getMe = (sessionId: string) =>
    new Request("https://agent.test/api/me", {
      headers: { Cookie: `session_id=${sessionId}` },
    });

  it("a wired session resolves at the boundary and the SLO sample carries the context dimensions", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a6172-1c2b-4e3f-8a5b-617200000001", "octocat-e2e", "user-e2e");
    // The boundary permission is "task:read" (member-held), so
    // the e2e user needs a tenant member binding — otherwise the
    // PDP denies and the request proceeds unattributed.
    const memberships = createKvMembershipStore(sessionStore(env));
    await memberships.put({
      membershipId: "memb-e2e-1",
      internalUserId: "user-e2e",
      tenantId: "tenant-e2e",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test" }],
      createdBy: "test",
      createdAtMs: Date.now(),
    });
    const before = serverOtelMetricsRecorder(env).apiRequestSamples().length;
    const res = await worker.fetch(getMe("0d9a6172-1c2b-4e3f-8a5b-617200000001"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    const samples = serverOtelMetricsRecorder(env).apiRequestSamples();
    expect(samples.length).toBe(before + 1);
    const sample = samples[samples.length - 1];
    expect(sample.tenantId).toBe("tenant-e2e");
    expect(sample.dispatchMode).toBe("manual");
    expect(sample.execMode).toBe("sync");
    expect(sample.environment).toBe("sandbox");
  });

  it("enforce mode + legacy session → 403 NO_PRINCIPAL before any route runs", async () => {
    const { env, seed } = makeEnv("enforce");
    seedLegacy(seed, "0d9a6172-1c2b-4e3f-8a5b-617200000002", "octocat-legacy");
    const res = await worker.fetch(getMe("0d9a6172-1c2b-4e3f-8a5b-617200000002"), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("NO_PRINCIPAL");
    expect(typeof body.error).toBe("string");
  });

  it("observe mode (the default) + legacy session → the request proceeds unattributed", async () => {
    const { env, seed } = makeEnv();
    seedLegacy(seed, "0d9a6172-1c2b-4e3f-8a5b-617200000003", "octocat-legacy-2");
    const res = await worker.fetch(getMe("0d9a6172-1c2b-4e3f-8a5b-617200000003"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
  });
});
