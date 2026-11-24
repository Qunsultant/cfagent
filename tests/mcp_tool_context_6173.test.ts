// @vitest-environment node
/**
 * Issue #6173 (slice 3 of the universal execution context) — the
 * MCP layer carries the one validated ExecutionContext.
 *
 * The resolution happens once per MCP exchange at the DO route
 * shell (src/agents/routes/mcpChatNlq.ts), is carried unchanged
 * through the tool call on the handler context, and is read by
 * the permission gate (role-derived scopes via the #5350 seam B
 * adapter + attributed denial observations) and the request
 * observability wrapper (surface label "mcp" on /mcp + /api/mcp
 * requests) — no MCP call is unattributed, no tool call
 * re-derives its own slice.
 *
 * TDD red-first: the entry module, the gate's context
 * threading, and the surface label do not exist yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import {
  establishMcpToolContext,
  type McpToolContextOutcome,
} from "../src/security/mcpToolContext";
import {
  authorizeMcpToolCall,
  createProductionMcpPermissionPort,
  MCP_PERMISSION_DENIED_CODE,
} from "../src/mcps/openaimp/mcpPermissionPorts";
import { withRequestObservability } from "../src/observability/aspects";
import { sessionRefFor } from "../src/observability/observabilityPorts";
import type { ExecutionContext } from "../src/security/executionContext";
import type { Membership, Role } from "../src/security/authorization";
import type { McpPrincipal } from "../src/mcps/openaimp/mcpPermissionPorts";
import type { Env } from "../src/types";

const SESSION_PRINCIPAL: McpPrincipal = { login: "venus", kind: "session" };
const API_KEY_PRINCIPAL: McpPrincipal = { login: "venus", kind: "api-key" };
const UNKNOWN_PRINCIPAL: McpPrincipal = { login: null, kind: "unknown" };

function fakeMcpContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: "tenant-mcp",
    principalId: "user-mcp",
    principalType: "user",
    initiatingPrincipalId: "user-mcp",
    taskId: "mcp:trace-1",
    serviceId: "mcp",
    environment: "sandbox",
    policyVersion: "iaaa-authorization-2",
    correlationId: "trace-1",
    sessionId: "session-1",
    traceId: "trace-1",
    dispatchMode: "manual",
    execMode: "sync",
    ...overrides,
  };
}

function fakeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    membershipId: "membership-1",
    internalUserId: "user-mcp",
    tenantId: "tenant-mcp",
    roleBindings: [{ role: "member", scope: "tenant" }],
    createdBy: "system:bootstrap",
    createdAtMs: 1000,
    ...overrides,
  };
}

describe("establishMcpToolContext (#6173)", () => {
  const env = {} as Env;
  let logDenied: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logDenied = vi.fn();
  });

  it("resolves a session principal's context once at the MCP entry", async () => {
    const seenInputs: unknown[] = [];
    const resolve = vi.fn(async (_sources: unknown, input: unknown) => {
      seenInputs.push(input);
      return { ok: true as const, context: fakeMcpContext() };
    });
    const { outcome, refusal, resolveRoles } = await establishMcpToolContext(
      { principal: SESSION_PRINCIPAL, sessionId: "session-1", traceId: "trace-1", nowMs: 5000 },
      env,
      {
        lookupUserId: async () => "user-mcp",
        resolve: resolve as never,
        buildSources: async () => ({ authority: {}, ports: {}, env }) as never,
        logDenied,
      },
    );
    expect(refusal).toBeNull();
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") throw new Error("expected resolved");
    expect(outcome.context.serviceId).toBe("mcp");
    expect(outcome.context.taskId).toBe("mcp:trace-1");
    expect(outcome.context.dispatchMode).toBe("manual");
    expect(outcome.context.execMode).toBe("sync");
    expect(outcome.context.sessionId).toBe("session-1");
    expect(resolve).toHaveBeenCalledTimes(1);
    const input = seenInputs[0] as Record<string, unknown>;
    expect(input.principalId).toBe("user-mcp");
    expect(input.sessionId).toBe("session-1");
    expect(input.serviceId).toBe("mcp");
    expect(input.permission).toBe("task:read");
    expect(input.environment).toBe("sandbox");
    expect(input.traceId).toBe("trace-1");
    expect(input.correlationId).toBe("trace-1");
    expect(typeof resolveRoles).toBe("function");
    expect(logDenied).not.toHaveBeenCalled();
  });

  it("resolves an api-key principal the same way (kind api-key)", async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, context: fakeMcpContext() }));
    const { outcome, refusal } = await establishMcpToolContext(
      { principal: API_KEY_PRINCIPAL, sessionId: "session-1", traceId: "trace-1", nowMs: 5000 },
      env,
      {
        lookupUserId: async () => "user-mcp",
        resolve: resolve as never,
        buildSources: async () => ({ authority: {}, ports: {}, env }) as never,
        logDenied,
      },
    );
    expect(refusal).toBeNull();
    expect(outcome.outcome).toBe("resolved");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("no login resolves to absent and never calls the resolver", async () => {
    const lookupUserId = vi.fn(async () => "user-mcp");
    const resolve = vi.fn(async () => ({ ok: true as const, context: fakeMcpContext() }));
    const { outcome, refusal, resolveRoles } = await establishMcpToolContext(
      { principal: UNKNOWN_PRINCIPAL, sessionId: "session-1", nowMs: 5000 },
      env,
      {
        lookupUserId,
        resolve: resolve as never,
        buildSources: async () => ({ authority: {}, ports: {}, env }) as never,
        logDenied,
      },
    );
    expect(outcome).toEqual({ outcome: "absent" });
    expect(refusal).toBeNull();
    expect(resolveRoles).toBeUndefined();
    expect(lookupUserId).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(logDenied).not.toHaveBeenCalled();
  });

  it("a login with no wired internal id is denied NO_PRINCIPAL, audited, and refused only in enforce mode", async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, context: fakeMcpContext() }));
    const base = {
      principal: SESSION_PRINCIPAL,
      sessionId: "session-1",
      traceId: "trace-1",
      nowMs: 5000,
    };
    const deps = {
      lookupUserId: async () => null,
      resolve: resolve as never,
      buildSources: async () => ({ authority: {}, ports: {}, env }) as never,
      logDenied,
    };
    const observed = await establishMcpToolContext(base, env, deps);
    expect(observed.outcome).toEqual({
      outcome: "denied",
      code: "NO_PRINCIPAL",
      error: expect.any(String),
    });
    expect(observed.refusal).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(logDenied).toHaveBeenCalledWith(
      expect.objectContaining({ code: "NO_PRINCIPAL", traceId: "trace-1" }),
    );

    const enforced = await establishMcpToolContext(
      base,
      { EXECUTION_CONTEXT_MODE: "enforce" } as Env,
      deps,
    );
    expect(enforced.refusal).not.toBeNull();
    expect(enforced.refusal!.status).toBe(403);
    const body = await enforced.refusal!.json();
    expect(body.code).toBe("NO_PRINCIPAL");
  });

  it("a resolver denial carries its code and is audited", async () => {
    const resolve = vi.fn(async () => ({
      ok: false as const,
      code: "NO_TENANT",
      error: "no tenant resolves for this principal in this session",
    }));
    const { outcome, refusal } = await establishMcpToolContext(
      { principal: SESSION_PRINCIPAL, sessionId: "session-1", traceId: "trace-1", nowMs: 5000 },
      env,
      {
        lookupUserId: async () => "user-mcp",
        resolve: resolve as never,
        buildSources: async () => ({ authority: {}, ports: {}, env }) as never,
        logDenied,
      },
    );
    expect(outcome).toEqual({
      outcome: "denied",
      code: "NO_TENANT",
      error: "no tenant resolves for this principal in this session",
    });
    expect(refusal).toBeNull();
    expect(logDenied).toHaveBeenCalledWith(
      expect.objectContaining({ code: "NO_TENANT" }),
    );
  });
});

describe("MCP role resolver (#6173 — seam B consumption)", () => {
  const env = {} as Env;

  async function establishedWithMemberships(memberships: Membership[]) {
    const membershipStore = {
      getMembershipsByUser: vi.fn(async (_userId: string) => memberships),
    };
    const { resolveRoles } = await establishMcpToolContext(
      { principal: SESSION_PRINCIPAL, sessionId: "session-1", traceId: "trace-1", nowMs: 5000 },
      env,
      {
        lookupUserId: async () => "user-mcp",
        resolve: (async () => ({ ok: true as const, context: fakeMcpContext() })) as never,
        buildSources: (async () => ({
          authority: { memberships: membershipStore },
          ports: {},
          env,
        })) as never,
        logDenied: () => undefined,
      },
    );
    if (!resolveRoles) throw new Error("expected a role resolver");
    return { resolveRoles, membershipStore };
  }

  it("reads the context tenant's live roles, fresh on every call", async () => {
    let memberships = [fakeMembership()];
    const membershipStore = {
      getMembershipsByUser: vi.fn(async (_userId: string) => memberships),
    };
    const { resolveRoles } = await establishMcpToolContext(
      { principal: SESSION_PRINCIPAL, sessionId: "session-1", traceId: "trace-1", nowMs: 5000 },
      env,
      {
        lookupUserId: async () => "user-mcp",
        resolve: (async () => ({ ok: true as const, context: fakeMcpContext() })) as never,
        buildSources: (async () => ({
          authority: { memberships: membershipStore },
          ports: {},
          env,
        })) as never,
        logDenied: () => undefined,
      },
    );
    if (!resolveRoles) throw new Error("expected a role resolver");
    expect(await resolveRoles(SESSION_PRINCIPAL)).toEqual(["member"]);
    expect(membershipStore.getMembershipsByUser).toHaveBeenCalledWith("user-mcp");
    // No caching: a role change reaches the next gate call on the SAME resolver.
    memberships = [
      fakeMembership({ roleBindings: [{ role: "tenant-admin", scope: "tenant" }] }),
    ];
    expect(await resolveRoles(SESSION_PRINCIPAL)).toEqual(["tenant-admin"]);
  });

  it("excludes other tenants, expired bindings, and revoked memberships", async () => {
    const { resolveRoles } = await establishedWithMemberships([
      fakeMembership({ membershipId: "other-tenant", tenantId: "tenant-other" }),
      fakeMembership({
        membershipId: "expired",
        roleBindings: [{ role: "tenant-admin", scope: "tenant", expiresAtMs: 4000 }],
      }),
      fakeMembership({ membershipId: "revoked", revokedAtMs: 1000 }),
    ]);
    // All three rows are inactive for tenant-mcp at nowMs 5000: no roles resolve.
    expect(await resolveRoles(SESSION_PRINCIPAL)).toEqual([]);
  });

  it("a store error is unresolvable (null — the adapter falls back to the recorded defaults)", async () => {
    const { resolveRoles } = await establishedWithMemberships([]);
    // Replace the store with a throwing one by re-establishing is overkill:
    // instead assert the contract on a resolver whose store throws.
    const throwing = {
      getMembershipsByUser: async () => {
        throw new Error("store down");
      },
    };
    const { resolveRoles: throwingResolver } = await establishMcpToolContext(
      { principal: SESSION_PRINCIPAL, sessionId: "session-1", traceId: "trace-1", nowMs: 5000 },
      env,
      {
        lookupUserId: async () => "user-mcp",
        resolve: (async () => ({ ok: true as const, context: fakeMcpContext() })) as never,
        buildSources: (async () => ({
          authority: { memberships: throwing },
          ports: {},
          env,
        })) as never,
        logDenied: () => undefined,
      },
    );
    expect(await throwingResolver!(SESSION_PRINCIPAL)).toBeNull();
    expect(resolveRoles).toBeDefined();
  });

  it("a login mismatch resolves to nothing (fail closed — never another identity's roles)", async () => {
    const { resolveRoles } = await establishedWithMemberships([fakeMembership()]);
    expect(await resolveRoles({ login: "someone-else", kind: "session" })).toEqual([]);
  });
});

describe("role-derived scopes at the MCP gate (#6173)", () => {
  it("a member's roles derive read+write only — trade is denied at the gate", async () => {
    const resolveRoles = async (principal: McpPrincipal): Promise<readonly Role[] | null> =>
      principal.login === "venus" ? (["member"] as const) : null;
    const port = createProductionMcpPermissionPort({ resolveRoles });
    expect(await port.scopesFor(SESSION_PRINCIPAL)).toEqual(["mcp:read", "mcp:write"]);
    const allowed = await port.authorize(SESSION_PRINCIPAL, "run_stock_screen");
    expect(allowed).toEqual({ allowed: true, scope: "mcp:write" });
    const denied = await port.authorize(SESSION_PRINCIPAL, "alpaca_place_order");
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe("mcp:trade");
  });

  it("a denied tool call is attributed: the denial event carries the context, the audit carries the tenant", async () => {
    const resolveRoles = async (): Promise<readonly Role[] | null> => ["member"];
    const port = createProductionMcpPermissionPort({ resolveRoles });
    const context = fakeMcpContext();
    const events: Record<string, unknown>[] = [];
    const sink = { write: async (event: Record<string, unknown>) => { events.push(event); } };
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await expect(
      authorizeMcpToolCall(port, SESSION_PRINCIPAL, "alpaca_place_order", {
        sessionId: "session-1",
        audit: (type, _agent, payload) => { audits.push({ type, payload }); },
        decisionSink: sink as never,
        executionContext: context,
      }),
    ).rejects.toMatchObject({ code: MCP_PERMISSION_DENIED_CODE });
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.tenantId).toBe("tenant-mcp");
    expect(event.runId).toBeNull();
    expect(event.sessionRef).toBe(sessionRefFor("session-1"));
    expect(event.traceId).toBe("trace-1");
    const fields = event.fields as Record<string, unknown>;
    expect(fields.surface).toBe("mcp");
    expect(fields.tool).toBe("alpaca_place_order");
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("mcp.permission_denied");
    expect(audits[0].payload.tenantId).toBe("tenant-mcp");
    expect(audits[0].payload.tool).toBe("alpaca_place_order");
  });
});

describe("MCP surface label on http.request (#6173)", () => {
  it("labels /mcp requests as surface mcp and leaves other requests unlabeled", async () => {
    const events: Record<string, unknown>[] = [];
    const sink = { write: async (event: Record<string, unknown>) => { events.push(event); } };
    const outcome: McpToolContextOutcome = { outcome: "resolved", context: fakeMcpContext({ serviceId: "api" }) };
    const wrapped = withRequestObservability(
      async () => new Response("ok"),
      {
        sinkFor: () => sink as never,
        nowMs: () => 1000,
        contextForRequest: () => outcome as never,
      },
    );
    await wrapped(new Request("https://agent.internal/mcp", { method: "POST" }), {});
    expect(events).toHaveLength(1);
    const fields = (events[0] as Record<string, unknown>).fields as Record<string, unknown>;
    expect(fields.surface).toBe("mcp");
    expect(fields.serviceId).toBe("api");

    events.length = 0;
    await wrapped(new Request("https://agent.internal/api/foo", { method: "GET" }), {});
    expect(events).toHaveLength(1);
    const apiFields = (events[0] as Record<string, unknown>).fields as Record<string, unknown>;
    expect(apiFields.surface).toBeUndefined();
  });
});
