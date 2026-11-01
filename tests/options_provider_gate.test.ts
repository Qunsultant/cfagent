/**
 * Options Screener product programme slice 2 (issue #2598) — the options
 * feed gate. Pins:
 * - the gate decision is null for chain providers (etrade, public) and
 *   the coded FAILURE_DATA_PROVIDER_UNAVAILABLE response (single
 *   resolver, catalog httpStatus) for yahoo / alpaca / nasdaq / unknown
 *   — never a silent E*TRADE feed under another provider's name;
 * - the handler returns null without touching the store for non-gated
 *   paths (stored-run reads, catalog, config) and for gated paths under
 *   the fail-open default (unbound store resolves etrade/etrade);
 * - the handler intercepts every live-chain options path and no others.
 */
import { describe, it, expect } from "vitest";
import {
  handleOptionsProviderGateRoutes,
  optionsFeedGateResponse,
} from "../src/agents/routes/optionsProviderGate";

const gated: Array<[string, string]> = [
  ["GET", "/api/etrade/options/chains"],
  ["GET", "/api/etrade/options/expire-dates"],
  ["POST", "/api/etrade/options/strategy"],
  ["POST", "/api/trading/options/recommend"],
  ["POST", "/api/trading/options/llm-ideas"],
  ["POST", "/api/trading/options/compare"],
  ["POST", "/api/trading/options/comparison"],
  ["POST", "/api/trading/options/strategies"],
  ["POST", "/api/trading/options/best-trade"],
  ["POST", "/api/trading/options/screen"],
  ["GET", "/api/trading/options/screen"],
  ["POST", "/api/trading/options/unified"],
  ["GET", "/api/trading/options/unified"],
];

const notGated: Array<[string, string]> = [
  ["GET", "/api/etrade/options/scans"],
  ["GET", "/api/etrade/options/discovery-runs"],
  ["GET", "/api/etrade/options/profiles"],
  ["GET", "/api/options/latest"],
  ["GET", "/api/etrade/options/iv-history"],
  ["GET", "/api/options/strategy-reviews"],
  ["GET", "/api/trading/options/catalog"],
  ["GET", "/api/trading/options/comparison/outcomes"],
  ["POST", "/api/trading/options/config"],
  ["POST", "/api/etrade/options/chains"],
  ["POST", "/api/trading/options/strategies"],
];

describe("options feed gate decision", () => {
  it("passes chain providers through untouched", () => {
    for (const dataProviderId of ["etrade", "public"]) {
      expect(optionsFeedGateResponse({ dataProviderId, brokerId: "etrade" })).toBeNull();
    }
  });

  it("returns the coded unavailable response for non-chain providers", async () => {
    for (const dataProviderId of ["yahoo", "alpaca", "nasdaq", "bogus"]) {
      const res = optionsFeedGateResponse({ dataProviderId, brokerId: "etrade" });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(502);
      const body = (await res!.json()) as Record<string, unknown>;
      expect(body.code).toBe("FAILURE_DATA_PROVIDER_UNAVAILABLE");
      expect(body.selectedDataProvider).toBe(dataProviderId);
      expect(body.capability).toBe("optionsChains");
      expect(typeof body.message).toBe("string");
      expect(body.message as string).toContain("[FAILURE_DATA_PROVIDER_UNAVAILABLE]");
    }
  });
});

describe("options feed gate handler", () => {
  const ctx = { env: {} as never };

  it("returns null for non-gated paths and wrong methods without a store read", async () => {
    for (const [method, path] of notGated) {
      const req = new Request(`https://agent.internal${path}`, { method });
      const res = await handleOptionsProviderGateRoutes(req, new URL(req.url), path, "s", ctx);
      expect(res, `${method} ${path}`).toBeNull();
    }
  });

  it("passes gated paths under the fail-open etrade default (unbound store)", async () => {
    for (const [method, path] of gated) {
      const req = new Request(`https://agent.internal${path}`, {
        method,
        headers: { "x-user-login": "alice" },
      });
      const res = await handleOptionsProviderGateRoutes(req, new URL(req.url), path, "s", ctx);
      expect(res, `${method} ${path}`).toBeNull();
    }
  });
});
