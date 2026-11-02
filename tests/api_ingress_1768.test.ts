import { describe, it, expect, beforeEach } from "vitest";
import { resetRateLimits } from "../src/security/rateLimiter";
import {
  API_INGRESS_MODE_VALUES,
  levelsForApiIngressMode,
  resolveApiIngressMode,
} from "../src/config/apiIngressModes";
import {
  IDENTITY_HEADERS,
  WEBHOOK_SIGNATURE_HEADERS,
  WS_UPGRADE_BURST,
  applyVerifiedIdentity,
  checkWsUpgradeBurst,
  createIngressThrottle,
  jsonRpcInvalidParams,
  jsonRpcMethodNotFound,
  pickWebhookSignature,
  stripCallerIdentityHeaders,
  throttleClientKey,
} from "../src/api/ingress";
import { nlqWebhookBodySchema } from "../src/api/ingressSchemas";
import {
  API_INGRESS_ROUTES,
  checkIngressRoutesInSpec,
  validateOpenApiDocument,
} from "../src/api/openApiDrift";
import { buildOpenApiSpec } from "../src/security/openapiSpec";
import {
  WS_QUOTE_PATHS,
  WS_VOICE_PATHS,
  dispatchWsUpgrade,
} from "../src/api/wsRoutes";

/**
 * Issue #1768 (parent #1717): unified API/MCP ingress middleware v1.
 *
 * Red-first pins for the genuinely open gaps the slice closes:
 * - throttle keys on caller-supplied x-user-login (evasion: a fresh fake
 *   login mints a fresh bucket) instead of the connecting IP;
 * - the unauthenticated quotes WS upgrade path has no burst cap (F-40);
 * - webhook signature header names differ per consumer (F-48);
 * - MCP tools/call with a non-string name falls through to the SDK's
 *   -32603 dump instead of the established -32602 contract;
 * - no runtime check that the generated OpenAPI document covers the
 *   ingress routes it describes.
 * Already-unified on current main (verified, not rebuilt here): HMAC
 * webhook gates (#140/#147), session-route spoofing fixes (#154),
 * #1725 quote unification, the MCP SDK parity guard, and the PROD
 * E*TRADE session preflight (src/services/etradeAuthPreflight.ts).
 */

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("API_INGRESS_MODE switch (#1768)", () => {
  it("offers exactly legacy + unified, defaulting to legacy", () => {
    expect([...API_INGRESS_MODE_VALUES].sort()).toEqual(["legacy", "unified"]);
    expect(resolveApiIngressMode(levelsForApiIngressMode(undefined)).mode).toBe("legacy");
    expect(resolveApiIngressMode(levelsForApiIngressMode("unified")).mode).toBe("unified");
  });

  it("resolves run > session > user > env > built-in", () => {
    const levels = { run: "legacy", session: "unified", user: "legacy", env: "unified" };
    expect(resolveApiIngressMode(levels).mode).toBe("legacy");
    expect(resolveApiIngressMode({ env: "unified" }).mode).toBe("unified");
  });

  it("fails closed to legacy on an unrecognized value, without fall-through", () => {
    const resolved = resolveApiIngressMode({ run: "bogus", env: "unified" });
    expect(resolved.mode).toBe("legacy");
    expect(resolved.invalid).toBe(true);
  });
});

describe("uniform throttle key (#1768)", () => {
  beforeEach(() => resetRateLimits());

  it("keys on the connecting IP, never on caller-supplied identity headers", () => {
    const a = req("https://x.test/nlq/webhook", {
      "cf-connecting-ip": "203.0.113.7",
      "x-user-login": "alice",
    });
    const b = req("https://x.test/nlq/webhook", {
      "cf-connecting-ip": "203.0.113.7",
      "x-user-login": "mallory",
    });
    expect(throttleClientKey(a)).toBe("203.0.113.7");
    expect(throttleClientKey(b)).toBe("203.0.113.7");
  });

  it("a fake login does not mint a fresh throttle bucket", () => {
    const throttleA = createIngressThrottle(
      req("https://x.test/nlq/webhook", {
        "cf-connecting-ip": "203.0.113.7",
        "x-user-login": "alice",
      }),
    );
    const throttleB = createIngressThrottle(
      req("https://x.test/nlq/webhook", {
        "cf-connecting-ip": "203.0.113.7",
        "x-user-login": "mallory",
      }),
    );
    expect(throttleA("nlq_webhook", 2, 60_000)).toBeNull();
    expect(throttleA("nlq_webhook", 2, 60_000)).toBeNull();
    const denied = throttleB("nlq_webhook", 2, 60_000);
    expect(denied?.status).toBe(429);
  });

  it("a server-verified login scopes the bucket per user behind one IP", () => {
    const tAlice = createIngressThrottle(
      req("https://x.test/api/memory/search", { "cf-connecting-ip": "203.0.113.7" }),
      { verifiedLogin: "alice" },
    );
    const tBob = createIngressThrottle(
      req("https://x.test/api/memory/search", { "cf-connecting-ip": "203.0.113.7" }),
      { verifiedLogin: "bob" },
    );
    expect(tAlice("memory_search", 1, 60_000)).toBeNull();
    expect(tBob("memory_search", 1, 60_000)).toBeNull();
  });

  it("falls back to anonymous with no IP and no verified login", () => {
    expect(throttleClientKey(req("https://x.test/"))).toBe("anonymous");
  });

  it("keeps the established 429 shape with a Retry-After", async () => {
    const throttle = createIngressThrottle(req("https://x.test/", { "cf-connecting-ip": "203.0.113.9" }));
    expect(throttle("probe", 1, 60_000)).toBeNull();
    const denied = throttle("probe", 1, 60_000);
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toBeTruthy();
    expect((await denied?.json()) as { error?: string }).toEqual({
      error: "Rate limit exceeded. Slow down and retry.",
    });
  });
});

describe("caller-identity header guard (#1768)", () => {
  it("strips all caller identity carriers", () => {
    const headers = new Headers({
      "x-user-login": "mallory",
      "x-user-id": "42",
      "x-principal-kind": "session",
      "x-quote-expiry-mode": "honour",
    });
    const stripped = stripCallerIdentityHeaders(headers);
    for (const name of IDENTITY_HEADERS) expect(stripped.get(name)).toBeNull();
    expect(stripped.get("x-quote-expiry-mode")).toBe("honour");
  });

  it("applyVerifiedIdentity replaces caller identity with the session login", () => {
    const headers = new Headers({ "x-user-login": "mallory" });
    const applied = applyVerifiedIdentity(headers, "alice", "session");
    expect(applied.get("x-user-login")).toBe("alice");
    expect(applied.get("x-principal-kind")).toBe("session");
  });
});

describe("unified webhook signature headers (#1768)", () => {
  it("accepts each known signature header name, in order", () => {
    expect(WEBHOOK_SIGNATURE_HEADERS).toContain("X-Signature-256");
    expect(WEBHOOK_SIGNATURE_HEADERS).toContain("x-hub-signature-256");
    const headers = new Headers({ "x-hub-signature-256": "sha256=abc" });
    expect(pickWebhookSignature(headers)).toEqual({ value: "sha256=abc", header: "x-hub-signature-256" });
    expect(pickWebhookSignature(new Headers())).toBeNull();
  });

  it("prefers the established NLQ header when several are present", () => {
    const headers = new Headers({
      "X-Signature-256": "sha256=first",
      "x-hub-signature-256": "sha256=second",
    });
    expect(pickWebhookSignature(headers)?.header).toBe("X-Signature-256");
  });
});

describe("WS upgrade burst caps (#1768)", () => {
  beforeEach(() => resetRateLimits());

  it("legacy mode keeps the current uncapped behavior", () => {
    const r = req("https://x.test/api/market-data/quotes/ws", { "cf-connecting-ip": "203.0.113.11" });
    for (let i = 0; i < WS_UPGRADE_BURST.maxRequests + 5; i++) {
      expect(checkWsUpgradeBurst(r, { mode: "legacy" })).toBeNull();
    }
  });

  it("unified mode caps upgrades per IP with a 429", () => {
    const r = req("https://x.test/api/market-data/quotes/ws", { "cf-connecting-ip": "203.0.113.12" });
    for (let i = 0; i < WS_UPGRADE_BURST.maxRequests; i++) {
      expect(checkWsUpgradeBurst(r, { mode: "unified" })).toBeNull();
    }
    const denied = checkWsUpgradeBurst(r, { mode: "unified" });
    expect(denied?.status).toBe(429);
  });

  it("unified mode keys the voice cap on IP + verified login", () => {
    const base = { "cf-connecting-ip": "203.0.113.13" };
    const a = req("https://x.test/voice/trade", base);
    const b = req("https://x.test/voice/trade", base);
    for (let i = 0; i < WS_UPGRADE_BURST.maxRequests; i++) {
      expect(checkWsUpgradeBurst(a, { mode: "unified", verifiedLogin: "alice" })).toBeNull();
    }
    expect(checkWsUpgradeBurst(b, { mode: "unified", verifiedLogin: "bob" })).toBeNull();
  });
});

describe("table-driven WS dispatch (#1768)", () => {
  const deps = {
    requireAuth: async (r: Request) =>
      r.headers.get("x-test-session") === "yes" ? { githubLogin: "alice" } : null,
    acceptVoice: async () => new Response("voice-ok", { status: 101 }),
    fetchTicker: async (r: Request) => new Response(`ticker:${r.headers.get("x-user-login") ?? "none"}`),
  };

  it("lists exactly the live WS upgrade paths with their auth kinds", () => {
    expect(WS_VOICE_PATHS).toEqual(["/voice/trade", "/api/trading/voice/ws"]);
    expect(WS_QUOTE_PATHS).toEqual([
      "/api/market-data/quotes/ws",
      "/api/market/quotes/ws",
      "/api/foss/quotes/ws",
    ]);
  });

  it("returns null for non-upgrade requests so later branches still run", async () => {
    const r = req("https://x.test/api/market-data/quotes/ws");
    expect(await dispatchWsUpgrade(r, {}, deps)).toBeNull();
  });

  it("401s voice upgrades without a session, before accepting", async () => {
    const r = req("https://x.test/voice/trade", { Upgrade: "websocket" });
    const res = await dispatchWsUpgrade(r, {}, deps);
    expect(res?.status).toBe(401);
  });

  it("forwards quotes upgrades with caller identity stripped", async () => {
    const r = req("https://x.test/api/market/quotes/ws", {
      Upgrade: "websocket",
      "x-user-login": "mallory",
      "x-quote-expiry-mode": "honour",
    });
    const res = await dispatchWsUpgrade(r, {}, { ...deps, ingressMode: "legacy" });
    expect(await res?.text()).toBe("ticker:none");
  });
});

describe("JSON-RPC error codes (#1768)", () => {
  it("method-not-found uses -32601 and echoes the id", async () => {
    const res = jsonRpcMethodNotFound(7, undefined);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found: undefined" },
    });
  });

  it("invalid params uses -32602 with a business message", async () => {
    const res = jsonRpcInvalidParams("abc", "Invalid params: 'name' must be a string");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32602, message: "Invalid params: 'name' must be a string" },
    });
  });
});

describe("NLQ webhook ingress schema (#1768)", () => {
  it("accepts a well-shaped body", () => {
    const parsed = nlqWebhookBodySchema.safeParse({
      query: "screen NVDA",
      timestamp: "2026-11-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects wrong-typed fields the old manual checks mapped loosely", () => {
    expect(nlqWebhookBodySchema.safeParse({ query: 42, timestamp: "x" }).success).toBe(false);
    expect(nlqWebhookBodySchema.safeParse({ query: "q", timestamp: 42 }).success).toBe(false);
    expect(nlqWebhookBodySchema.safeParse({ query: "q", timestamp: "x", emailTo: 7 }).success).toBe(false);
    expect(nlqWebhookBodySchema.safeParse(null).success).toBe(false);
    expect(nlqWebhookBodySchema.safeParse("just a string").success).toBe(false);
  });

  it("a non-string userId stays permissible (service-login fallback, unchanged)", () => {
    const parsed = nlqWebhookBodySchema.safeParse({
      query: "q",
      timestamp: "2026-11-01T00:00:00.000Z",
      userId: 42,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("OpenAPI runtime validation (#1768)", () => {
  it("the generated document is structurally valid OpenAPI 3.x", () => {
    expect(validateOpenApiDocument(buildOpenApiSpec())).toEqual([]);
  });

  it("every unified-ingress route is present in the generated spec (zero drift)", () => {
    const spec = buildOpenApiSpec();
    expect(checkIngressRoutesInSpec(spec)).toEqual([]);
    const paths = spec.paths as Record<string, unknown>;
    for (const route of API_INGRESS_ROUTES) {
      expect(Object.prototype.hasOwnProperty.call(paths, route.path)).toBe(true);
    }
  });

  it("the drift checker reports a missing route instead of hiding it", () => {
    const problems = checkIngressRoutesInSpec({ paths: {} }, [
      { method: "POST", path: "/nlq/webhook", auth: "signature" },
    ]);
    expect(problems).toEqual(["/nlq/webhook"]);
  });
});
