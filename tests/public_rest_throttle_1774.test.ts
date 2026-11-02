/**
 * #1774 (parent #1717, F-55) — public REST rate limiting, Red pins.
 *
 * Extends the existing API_INGRESS_MODE switch (#1768 precedent):
 * legacy keeps the current uncapped public-REST behavior; unified
 * caps unauthenticated-agnostic /api/* traffic per connecting IP.
 * Non-/api/* paths are never throttled by this guard, and the
 * bucket key is the IP, never caller-supplied identity.
 */
import { describe, expect, it } from "vitest";
import {
  checkPublicRestThrottle,
  PUBLIC_REST_BURST,
} from "../src/api/ingress";
import { resetRateLimits } from "../src/security/rateLimiter";

function apiRequest(ip: string): Request {
  return new Request("https://agent.internal/api/premium/status", {
    headers: { "cf-connecting-ip": ip },
  });
}

describe("public REST throttle (1774)", () => {
  it("is inert in legacy mode no matter the volume", () => {
    resetRateLimits();
    const req = apiRequest("203.0.113.101");
    for (let i = 0; i < PUBLIC_REST_BURST.maxRequests + 50; i++) {
      expect(checkPublicRestThrottle(req, { mode: "legacy" })).toBeNull();
    }
  });

  it("allows the burst then returns 429 with Retry-After in unified mode", () => {
    resetRateLimits();
    const req = apiRequest("203.0.113.102");
    for (let i = 0; i < PUBLIC_REST_BURST.maxRequests; i++) {
      expect(checkPublicRestThrottle(req, { mode: "unified" })).toBeNull();
    }
    const limited = checkPublicRestThrottle(req, { mode: "unified" });
    expect(limited).not.toBeNull();
    expect(limited!.status).toBe(429);
    expect(limited!.headers.get("Retry-After")).toBeTruthy();
  });

  it("keys buckets per IP: one flooded IP does not throttle another", () => {
    resetRateLimits();
    const flooded = apiRequest("203.0.113.103");
    const other = apiRequest("203.0.113.104");
    for (let i = 0; i < PUBLIC_REST_BURST.maxRequests + 5; i++) {
      checkPublicRestThrottle(flooded, { mode: "unified" });
    }
    expect(checkPublicRestThrottle(flooded, { mode: "unified" })).not.toBeNull();
    expect(checkPublicRestThrottle(other, { mode: "unified" })).toBeNull();
  });

  it("never throttles non-/api/* paths in unified mode", () => {
    resetRateLimits();
    const req = new Request("https://agent.internal/slack/events", {
      headers: { "cf-connecting-ip": "203.0.113.105" },
    });
    for (let i = 0; i < PUBLIC_REST_BURST.maxRequests + 50; i++) {
      expect(checkPublicRestThrottle(req, { mode: "unified" })).toBeNull();
    }
  });

  it("exposes a generous burst constant (not a tight per-user cap)", () => {
    expect(PUBLIC_REST_BURST.maxRequests).toBeGreaterThanOrEqual(120);
    expect(PUBLIC_REST_BURST.windowMs).toBe(60_000);
  });
});
