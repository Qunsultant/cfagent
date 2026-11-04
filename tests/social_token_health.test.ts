/**
 * #1077 token-health slice (#1160): per-channel token presence plus
 * optional live validity validation over an injected transport.
 *
 * Pinned here:
 * - With no tokens configured (the expected production state today),
 *   every channel reports unconfigured and validity unknown, and no
 *   transport call is ever made — not even for a configured channel
 *   without a transport, and never for the X channel, whose
 *   validation endpoint is UNCONFIRMED (see tokenHealth.ts).
 * - Validity comes only from a live check over an injected
 *   transport: 2xx → valid, 401/403 → invalid, any other status or
 *   a transport throw → unknown. Tests use fakes only; no test
 *   touches a network.
 * - Output is status only: no test token value, prefix, or platform
 *   error text ever appears in a result — the transport surface
 *   carries status numbers only, so a body can never leak through.
 * - GET /api/social/token-health is session-gated (401
 *   unauthenticated), like the brief/approval routes, and its
 *   response likewise never contains a token value.
 */
import { describe, it, expect, vi } from "vitest";
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
import {
  checkAllTokenHealth,
  checkChannelTokenHealth,
} from "../src/agents/social/tokenHealth";
import type { TokenHealthTransport } from "../src/agents/social/tokenHealth";

const TEST_TOKEN = "test-token-abc123";
const TEST_URN = "urn:li:person:test123";

function makeFakeTransport(
  behavior: (url: string) => number | Error = () => 200,
): TokenHealthTransport & {
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    async get(url: string, headers: Record<string, string>) {
      calls.push({ url, headers });
      const outcome = behavior(url);
      if (outcome instanceof Error) throw outcome;
      return { status: outcome };
    },
  };
}

function tokensFor(channel: string, extra: Record<string, string | undefined> = {}) {
  const map: Record<string, string> = {
    x: "X_ACCESS_TOKEN",
    threads: "THREADS_ACCESS_TOKEN",
    facebook: "FACEBOOK_PAGE_ACCESS_TOKEN",
    instagram: "INSTAGRAM_ACCESS_TOKEN",
    linkedin: "LINKEDIN_ACCESS_TOKEN",
  };
  return { [map[channel]]: TEST_TOKEN, ...extra };
}

describe("checkAllTokenHealth with no tokens", () => {
  it("reports every channel unconfigured, validity unknown, and makes no transport call", async () => {
    const transport = makeFakeTransport();
    const results = await checkAllTokenHealth({}, transport);
    expect(results.map((r) => r.channel)).toEqual([
      "threads",
      "x",
      "facebook",
      "instagram",
      "linkedin",
    ]);
    for (const r of results) {
      expect(r.presence).toBe("unconfigured");
      expect(r.validity).toBe("unknown");
      expect(r.validated).toBe(false);
    }
    expect(transport.calls).toEqual([]);
    expect(JSON.stringify(results)).not.toContain(TEST_TOKEN);
  });

  it("reports every channel unconfigured without any transport at all", async () => {
    const results = await checkAllTokenHealth({});
    expect(results.every((r) => r.presence === "unconfigured")).toBe(true);
    expect(results.every((r) => r.validity === "unknown")).toBe(true);
  });
});

describe("checkChannelTokenHealth presence without validation", () => {
  it("reports configured + unknown and never calls the transport when none is injected", async () => {
    const transport = makeFakeTransport();
    const result = await checkChannelTokenHealth("threads", tokensFor("threads"));
    expect(result?.presence).toBe("configured");
    expect(result?.validity).toBe("unknown");
    expect(result?.validated).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("treats a whitespace-only token as unconfigured and never calls the transport", async () => {
    const transport = makeFakeTransport();
    const result = await checkChannelTokenHealth(
      "x",
      { X_ACCESS_TOKEN: "   " },
      transport,
    );
    expect(result?.presence).toBe("unconfigured");
    expect(transport.calls).toEqual([]);
  });

  it("returns undefined for an unknown channel", async () => {
    expect(await checkChannelTokenHealth("myspace", {})).toBeUndefined();
  });
});

describe("checkChannelTokenHealth live validation over an injected transport", () => {
  it("maps 2xx to valid and sends a Bearer header to the confirmed endpoint", async () => {
    const transport = makeFakeTransport(() => 200);
    const result = await checkChannelTokenHealth("threads", tokensFor("threads"), transport);
    expect(result?.validity).toBe("valid");
    expect(result?.validated).toBe(true);
    expect(result?.validationEndpointConfirmed).toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].url).toBe("https://graph.threads.net/v1.0/me");
    expect(transport.calls[0].headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("maps 401 and 403 to invalid", async () => {
    for (const status of [401, 403]) {
      const transport = makeFakeTransport(() => status);
      const result = await checkChannelTokenHealth("facebook", tokensFor("facebook"), transport);
      expect(result?.validity).toBe("invalid");
      expect(result?.validated).toBe(true);
      expect(transport.calls[0].url).toBe("https://graph.facebook.com/v21.0/me");
    }
  });

  it("maps any other status to unknown and records the status number only", async () => {
    const transport = makeFakeTransport(() => 500);
    const result = await checkChannelTokenHealth("instagram", tokensFor("instagram"), transport);
    expect(result?.validity).toBe("unknown");
    expect(result?.validated).toBe(true);
    expect(result?.validationStatus).toBe(500);
    expect(transport.calls[0].url).toBe("https://graph.instagram.com/v21.0/me");
  });

  it("maps a transport throw to unknown with a transport-error detail", async () => {
    const transport = makeFakeTransport(() => new Error("boom"));
    const result = await checkChannelTokenHealth("threads", tokensFor("threads"), transport);
    expect(result?.validity).toBe("unknown");
    expect(result?.validated).toBe(true);
    expect(result?.validationDetail).toBe("transport-error");
  });

  it("sends the LinkedIn protocol-version header and validates the /v2/me endpoint", async () => {
    const transport = makeFakeTransport(() => 200);
    const result = await checkChannelTokenHealth(
      "linkedin",
      tokensFor("linkedin", { LINKEDIN_AUTHOR_URN: TEST_URN }),
      transport,
    );
    expect(result?.validity).toBe("valid");
    expect(transport.calls[0].url).toBe("https://api.linkedin.com/v2/me");
    expect(transport.calls[0].headers["X-RestLi-Protocol-Version"]).toBe("2.0.0");
    expect(result?.accountPresence).toBe("configured");
  });

  it("reports LinkedIn account presence separately and never blocks validity on it", async () => {
    const transport = makeFakeTransport(() => 200);
    const withoutUrn = await checkChannelTokenHealth("linkedin", tokensFor("linkedin"), transport);
    expect(withoutUrn?.accountPresence).toBe("unconfigured");
    expect(withoutUrn?.validity).toBe("valid");
    expect(transport.calls).toHaveLength(1);
  });

  it("never validates X: endpoint unconfirmed, so no transport call and validity stays unknown", async () => {
    const transport = makeFakeTransport(() => 200);
    const result = await checkChannelTokenHealth("x", tokensFor("x"), transport);
    expect(result?.presence).toBe("configured");
    expect(result?.validity).toBe("unknown");
    expect(result?.validated).toBe(false);
    expect(result?.validationEndpointConfirmed).toBe(false);
    expect(result?.validationEndpoint).toBeNull();
    expect(transport.calls).toEqual([]);
  });
});

describe("token-health output never carries a token value", () => {
  it("no result field contains the token, even after a live validation", async () => {
    const transport = makeFakeTransport(() => 200);
    const results = await checkAllTokenHealth(
      {
        X_ACCESS_TOKEN: TEST_TOKEN,
        THREADS_ACCESS_TOKEN: TEST_TOKEN,
        FACEBOOK_PAGE_ACCESS_TOKEN: TEST_TOKEN,
        INSTAGRAM_ACCESS_TOKEN: TEST_TOKEN,
        LINKEDIN_ACCESS_TOKEN: TEST_TOKEN,
        LINKEDIN_AUTHOR_URN: TEST_URN,
      },
      transport,
    );
    const text = JSON.stringify(results);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(TEST_URN);
    // The only per-channel strings are fixed enums and env var names.
    for (const r of results) {
      expect(["configured", "unconfigured"]).toContain(r.presence);
      expect(["valid", "invalid", "unknown"]).toContain(r.validity);
    }
  });
});

// --- Route tests (worker.fetch harness, same pattern as the approval routes) ---

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-31200000000c";

function makeEnv(extra: Record<string, unknown> = {}) {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: "octocat-health" });
  return {
    SESSION_STORE: sessionStoreNs,
    ...extra,
  } as unknown as Env;
}

function req(method: string, path: string, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
    headers: cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {},
  });
}

describe("GET /api/social/token-health route", () => {
  it("returns 401 unauthenticated", async () => {
    const res = await worker.fetch(req("GET", "/api/social/token-health"), makeEnv(), {} as never);
    expect(res.status).toBe(401);
  });

  it("returns 405 for non-GET methods when authenticated", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/social/token-health", SESSION_ID),
      env,
      {} as never,
    );
    expect(res.status).toBe(405);
  });

  it("reports all channels unconfigured when no tokens are set, and leaks no token value", async () => {
    const env = makeEnv({ X_ACCESS_TOKEN: TEST_TOKEN });
    const res = await worker.fetch(
      req("GET", "/api/social/token-health", SESSION_ID),
      env,
      {} as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      channels: { channel: string; presence: string; validity: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.channels.map((c) => c.channel)).toEqual([
      "threads",
      "x",
      "facebook",
      "instagram",
      "linkedin",
    ]);
    const x = body.channels.find((c) => c.channel === "x")!;
    expect(x.presence).toBe("configured");
    // No live transport is wired in this slice, so validity is unknown
    // by design — never assumed valid.
    expect(x.validity).toBe("unknown");
    expect(body.channels.filter((c) => c.channel !== "x").every((c) => c.presence === "unconfigured")).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
  });
});
