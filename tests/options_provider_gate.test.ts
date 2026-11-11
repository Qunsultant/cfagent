/**
 * Options Screener product programme slice 2 (issue #2598) — the options
 * feed gate. Pins:
 * - the gate decision is null for chain providers (etrade, public,
 *   alpaca — alpaca joined in #3990 via the repo's own Alpaca options
 *   read path) and for non-chain selections, which are served through
 *   a capable provider with the substitution named in the run record
 *   (#4014) — never a silent feed under another provider's name;
 *   the coded FAILURE_DATA_PROVIDER_UNAVAILABLE resolver itself is
 *   pinned in tests/data_provider_capabilities_3990.test.ts;
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
    for (const dataProviderId of ["etrade", "public", "alpaca"]) {
      expect(optionsFeedGateResponse({ dataProviderId, brokerId: "etrade" })).toBeNull();
    }
  });

  it("serves non-chain selections through a capable provider (#4014)", () => {
    // yahoo/nasdaq declare no optionsChains (alpaca declares it since #3990),
    // but a chain is still served by the capable provider and the run record
    // names both (see tests/options_chain_serving_4014.test.ts). Refusing
    // instead left the options screens with no chain at all.
    for (const dataProviderId of ["yahoo", "nasdaq", "bogus"]) {
      expect(optionsFeedGateResponse({ dataProviderId, brokerId: "etrade" })).toBeNull();
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
