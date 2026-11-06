/**
 * Issue #700 (point 1): /mcp/scanner session affinity is not identity.
 *
 * src/server.ts picks the OptionsScannerMCP Durable Object instance for
 * /mcp/scanner from a client-supplied affinity value:
 *   x-scanner-session  (the honest header)
 *   || x-user-id       (deprecated alias, retained for instance continuity)
 *   || "public_scanner"
 *
 * The value ONLY selects an instance, so a client's queued scans stay on
 * one DO. No identity propagates downstream on this route: the scanner
 * DO never reads either header and forwards under its own context
 * ("default_trader" / "cf_wallet_scanner" in
 * src/mcps/scanner/cloudflareWalletsScanner.ts). A login-shaped affinity
 * value therefore asserts nothing — unlike the #154/#180/#183 routes,
 * where the established identity selects the caller's own agent instance.
 *
 * These tests pin the transport behaviour through the real worker fetch:
 *  - the same affinity value selects the same instance under either
 *    header name;
 *  - when both headers are present, x-scanner-session wins;
 *  - with neither header, traffic shares the "public_scanner" instance;
 *  - a victim-login-shaped value is only ever an affinity label: the
 *    instance is selected by the literal value and no session/identity
 *    lookup happens on this route (the env below deliberately has no
 *    session store at all, yet routing succeeds).
 *
 * Adjacent pin (#700): the premium/wallet CORS preflight no longer
 * advertises x-user-id in Access-Control-Allow-Headers — post-#183 those
 * routes strip/ignore identity headers, so the preflight must not invite
 * clients to send one.
 *
 * Harness: same stand-ins as the #154/#183 transport tests
 * (tests/agentic_payments_identity_binding.test.ts) — module mocks for
 * the agent graph the node loader cannot resolve, a recording
 * OPTIONS_SCANNER_MCP stub whose idFromName calls are observable, and a
 * recording ORCHESTRATOR_AGENT stub for the preflight's never-forwards check.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Module mocks: same stand-ins as the #154/#183 transport gate tests —
// src/server.ts re-exports agent classes whose module graph the node
// loader cannot resolve.
// ---------------------------------------------------------------------------
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

interface ScannerForward {
  id: string;
  pathname: string;
  userId: string | null;
  scannerSession: string | null;
}

function makeScannerEnv() {
  const idFromNameCalls: string[] = [];
  const forwarded: ScannerForward[] = [];
  const agentForwarded: string[] = [];
  const env: any = {
    OPTIONS_SCANNER_MCP: {
      idFromName: (name: string) => {
        idFromNameCalls.push(name);
        return name;
      },
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            userId: req.headers.get("x-user-id"),
            scannerSession: req.headers.get("x-scanner-session"),
          });
          return Response.json({ ok: true });
        },
      }),
    },
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (_req: Request) => {
          agentForwarded.push(id);
          return Response.json({ ok: true });
        },
      }),
    },
    // Deliberately NO SESSION_STORE: this route must never consult
    // identity state (see the login-shaped-value test below).
  };
  return { env: env as Env, idFromNameCalls, forwarded, agentForwarded };
}

const sreq = (path: string, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`https://agent.test${path}`, { method, headers });

describe("worker /mcp/scanner — session affinity, not identity (#700)", () => {
  it("the same affinity value selects the SAME instance as x-user-id and as x-scanner-session", async () => {
    const a = makeScannerEnv();
    const resA = await worker.fetch(sreq("/mcp/scanner", { "x-user-id": "affinity-abc" }), a.env);
    expect(resA.status).toBe(200);
    expect(a.idFromNameCalls).toEqual(["affinity-abc"]);
    expect(a.forwarded.map((f) => f.id)).toEqual(["affinity-abc"]);

    const b = makeScannerEnv();
    const resB = await worker.fetch(
      sreq("/mcp/scanner", { "x-scanner-session": "affinity-abc" }),
      b.env,
    );
    expect(resB.status).toBe(200);
    expect(b.idFromNameCalls).toEqual(["affinity-abc"]);
    expect(b.forwarded.map((f) => f.id)).toEqual(a.forwarded.map((f) => f.id));
  });

  it("both headers present with different values → x-scanner-session wins", async () => {
    const { env, idFromNameCalls, forwarded } = makeScannerEnv();
    const res = await worker.fetch(
      sreq("/mcp/scanner", { "x-scanner-session": "sess-1", "x-user-id": "someone-else" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual(["sess-1"]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe("sess-1");
  });

  it("no affinity headers → the shared public_scanner instance", async () => {
    const { env, idFromNameCalls, forwarded } = makeScannerEnv();
    const res = await worker.fetch(sreq("/mcp/scanner"), env);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual(["public_scanner"]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe("public_scanner");
  });

  it("a login-shaped x-user-id is only an affinity label — instance picked by the literal value, no identity lookup", async () => {
    const { env, idFromNameCalls, forwarded } = makeScannerEnv();
    const res = await worker.fetch(sreq("/mcp/scanner", { "x-user-id": "victim-login" }), env);
    // Routing succeeds with no session store in env at all: nothing on
    // this route resolves the value to a user. The value's only effect
    // is naming the instance — the same effect any opaque string has.
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual(["victim-login"]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe("victim-login");
  });
});

describe("worker premium/wallet CORS preflight — no identity headers advertised (#700)", () => {
  it("OPTIONS preflight allow-headers no longer include x-user-id", async () => {
    const { env, agentForwarded } = makeScannerEnv();
    for (const path of ["/api/premium/options-scan", "/api/payments/agentic/wallet"]) {
      const res = await worker.fetch(sreq(path, {}, "OPTIONS"), env);
      expect(res.status).toBe(200);
      const allow = res.headers.get("Access-Control-Allow-Headers") || "";
      expect(allow).not.toContain("x-user-id");
      expect(allow).toContain("Content-Type");
      expect(allow).toContain("x-environment");
    }
    expect(agentForwarded).toHaveLength(0);
  });
});

describe("the server entry — no CORS surface advertises x-user-id (#700)", () => {
  it("no Access-Control-Allow-Headers value in the server entry mentions x-user-id", () => {
    // Slice 7 of Qunsultant/cfagent#2902 (2026-11-05): the scanner CORS
    // block moved from src/server.ts to src/server/routes/platform.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files (assertions unchanged).
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
      + readFileSync(new URL("../src/server/routes/platform.ts", import.meta.url), "utf8");
    const values = [...src.matchAll(/Access-Control-Allow-Headers"?\s*[:,]\s*"?([^"\n]+)"?/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).not.toContain("x-user-id");
  });
});
