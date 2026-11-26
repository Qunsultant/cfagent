/**
 * Issue #4653 — GET /api/security/pep: session-gated read of the PEP's
 * live state: the gated-route inventory (every evaluateRoutePep /
 * evaluateAgentSchedulePdp call site, route + permission + gateway),
 * the enforcement state for the caller's session (shouldEnforcePdp /
 * isLegacyPdpGraceExpired inputs), and the recent-decisions record
 * (none exists yet — the endpoint reports that honestly).
 *
 * Worker-fetch harness (same pattern as
 * tests/sechub_pdp_endpoint_4651.test.ts): real handleFetch against a
 * fake SessionStore, seeded memberships + sessions.
 * TDD Red first: the route does not exist yet — every test below
 * fails until the slice lands.
 */
import { describe, expect, it, vi } from "vitest";
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

const PLATFORM_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000e1";
const MEMBER_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000e2";
const LEGACY_SESSION = "0d9a3120-1c2b-4e3f-8a5b-3120000000e3";
const PLATFORM_ID = "v1:pepplatform000000000000000000000000000000000001";
const MEMBER_ID = "v1:pepmember000000000000000000000000000000000000001";

async function makeEnv(extra: Record<string, string> = {}) {
  const fake = makeFakeSessionStore();
  const { namespace, seed } = fake;
  const now = Date.now();
  const session = (login: string, internalUserId: string) => ({
    githubLogin: login,
    githubName: login,
    internalUserId,
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
    authTimeMs: now,
  });
  seed("sessions", PLATFORM_SESSION, session("platform-user", PLATFORM_ID));
  seed("sessions", MEMBER_SESSION, session("member-user", MEMBER_ID));
  // Legacy session: no internalUserId — the IAAA lifecycle block
  // refuses it before any handler runs (wired session required).
  seed("sessions", LEGACY_SESSION, {
    githubLogin: "legacy-user",
    githubName: "legacy-user",
    providerIssuer: "https://github.com",
    createdAt: now - 1000,
  });
  const env = {
    SESSION_STORE: namespace,
    ...extra,
  } as unknown as Env;
  const membershipStore = createKvMembershipStore(sessionStore(env));
  for (const [id, role, scope] of [
    [PLATFORM_ID, "platform-admin", "platform"],
    [MEMBER_ID, "member", "tenant"],
  ] as const) {
    const created = await createMembership(membershipStore, {
      internalUserId: id,
      tenantId: "primary",
      roleBindings: [{ role, scope, grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: now,
    });
    if (!created.ok) throw new Error(created.error);
  }
  return { env };
}

function req(method: string, path: string, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie
        ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" }
        : {}),
    },
  });
}

// The live gate inventory (#4653): every evaluateRoutePep /
// evaluateAgentSchedulePdp call site. Route + permission + gateway,
// in the order the gates are listed by the endpoint.
const EXPECTED_GATES = [
  { route: "/auth/etrade/start", method: "GET", permission: "integration:connect", gateway: "evaluateRoutePep" },
  { route: "/api/etrade/oauth/start", method: "GET", permission: "integration:connect", gateway: "evaluateRoutePep" },
  { route: "/api/etrade/oauth/verifier", method: "POST", permission: "integration:connect", gateway: "evaluateRoutePep" },
  { route: "/auth/public/start", method: "GET", permission: "integration:connect", gateway: "evaluateRoutePep" },
  { route: "/api/public/connect", method: "POST", permission: "integration:connect", gateway: "evaluateRoutePep" },
  { route: "/api/schedule/goals/approvals/:id/(approve|reject)", method: "POST", permission: "action:approve", gateway: "evaluateRoutePep" },
  { route: "/api/schedules/webhook/followup", method: "POST", permission: "task:create", gateway: "evaluateAgentSchedulePdp" },
  { route: "/api/schedules/approvals/:id/(approve|reject)", method: "POST", permission: "action:approve", gateway: "evaluateAgentSchedulePdp" },
  { route: "/api/admin/service-user/etrade/start", method: "POST", permission: "integration:connect", gateway: "evaluateRoutePep" },
  { route: "/api/admin/service-user/etrade/verifier", method: "POST", permission: "integration:connect", gateway: "evaluateRoutePep" },
];

describe("GET /api/security/pep (#4653)", () => {
  it("refuses unauthenticated callers with 401", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(req("GET", "/api/security/pep"), env, {} as any);
    expect(res.status).toBe(401);
  });

  it("refuses non-platform callers with 403", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pep", MEMBER_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("refuses legacy (unwired) sessions with 403 — policy state needs a wired session", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pep", LEGACY_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("returns the full gate inventory and enforcement-off state for a platform admin with the flag off", async () => {
    // Phase 3 (#6550): IAAA_PDP_ENABLED lives in
    // environment.config.json (ON in production), so a bare env no
    // longer means the PDP flag is off.
    const { env } = await makeEnv({ IAAA_PDP_ENABLED: "0" });
    const res = await worker.fetch(
      req("GET", "/api/security/pep", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.enforcement).toEqual({
      pdpEnabled: false,
      enforced: false,
      graceExpired: false,
      sessionKind: "wired",
      legacyGraceWindowSeconds: 604800,
    });
    expect(
      body.gates.map((g: any) => ({
        route: g.route,
        method: g.method,
        permission: g.permission,
        gateway: g.gateway,
      })),
    ).toEqual(EXPECTED_GATES);
    for (const gate of body.gates) {
      expect(typeof gate.source).toBe("string");
      expect(gate.source.length).toBeGreaterThan(0);
      expect(typeof gate.denied).toBe("string");
      expect(gate.denied.length).toBeGreaterThan(0);
    }
    // No queryable PEP decision record exists yet: the endpoint says
    // so instead of inventing rows.
    expect(body.decisionsAvailable).toBe(false);
    expect(body.decisions).toBeNull();
  });

  it("reports enforcement on for a wired platform admin when the flag is on", async () => {
    const { env } = await makeEnv({ IAAA_PDP_ENABLED: "1" });
    const res = await worker.fetch(
      req("GET", "/api/security/pep", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.enforcement.pdpEnabled).toBe(true);
    expect(body.enforcement.enforced).toBe(true);
    // Wired sessions are never grace-expired.
    expect(body.enforcement.graceExpired).toBe(false);
    expect(body.enforcement.sessionKind).toBe("wired");
  });

  it("refuses non-GET methods with 405", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/security/pep", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(405);
  });

  it("the inventory matches the live call sites — every listed route's gateway call exists in its cited source", async () => {
    // Anti-drift pin: the inventory is a cited list, not a second
    // copy — each entry's route string and gateway name must appear
    // in the file the entry cites, or the pin fails.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { env } = await makeEnv();
    const res = await worker.fetch(
      req("GET", "/api/security/pep", PLATFORM_SESSION),
      env,
      {} as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const gate of body.gates) {
      const src = readFileSync(join(process.cwd(), gate.source), "utf8");
      expect(src).toContain(gate.gateway);
      // The permission/action the gate checks is a literal at the
      // call site: evaluateRoutePep takes `permission`, while
      // evaluateAgentSchedulePdp takes `action` (task:create and
      // action:approve arrive as actions "create" / "approve").
      if (gate.gateway === "evaluateRoutePep") {
        expect(src).toContain(`permission: "${gate.permission}"`);
      } else {
        const action = gate.permission.split(":")[1];
        expect(src).toContain(`action: "${action}"`);
      }
      // Literal routes appear as path literals at the call site;
      // pattern routes (regex branches) are pinned by their
      // permission/action + gateway instead — the route pattern
      // itself is asserted verbatim in the inventory equality test
      // above.
      if (!gate.route.includes("(") && !gate.route.includes(":")) {
        // The DO matches the /schedules/* suffix (endsWith), so the
        // edge-facing /api prefix need not appear in its file.
        const stripped = gate.route.replace(/^\/api/, "");
        expect(
          src.includes(`"${gate.route}"`) || src.includes(`"${stripped}"`),
        ).toBe(true);
      }
    }
  });
});
