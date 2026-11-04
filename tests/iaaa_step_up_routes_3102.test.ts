/**
 * Issue #3102 (#945 Q4) — step-up windows enforced at the route, not
 * just configured. TDD Red-first.
 *
 * Worker-fetch deny tests via the fake session store: a wired session
 * whose authentication is 60 minutes old (stale for every Q4 window)
 * must get 403 + the step-up message on each gated route, before any
 * grant/export/mint work happens. Allow boundaries are proven per
 * action in tests/iaaa_step_up_actions.test.ts; the grant positive
 * control below proves a fresh session passes the gate (it then
 * fails the PDP deny, a different message, because the caller holds
 * no role:assign — the gate is not what stopped it).
 *
 * Each case uses a distinct session id: the worker caches sessions
 * in-isolate, and a reused id would serve the first case's session
 * to later cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
import type { Env } from "../src/types";
import { sessionStore, wiredMembershipStore } from "../src/security/session";
import { createKvBootstrapProposalStore } from "../src/security/bootstrapProposals";
import { createBootstrapProposal } from "../src/security/bootstrapProposals";

const NOW = () => Date.now();
const HOUR = 60 * 60 * 1000;

function makeEnv() {
  const { namespace, seed } = makeFakeSessionStore();
  const env: any = {
    SESSION_STORE: namespace,
    IAAA_WIRING_ENABLED: "1",
  };
  return { env: env as Env, seed };
}

function seedWired(
  seed: ReturnType<typeof makeFakeSessionStore>["seed"],
  id: string,
  login: string,
  internalUserId: string,
  authAgeMs: number,
) {
  const now = NOW();
  seed("sessions", id, {
    githubLogin: login,
    githubAvatar: "",
    githubName: login,
    createdAt: now - HOUR,
    firstCreatedAt: now - HOUR,
    internalUserId,
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: now - authAgeMs,
    lastActivityMs: now - 60_000,
    sessionVersion: 1,
  });
}

const req = (
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.cookie ? { Cookie: `session_id=${opts.cookie}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

const STEP_UP = /Step-up authentication required/;

describe("step-up gates at routes (#3102, #945 Q4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/api-keys with 60-minute-old auth → 403 step-up, nothing minted", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3102-1c2b-4e3f-8a5b-310200000001", "octocat-mint", "user-mint", HOUR);
    const res = await worker.fetch(
      req("/api/api-keys", { method: "POST", cookie: "0d9a3102-1c2b-4e3f-8a5b-310200000001", body: { label: "x" } }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(STEP_UP);
  });

  it("POST /api/iaaa/role-grants/grant with 60-minute-old auth → 403 step-up, before obligations", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3102-1c2b-4e3f-8a5b-310200000002", "octocat-grant", "user-grant", HOUR);
    const res = await worker.fetch(
      req("/api/iaaa/role-grants/grant", {
        method: "POST",
        cookie: "0d9a3102-1c2b-4e3f-8a5b-310200000002",
        body: { internalUserId: "target-1", role: "platform-admin" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(STEP_UP);
  });

  it("POST /api/iaaa/membership/grant with 60-minute-old auth → 403 step-up, before obligations", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3102-1c2b-4e3f-8a5b-310200000003", "octocat-mem", "user-mem", HOUR);
    const res = await worker.fetch(
      req("/api/iaaa/membership/grant", {
        method: "POST",
        cookie: "0d9a3102-1c2b-4e3f-8a5b-310200000003",
        body: {
          internalUserId: "target-1",
          roleBindings: [{ role: "member", scope: "tenant" }],
        },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(STEP_UP);
  });

  it("GET /api/privacy/export with 60-minute-old auth → 403 step-up, no payload built", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3102-1c2b-4e3f-8a5b-310200000004", "octocat-export", "user-export", HOUR);
    const res = await worker.fetch(
      req("/api/privacy/export", { method: "GET", cookie: "0d9a3102-1c2b-4e3f-8a5b-310200000004" }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(STEP_UP);
  });

  it("POST /api/iaaa/bootstrap-proposals/approve with 60-minute-old auth → 403 step-up, approval not stored", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3102-1c2b-4e3f-8a5b-310200000005", "octocat-boot", "user-boot", HOUR);
    const now = NOW();
    await wiredMembershipStore(env).put({
      membershipId: "mem-boot-1",
      internalUserId: "user-boot",
      tenantId: "platform",
      roleBindings: [
        { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
      ],
      createdBy: "system:bootstrap-genesis",
      createdAtMs: now - HOUR,
    });
    const created = createBootstrapProposal({
      proposer: "proposer-1",
      action: "add",
      identifier: "platform:123e4567-e89b-12d3-a456-426614174001",
      reason: "Q4 route test proposal",
      nowMs: now,
    });
    if (!created.ok) throw new Error(`proposal setup failed: ${created.error}`);
    await createKvBootstrapProposalStore(sessionStore(env)).putProposal(created.proposal);
    const res = await worker.fetch(
      req("/api/iaaa/bootstrap-proposals/approve", {
        method: "POST",
        cookie: "0d9a3102-1c2b-4e3f-8a5b-310200000005",
        body: { proposalId: created.proposal.proposalId },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(STEP_UP);
  });

  it("positive control: fresh auth passes the gate on role-grants/grant (then fails the PDP deny, a different message)", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3102-1c2b-4e3f-8a5b-310200000006", "octocat-fresh", "user-fresh", 60_000);
    const res = await worker.fetch(
      req("/api/iaaa/role-grants/grant", {
        method: "POST",
        cookie: "0d9a3102-1c2b-4e3f-8a5b-310200000006",
        body: { internalUserId: "target-1", role: "platform-admin" },
      }),
      env,
    );
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).toMatch(/grant denied/);
    expect(text).not.toMatch(STEP_UP);
  });
});
