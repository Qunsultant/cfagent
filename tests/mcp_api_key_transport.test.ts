/**
 * Issue #180: the /mcp + /api/mcp transport identified callers by the
 * caller-asserted `x-user-id` header, falling back to a shared
 * "mcp_client" identity. The asserted string SELECTED the
 * OrchestratorAgent DO instance (src/server.ts `idFromName(userLogin)`),
 * so an unauthenticated caller could run the full MCP tool registry
 * inside ANY user's agent instance — their ledger, memory and E*TRADE
 * token context — by asserting their login, or anonymously under the
 * shared instance.
 *
 * Decided design (2026-10-20, Option B): transport identity is the app
 * session OR a per-user API key (`Authorization: Bearer cfk_…`, minted
 * in Settings → API Keys), bound to the GitHub login that minted it.
 * `x-user-id` is ignored entirely; no credential → 401 before any DO
 * access. Keys are stored hash-only (SHA-256) in the SessionStore DO
 * (src/security/apiKeys.ts); the plaintext secret is shown once at mint.
 *
 * Harnesses:
 * - apiKeys unit tests drive src/security/apiKeys.ts against
 *   tests/fake-session-store.ts (#604's fake store protocol).
 * - Worker tests follow tests/fallback_identity_session_gate.test.ts
 *   (#154): the REAL worker fetch dispatch with a recording ORCHESTRATOR_AGENT
 *   stub, so instance selection (the idFromName argument) is asserted,
 *   not inferred.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/fallback_identity_session_gate.test.ts);
// routeAgentRequest returns null so the worker's own route dispatch runs.
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
import { makeFakeSessionStore, type FakeSessionStore } from "./fake-session-store";
import {
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from "../src/security/apiKeys";

const ALICE = "alice-180";
const BOB = "bob-180";
// Session ids must be UUID-shaped (session.ts rejects anything else
// before a store read, #329).
const ALICE_SESSION = "18000000-0000-4000-8000-0000000000a1";
const BOB_SESSION = "18000000-0000-4000-8000-0000000000b2";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// apiKeys unit tests
// ---------------------------------------------------------------------------

function unitEnv() {
  const fake = makeFakeSessionStore();
  return { fake, env: { SESSION_STORE: fake.namespace } as unknown as Env };
}

describe("apiKeys store (#180)", () => {
  it("mint → verify round-trip returns the bound login and key id", async () => {
    const { env } = unitEnv();
    const { key, secret } = await mintApiKey(env, ALICE, "laptop");
    expect(secret).toMatch(/^cfk_[A-Za-z0-9_-]{43}$/);
    expect(key.label).toBe("laptop");
    expect(key.lastUsedAt).toBeNull();

    const verified = await verifyApiKey(env, secret);
    expect(verified).toEqual({ login: ALICE, keyId: key.id });
  });

  it("stores ONLY the SHA-256 hash — the plaintext secret appears nowhere in the store", async () => {
    const { fake, env } = unitEnv();
    const { secret } = await mintApiKey(env, ALICE, "ci runner");
    const hash = await sha256Hex(secret);

    const everything = [...fake.store.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    expect(everything).not.toContain(secret);
    // What IS persisted is the hash (record field + lookup index).
    expect(everything).toContain(hash);
    expect(fake.store.has(`api_keys:hash:${hash}`)).toBe(true);
  });

  it("wrong, malformed, and missing keys all verify as null (constant-shape)", async () => {
    const { env } = unitEnv();
    await mintApiKey(env, ALICE, "real key");
    const wrongButWellFormed = `cfk_${"A".repeat(43)}`;
    expect(await verifyApiKey(env, wrongButWellFormed)).toBeNull();
    expect(await verifyApiKey(env, "cfk_short")).toBeNull();
    expect(await verifyApiKey(env, "not-a-key")).toBeNull();
    expect(await verifyApiKey(env, "")).toBeNull();
    expect(await verifyApiKey(env, null)).toBeNull();
    expect(await verifyApiKey(env, undefined)).toBeNull();
  });

  it("a revoked key no longer verifies", async () => {
    const { env } = unitEnv();
    const { key, secret } = await mintApiKey(env, ALICE, "temp");
    expect(await verifyApiKey(env, secret)).not.toBeNull();
    expect(await revokeApiKey(env, ALICE, key.id)).toBe(true);
    expect(await verifyApiKey(env, secret)).toBeNull();
  });

  it("list returns metadata only — no secret, no hash — and stamps lastUsedAt after use", async () => {
    const { env } = unitEnv();
    const { key, secret } = await mintApiKey(env, ALICE, "desktop");
    await verifyApiKey(env, secret);

    const listed = await listApiKeys(env, ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(key.id);
    expect(listed[0].label).toBe("desktop");
    expect(listed[0].prefix).toBe(secret.slice(0, 12));
    expect(listed[0].lastUsedAt).not.toBeNull();
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(await sha256Hex(secret));
    expect(serialized).not.toContain("hash");
  });

  it("keys are isolated per user: list and revoke never cross logins", async () => {
    const { env } = unitEnv();
    const aliceMint = await mintApiKey(env, ALICE, "alice key");
    await mintApiKey(env, BOB, "bob key");

    expect(await listApiKeys(env, ALICE)).toHaveLength(1);
    expect((await listApiKeys(env, BOB))[0].label).toBe("bob key");

    // Bob cannot revoke Alice's key, and the attempt changes nothing.
    expect(await revokeApiKey(env, BOB, aliceMint.key.id)).toBe(false);
    expect(await verifyApiKey(env, aliceMint.secret)).not.toBeNull();
    expect(await listApiKeys(env, ALICE)).toHaveLength(1);
  });

  it("multiple keys per user coexist; revoking one leaves the other working", async () => {
    const { env } = unitEnv();
    const first = await mintApiKey(env, ALICE, "one");
    const second = await mintApiKey(env, ALICE, "two");
    expect(first.secret).not.toBe(second.secret);

    expect(await revokeApiKey(env, ALICE, first.key.id)).toBe(true);
    expect(await verifyApiKey(env, first.secret)).toBeNull();
    expect(await verifyApiKey(env, second.secret)).not.toBeNull();
    expect(await listApiKeys(env, ALICE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Worker-level harness (transport + key routes)
// ---------------------------------------------------------------------------

interface ForwardedCall {
  id: string;
  pathname: string;
  userLogin: string | null;
}

function workerEnv(fake: FakeSessionStore) {
  const forwarded: ForwardedCall[] = [];
  const env: any = {
    SESSION_STORE: fake.namespace,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            userLogin: req.headers.get("x-user-login"),
          });
          return Response.json({ ok: true });
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

function seededWorker() {
  const fake = makeFakeSessionStore();
  fake.seed("sessions", ALICE_SESSION, { githubLogin: ALICE, userId: "180a", login: ALICE });
  fake.seed("sessions", BOB_SESSION, { githubLogin: BOB, userId: "180b", login: BOB });
  return { fake, ...workerEnv(fake) };
}

const req = (
  path: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {}
) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(opts.cookie ? { Cookie: `session_id=${opts.cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

const mcpCall = (opts: Parameters<typeof req>[1] = {}) =>
  req("/api/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    ...opts,
  });

// ---------------------------------------------------------------------------
// MCP transport identity
// ---------------------------------------------------------------------------

describe("worker /mcp transport — session or API key only (#180)", () => {
  it("no session and no key → 401 JSON, agent never invoked", async () => {
    const { env, forwarded } = seededWorker();
    const res = await worker.fetch(mcpCall(), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    expect(forwarded).toHaveLength(0);
  });

  it("x-user-id alone → 401: the header no longer asserts an identity or selects an instance", async () => {
    const { env, forwarded } = seededWorker();
    const res = await worker.fetch(mcpCall({ headers: { "x-user-id": ALICE } }), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("a valid API key → forwarded to the KEY OWNER's instance with x-user-login set", async () => {
    const { env, forwarded } = seededWorker();
    const { secret } = await mintApiKey(env, ALICE, "external client");

    const res = await worker.fetch(
      mcpCall({ headers: { Authorization: `Bearer ${secret}` } }),
      env
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(ALICE);
    expect(forwarded[0].pathname).toBe("/mcp");
    expect(forwarded[0].userLogin).toBe(ALICE);
  });

  it("the bare /mcp spelling accepts a valid API key the same way", async () => {
    const { env, forwarded } = seededWorker();
    const { secret } = await mintApiKey(env, BOB, "bare path");
    const res = await worker.fetch(
      req("/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(BOB);
  });

  it("a session cookie → forwarded to the SESSION user's instance (in-app explorer path)", async () => {
    const { env, forwarded } = seededWorker();
    const res = await worker.fetch(mcpCall({ cookie: ALICE_SESSION }), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(ALICE);
    expect(forwarded[0].userLogin).toBe(ALICE);
  });

  it("session + spoofed x-user-id → the SESSION identity wins, the header is ignored", async () => {
    const { env, forwarded } = seededWorker();
    const res = await worker.fetch(
      mcpCall({ cookie: BOB_SESSION, headers: { "x-user-id": ALICE } }),
      env
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(BOB);
  });

  it("a garbage Bearer credential → 401, agent never invoked", async () => {
    const { env, forwarded } = seededWorker();
    const res = await worker.fetch(
      mcpCall({ headers: { Authorization: "Bearer cfk_garbage" } }),
      env
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("a revoked key → 401 at the transport", async () => {
    const { env, forwarded } = seededWorker();
    const { key, secret } = await mintApiKey(env, ALICE, "soon revoked");
    await revokeApiKey(env, ALICE, key.id);
    const res = await worker.fetch(
      mcpCall({ headers: { Authorization: `Bearer ${secret}` } }),
      env
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("OPTIONS preflight still answers, and no longer advertises x-user-id", async () => {
    const { env } = seededWorker();
    const res = await worker.fetch(req("/api/mcp", { method: "OPTIONS" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Headers")).not.toContain("x-user-id");
  });
});

// ---------------------------------------------------------------------------
// Key-management routes
// ---------------------------------------------------------------------------

describe("worker /api/api-keys routes — session's own keys only (#180)", () => {
  it("unauthenticated list/mint/revoke → 401", async () => {
    const { env } = seededWorker();
    expect((await worker.fetch(req("/api/api-keys"), env)).status).toBe(401);
    expect(
      (await worker.fetch(req("/api/api-keys", { method: "POST", body: { label: "x" } }), env))
        .status
    ).toBe(401);
    expect(
      (await worker.fetch(req("/api/api-keys/key_whatever", { method: "DELETE" }), env)).status
    ).toBe(401);
  });

  it("mint returns the secret exactly once; list shows metadata for the owner only", async () => {
    const { env } = seededWorker();
    const mintRes = await worker.fetch(
      req("/api/api-keys", { method: "POST", cookie: ALICE_SESSION, body: { label: "laptop" } }),
      env
    );
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as any;
    expect(minted.secret).toMatch(/^cfk_[A-Za-z0-9_-]{43}$/);
    expect(minted.key.label).toBe("laptop");
    expect(JSON.stringify(minted.key)).not.toContain("hash");

    const aliceList = (await (
      await worker.fetch(req("/api/api-keys", { cookie: ALICE_SESSION }), env)
    ).json()) as any;
    expect(aliceList.keys).toHaveLength(1);
    expect(JSON.stringify(aliceList)).not.toContain(minted.secret);

    const bobList = (await (
      await worker.fetch(req("/api/api-keys", { cookie: BOB_SESSION }), env)
    ).json()) as any;
    expect(bobList.keys).toHaveLength(0);
  });

  it("mint without a label falls back to a default label", async () => {
    const { env } = seededWorker();
    const mintRes = await worker.fetch(
      req("/api/api-keys", { method: "POST", cookie: ALICE_SESSION, body: {} }),
      env
    );
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as any;
    expect(minted.key.label).toBe("API key");
  });

  it("cross-user revoke → 404 and the victim's key keeps working", async () => {
    const { env } = seededWorker();
    const mintRes = await worker.fetch(
      req("/api/api-keys", { method: "POST", cookie: ALICE_SESSION, body: { label: "mine" } }),
      env
    );
    const minted = (await mintRes.json()) as any;

    const bobDelete = await worker.fetch(
      req(`/api/api-keys/${minted.key.id}`, { method: "DELETE", cookie: BOB_SESSION }),
      env
    );
    expect(bobDelete.status).toBe(404);

    // Alice's key still verifies and still authenticates at the transport.
    expect(await verifyApiKey(env, minted.secret)).not.toBeNull();
    const res = await worker.fetch(
      mcpCall({ headers: { Authorization: `Bearer ${minted.secret}` } }),
      env
    );
    expect(res.status).toBe(200);
  });

  it("owner revoke → 200, key disappears from the list and stops authenticating", async () => {
    const { env, forwarded } = seededWorker();
    const mintRes = await worker.fetch(
      req("/api/api-keys", { method: "POST", cookie: ALICE_SESSION, body: { label: "mine" } }),
      env
    );
    const minted = (await mintRes.json()) as any;

    const del = await worker.fetch(
      req(`/api/api-keys/${minted.key.id}`, { method: "DELETE", cookie: ALICE_SESSION }),
      env
    );
    expect(del.status).toBe(200);

    const list = (await (
      await worker.fetch(req("/api/api-keys", { cookie: ALICE_SESSION }), env)
    ).json()) as any;
    expect(list.keys).toHaveLength(0);

    const res = await worker.fetch(
      mcpCall({ headers: { Authorization: `Bearer ${minted.secret}` } }),
      env
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source pins — the asserted-header identity must not return to the MCP block
// ---------------------------------------------------------------------------

describe("source pins (#180)", () => {
  it("the MCP transport block contains no x-user-id identity and no mcp_client fallback", () => {
    // Slice 7 of Qunsultant/cfagent#2902 (2026-11-05): the MCP block
    // moved from src/server.ts to src/server/routes/platform.ts; the
    // entry surface is server.ts + routes/*.ts, so the pin reads the
    // moved block there (assertions unchanged).
    const server = readFileSync("src/server/routes/platform.ts", "utf8");
    const start = server.indexOf("Model Context Protocol (MCP)");
    const end = server.indexOf("Cloudflare Wallets / x402 Pay-Per-Use Options Scanner");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = server.slice(start, end);
    // The vulnerability patterns, not the words (the block's comment
    // documents the old header by name): identity read from the asserted
    // header, and the shared fallback identity.
    expect(block).not.toContain('headers.get("x-user-id")');
    expect(block).not.toContain('|| "mcp_client"');
    expect(block).toContain("verifyApiKey");
  });
});
