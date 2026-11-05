/**
 * Route inventory pin for Qunsultant/cfagent#2902 (server.ts refactor by domain).
 *
 * Contract: docs/architecture/server-refactor-contract.md section 5.
 * This pin asserts, in dispatch order, every path branch of the Worker entry
 * (src/server.ts handleFetch + src/server/routes/*.ts handlers), reconstructed
 * by walking handleFetch and expanding each delegation call in place into its
 * module's branch conditions. A route added, removed, reordered, re-authed
 * (method guard changed), or silently moved without updating this pin fails.
 *
 * Baseline: 148 descriptors, scanned from origin/main 5627c72b (2026-11-05),
 * src/server.ts 7,431 lines / 360,983 bytes, before Slice 2. The list is the
 * contract section 3 inventory re-baselined: it adds the routes the contract
 * table missed (the /auth/login/<id> + /auth/callback/<id> provider family,
 * /api/user/email-destination, the WebSocket upgrade dispatch paths, the
 * /api/schedules forward alongside /api/schedule/*, the full IAAA lifecycle
 * block) and records the method guards the table only implied (POST|GET
 * trading-options, GET|POST market quotes source, OPTIONS premium preflight).
 * Moves only: this list must not change across Slices 2-9 except by a route
 * change approved in its own issue (recorded here with that issue number).
 *
 * Slice 2 decisions recorded here (see also the Slice 2 progress comment on
 * #2902):
 * - A2A / .well-known / /api/features are Core (contract section 3 wins over
 *   the #2902 body, which listed them under Platform; file order supports it).
 * - /api/etrade/* OAuth routes are Auth (Slice 3), not Trading.
 * - Browser-snapshot placement (contract open question Q2) is Platform
 *   (Slice 7), moved as a whole, never split across slices.
 * - The <800-line server.ts pin (contract section 2) is a proposal only: it
 *   is NOT set here, because Slice 2 cannot meet it while all domain code
 *   still lives in server.ts. Slice 9 sets the pin the slice actually
 *   achieves; a pin is never loosened to fit.
 * - Wrangler entrypoint exports (contract open question Q3): the code
 *   comments in server.ts state wrangler requires every bound DO class to be
 *   exported from the entrypoint; Slice 9 re-checks and keeps any required
 *   re-export with per-class justification.
 *
 * Slice 3 decisions recorded here:
 * - Auth & IAAA live in src/server/routes/auth.ts as three handlers in
 *   dispatch order: handleAuthLoginRoutes (/login, /auth/login/<id>,
 *   /auth/callback/<id>, /auth/logout, E*TRADE + public OAuth families),
 *   handleAuthMeRoutes (/api/me, /api/user/email-destination,
 *   /api/iaaa/overview, /api/governance/seed-halt), handleAuthIaaaRoutes
 *   (access-request + full IAAA lifecycle + /api/api-keys). The delegation
 *   -order assertion below grows by slice; the 148-descriptor EXPECTED list
 *   is unchanged (verified identical by the scanner before and after).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

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

// --- Static inventory reconstruction (mirrors scripts logic, in-test) ---

function regexLiterals(cond: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < cond.length; i++) {
    if (cond[i] !== "/") continue;
    const prev = cond.slice(0, i).trimEnd().slice(-1);
    if (prev && !"( |,=!:&?".includes(prev)) continue;
    let j = i + 1;
    let inClass = false;
    let ok = false;
    while (j < cond.length) {
      const ch = cond[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        ok = true;
        break;
      }
      j++;
    }
    if (!ok) continue;
    let k = j + 1;
    while (k < cond.length && /[a-z]/.test(cond[k])) k++;
    const lit = cond.slice(i, j + 1) + cond.slice(j + 1, k);
    const rest = cond.slice(k);
    if (rest.startsWith(".test(path)") || rest.startsWith(".test (path)") || cond.includes("path.match(")) {
      out.push(lit);
    }
    i = j;
  }
  return out;
}

function conditionTokens(cond: string): string[] {
  const methods = [...new Set([...cond.matchAll(/request\.method === "([A-Z]+)"/g)].map((m) => m[1]))];
  const method = methods.length ? methods.join("|") : "ANY";
  const toks: { index: number; text: string }[] = [];
  for (const m of cond.matchAll(/path === "([^"]+)"/g)) {
    toks.push({ index: m.index ?? 0, text: `${method} ${m[1]}` });
  }
  for (const m of cond.matchAll(/path\.startsWith\("([^"]+)"\)/g)) {
    toks.push({ index: m.index ?? 0, text: `${method} PREFIX ${m[1]}` });
  }
  for (const lit of regexLiterals(cond)) {
    toks.push({ index: cond.indexOf(lit), text: `${method} REGEX ${lit}` });
  }
  toks.sort((a, b) => a.index - b.index);
  return toks.map((t) => t.text);
}

function scanFunction(lines: string[], indent: number): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(pad + "return ") && line.includes("fetchStaticAsset")) {
      out.push("FALLBACK static");
      continue;
    }
    if (line.startsWith(pad + "const ") && line.includes("path.match(")) {
      for (const lit of regexLiterals(line)) out.push(`ANY REGEX ${lit}`);
      continue;
    }
    if (!line.startsWith(pad + "if (")) continue;
    let cond = line.slice(line.indexOf("if (") + 4);
    let depth = 1;
    let j = i;
    let done = false;
    while (j < lines.length && !done) {
      const l = j === i ? cond : lines[j];
      for (const ch of l) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            done = true;
            break;
          }
        }
      }
      if (!done) {
        cond += "\n" + lines[j + 1];
        j++;
      }
    }
    if (cond.includes("path")) out.push(...conditionTokens(cond));
    i = j;
  }
  return out;
}

function handlerBody(src: string, funcName: string): string[] {
  const lines = src.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(`function ${funcName}(`));
  if (startIdx < 0) throw new Error(`handler ${funcName} not found`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("export async function ") || lines[i].startsWith("export function ")) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx);
}

function reconstruct(): string[] {
  const serverSrc = readFileSync("src/server.ts", "utf8");
  const serverLines = serverSrc.split("\n");
  const start = serverLines.findIndex((l) => l.includes("async function handleFetch("));
  let end = serverLines.findIndex((l) => l.startsWith("export const PREMIUM_GATEWAY_INSTANCE"));
  if (end < 0) end = serverLines.length;
  const regionLines = serverLines.slice(start, end);
  const modules: Record<string, string> = {};
  const routesDir = "src/server/routes";
  if (existsSync(routesDir)) {
    for (const f of readdirSync(routesDir).filter((x) => x.endsWith(".ts"))) {
      modules[f.replace(/\.ts$/, "")] = readFileSync(`${routesDir}/${f}`, "utf8");
    }
  }
  const delegationRe = /(?:await )?(handle\w+Routes)\(request, env, url, path(?:, [^)]*)?\)/;
  const result: string[] = [];
  let preludeApiSeen = false;
  for (let i = 0; i < regionLines.length; i++) {
    const line = regionLines[i];
    const del = line.match(delegationRe);
    if (del) {
      const func = del[1];
      let found = false;
      for (const src of Object.values(modules)) {
        if (src.includes(`function ${func}(`)) {
          result.push(...scanFunction(handlerBody(src, func), 4));
          found = true;
          break;
        }
      }
      if (!found) result.push(`DELEGATION-UNRESOLVED ${func}`);
      continue;
    }
    if (line.startsWith("    const ") && line.includes("path.match(")) {
      for (const lit of regexLiterals(line)) result.push(`ANY REGEX ${lit}`);
      continue;
    }
    if (line.startsWith("    return ") && line.includes("fetchStaticAsset")) {
      result.push("FALLBACK static");
      continue;
    }
    if (line.startsWith("    if (")) {
      let cond = line.slice(line.indexOf("if (") + 4);
      let depth = 1;
      let j = i;
      let done = false;
      while (j < regionLines.length && !done) {
        const l = j === i ? cond : regionLines[j];
        for (const ch of l) {
          if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              done = true;
              break;
            }
          }
        }
        if (!done) {
          cond += "\n" + regionLines[j + 1];
          j++;
        }
      }
      if (cond.includes("path")) {
        for (const tok of conditionTokens(cond)) {
          if (tok === "ANY PREFIX /api/" && !preludeApiSeen) {
            result.push("PRELUDE-PREFIX /api/");
            preludeApiSeen = true;
          } else {
            result.push(tok);
          }
        }
      }
      i = j;
      continue;
    }
  }
  return result;
}

const EXPECTED_ROUTES: string[] = [
  "PRELUDE-PREFIX /api/",
  "ANY /.well-known/oauth-client-id-metadata-document",
  "ANY PREFIX /a2a/",
  "ANY PREFIX /.well-known/",
  "GET /api/features",
  "ANY /api/privacy/status",
  "ANY /api/privacy/preferences",
  "ANY /api/privacy/export",
  "ANY /api/privacy/erasure",
  "ANY /api/saga/journey-gates",
  "ANY /api/saga/journey-decision",
  "ANY /api/saga/start",
  "ANY REGEX /^\\/api\\/saga\\/[^/]+\\/status$/",
  "POST /nlq/webhook",
  "POST /api/trading/nlq/webhook",
  "POST /api/nlq/webhook",
  "GET /login",
  "ANY REGEX /^\\/auth\\/login\\/([^/]+)$/",
  "ANY REGEX /^\\/auth\\/callback\\/([^/]+)$/",
  "ANY /auth/logout",
  "ANY /auth/etrade/start",
  "ANY /api/etrade/oauth/start",
  "ANY /auth/etrade/callback",
  "ANY /api/etrade/oauth/status",
  "ANY /api/etrade/diagnostics",
  "POST /api/etrade/oauth/verifier",
  "POST /api/etrade/oauth/renew",
  "POST /api/etrade/oauth/revoke",
  "ANY /auth/public/start",
  "ANY /auth/public/callback",
  "ANY /api/public/status",
  "POST /api/public/connect",
  "POST /api/public/disconnect",
  "ANY /health",
  "ANY /api/health",
  "POST /api/qa/investigate",
  "POST /api/memory/search",
  "ANY PREFIX /api/schedule/",
  "ANY /api/social/brief",
  "ANY /api/social/approval",
  "ANY /api/social/approvals",
  "ANY /api/social/posts",
  "ANY /api/social/token-health",
  "ANY /api/me",
  "ANY /api/user/email-destination",
  "ANY /api/iaaa/overview",
  "ANY /api/governance/seed-halt",
  "ANY /api/chains/status",
  "ANY /api/chains/reconcile",
  "ANY /api/jobs/history",
  "ANY /api/traces",
  "ANY /api/agents/registry",
  "ANY /api/products/catalog",
  "ANY /api/jobs/reconcile",
  "ANY /api/retention/purge",
  "ANY /api/telemetry/summary",
  "ANY /api/telemetry/decisions",
  "ANY /api/telemetry/reconcile",
  "ANY REGEX /^\\/api\\/telemetry\\/decisions\\/[^/]+\\/(decide|apply|supersede|expire)$/",
  "ANY /api/audit/history",
  "ANY /api/reports/list",
  "ANY /api/reports/seed-canonical",
  "ANY /api/retrieval/populate-market-graph",
  "ANY /api/iaaa/access-request",
  "ANY /api/iaaa/access-requests",
  "ANY /api/iaaa/access-request/decision",
  "ANY /api/iaaa/membership/grant",
  "ANY /api/iaaa/membership/revoke",
  "ANY /api/iaaa/membership/edit",
  "ANY /api/iaaa/permission/deny",
  "ANY /api/iaaa/permission/clear",
  "ANY /api/iaaa/role-grants",
  "ANY /api/iaaa/role-grants/grant",
  "ANY /api/iaaa/role-grants/revoke",
  "ANY /api/iaaa/logged-in-users",
  "ANY /api/iaaa/logged-in-users/revoke",
  "ANY /api/iaaa/quota-usage",
  "ANY /api/iaaa/quota-usage/override",
  "ANY /api/iaaa/policy-proposals",
  "ANY /api/iaaa/policy-proposals/active",
  "ANY /api/iaaa/policy-proposals/propose",
  "ANY /api/iaaa/policy-proposals/approve",
  "ANY /api/iaaa/policy-proposals/reject",
  "ANY /api/iaaa/policy-proposals/promote",
  "ANY /api/iaaa/policy-proposals/preview",
  "ANY /api/iaaa/bootstrap-proposals",
  "ANY /api/iaaa/bootstrap-proposals/current",
  "ANY /api/iaaa/bootstrap-proposals/propose",
  "ANY /api/iaaa/bootstrap-proposals/approve",
  "ANY /api/iaaa/bootstrap-proposals/reject",
  "ANY /api/iaaa/bootstrap-proposals/confirm-applied",
  "ANY /api/iaaa/memberships",
  "ANY /api/iaaa/deactivate",
  "ANY /api/iaaa/offboard",
  "ANY /api/api-keys",
  "ANY PREFIX /api/api-keys/",
  "ANY /mcp",
  "ANY /api/mcp",
  "ANY /mcp/scanner",
  "ANY PREFIX /mcp/scanner/",
  "OPTIONS PREFIX /api/premium/",
  "OPTIONS PREFIX /api/payments/agentic/",
  "OPTIONS PREFIX /payments/agentic/commercial/",
  "ANY PREFIX /api/payments/agentic/",
  "ANY PREFIX /payments/agentic/commercial/",
  "ANY PREFIX /api/premium/",
  "ANY PREFIX /api/payments/webhook",
  "ANY /payments/webhook",
  "POST /api/trading/email/inbound",
  "GET /api/trading/email/approve",
  "POST /api/trading/slack/test",
  "POST /api/trading/slack/link",
  "POST /api/trading/voice/turn",
  "POST /api/trading/voice/test",
  "GET /api/trading/voice/greeting",
  "POST|GET PREFIX /api/trading/options/",
  "POST|GET PREFIX /trading/options/",
  "ANY PREFIX /api/schedules",
  "ANY /api/schedules",
  "GET /api/market-data/quotes",
  "GET /api/market/quotes",
  "GET /api/foss/quotes",
  "GET|POST /api/market/quotes/source",
  "POST /api/browser/snapshot",
  "POST /browser/snapshot",
  "POST /api/browser/transaction-snap",
  "POST /browser/transaction-snap",
  "POST /api/browser/snap/transaction",
  "POST /slack/commands",
  "POST /slack/slash",
  "POST /slack",
  "POST /slack/events",
  "POST /slack/interactions",
  "ANY /slack/install",
  "ANY /slack/oauth_callback",
  "ANY /trade/approve",
  "ANY /clear",
  "ANY /reset",
  "ANY /api/clear",
  "ANY /api/reset",
  "ANY PREFIX /api/options/flows/",
  "ANY /openapi.json",
  "ANY /api/docs",
  "ANY PREFIX /api/",
  "ANY /checkout/sandbox",
  "ANY /",
  "ANY /index.html",
  "FALLBACK static",
];

describe("server route inventory pin (#2902)", () => {
  it("reconstructs the full ordered route inventory 1:1", () => {
    expect(reconstruct()).toEqual(EXPECTED_ROUTES);
  });

  it("delegates Core + Auth branches in handleFetch in the original order", () => {
    const serverSrc = readFileSync("src/server.ts", "utf8");
    const calls = [...serverSrc.matchAll(/(?:await )?(handle\w+Routes)\(request, env, url, path/g)].map((m) => m[1]);
    // Slice 2 landed the three Core delegations; Slice 3 (#2902) adds the
    // three Auth delegations in their original dispatch positions, between
    // the Core ones. Later slices extend this list in dispatch order.
    expect(calls).toEqual([
      "handleCoreEarlyRoutes",
      "handleAuthLoginRoutes",
      "handleCoreHealthRoutes",
      "handleAuthMeRoutes",
      "handleAuthIaaaRoutes",
      "handleCoreLateRoutes",
    ]);
  });

  it("shared auth lives once in src/server/auth.ts, not in server.ts", () => {
    const authSrc = readFileSync("src/server/auth.ts", "utf8");
    expect(authSrc).toContain("export function isAllowedOrigin");
    expect(authSrc).toContain("export async function requireAuth");
    expect(authSrc).toContain("export async function authenticateRequest");
    const serverSrc = readFileSync("src/server.ts", "utf8");
    expect(serverSrc).not.toContain("function isAllowedOrigin(");
    expect(serverSrc).not.toContain("function requireAuth(");
    expect(serverSrc).not.toContain("function authenticateRequest(");
    expect(serverSrc).toContain('from "./server/auth"');
  });

  it("server.ts shrank versus the Slice 2 baseline (7,431 lines)", () => {
    const lines = readFileSync("src/server.ts", "utf8").split("\n").length;
    expect(lines).toBeLessThan(7431);
  });
});

// --- Dispatch smoke: moved Core branches answer exactly as before ---

const fetchWorker = async (path: string, method = "GET") => {
  const res = await worker.fetch(new Request(`https://agent.test${path}`, { method }), {} as any);
  return res;
};

describe("core dispatch smoke (#2902 Slice 2)", () => {
  it("GET /health and /api/health are public and healthy", async () => {
    for (const p of ["/health", "/api/health"]) {
      const res = await fetchWorker(p);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("healthy");
    }
  });

  it("GET /.well-known/oauth-client-id-metadata-document is public", async () => {
    const res = await fetchWorker("/.well-known/oauth-client-id-metadata-document");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("GET /checkout/sandbox stays public (KEEP PUBLIC, #2052)", async () => {
    const res = await fetchWorker("/checkout/sandbox");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Payment Terminal");
  });

  it("GET /openapi.json and /api/docs still 401 without a session", async () => {
    expect((await fetchWorker("/openapi.json")).status).toBe(401);
    expect((await fetchWorker("/api/docs")).status).toBe(401);
  });

  it("unknown /api/* still 401s at the fallthrough without a session", async () => {
    expect((await fetchWorker("/api/no-such-route-2902")).status).toBe(401);
  });

  it("GET / still serves the landing page without a session", async () => {
    const res = await fetchWorker("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("GET /api/features still answers without a session (session optional)", async () => {
    const res = await fetchWorker("/api/features");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features?: unknown };
    expect(body.features).toBeDefined();
  });

  it("inline routes still answer as before without a session (no route dropped by the Core move)", async () => {
    // /api/me answers 200 { authenticated: false } by design (not a 401).
    const me = await fetchWorker("/api/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(false);
    expect((await fetchWorker("/api/privacy/status")).status).toBe(401);
  });
});
