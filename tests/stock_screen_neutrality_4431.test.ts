/**
 * Issue #4431 (S5/N3, under #3739) — structural neutrality, manual path.
 *
 * Pins the new manual-path contract:
 *  1. the hub run body carries providerId (+ brokerId) and the server
 *     validates them against the tenant-resolved values, refusing a
 *     mismatch loud and coded;
 *  2. the planner requires a provider (no etrade default);
 *  3. the spec builder never hardcodes a provider per route;
 *  4. the broker gate refuses unconfigured tenants with 409
 *     NO_BROKER_CONFIGURED (the gate half lives in
 *     tests/gates_fail_closed_3460.test.ts);
 *  5. provenance is `?? "unknown"`, never a guessed provider;
 *  6. the stale "Absent row = etrade" comments name the alpaca code
 *     default (a comment-only pin — the code fact lives in
 *     DEFAULT_TENANT_PROVIDERS);
 *  7. a fell-back run is surfaced on the hub (providerFellBackNotice).
 *
 * The planner refusal and spec-builder pins live with their own
 * suites (tests/stock_screen_planner_2864.test.ts,
 * tests/stock_screen_planner_scheduled_2865.test.ts,
 * tests/stock_screen_run_spec_2809.test.ts); this file pins the
 * claim/validation seam and the client surface.
 */
import { describe, expect, it } from "vitest";
import { buildStockRunRequestBody, providerFellBackNotice } from "../src/client/StockHub";
import { variantIdToTenantProviderId } from "../src/client/screeningAdapters";
import type { TenantProvidersState } from "../src/client/tenantProviders";
import {
  brokerMismatchResponse,
  noBrokerConfiguredResponse,
  resolveManualScreenProviders,
  resolveScreenProviderForRun,
} from "../src/services/tenantProviders";
import { parseStockScreenRequest } from "../src/trading/screeningSchemas";
import { isStockScreenProvider } from "../src/trading/screenerPipeline";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";

function state(overrides: Partial<TenantProvidersState> = {}): TenantProvidersState {
  return {
    dataProviderId: "alpaca",
    brokerId: "alpaca",
    ...overrides,
  };
}

describe("manual run body claims (#4431 item 1)", () => {
  it("carries providerId + brokerId when the caller knows them", () => {
    const body = buildStockRunRequestBody(
      { sector: "Technology" },
      { pushToSlack: false, slackChannel: "", emailTo: "", webhookUrl: "", generatePdf: false },
      { providerId: "yahoo", brokerId: "alpaca" },
    );
    expect(body.providerId).toBe("yahoo");
    expect(body.brokerId).toBe("alpaca");
    expect(body.sector).toBe("Technology");
  });

  it("omits absent claims instead of sending empty strings", () => {
    const body = buildStockRunRequestBody(
      {},
      { pushToSlack: false, slackChannel: "", emailTo: "", webhookUrl: "", generatePdf: false },
    );
    expect(body).not.toHaveProperty("providerId");
    expect(body).not.toHaveProperty("brokerId");
  });

  it("the server splits the claims out of the engine filters", () => {
    const result = parseStockScreenRequest({
      sector: "Technology",
      providerId: "yahoo",
      brokerId: "alpaca",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providerId).toBe("yahoo");
    expect(result.value.brokerId).toBe("alpaca");
    expect(result.value.filters).not.toHaveProperty("providerId");
    expect(result.value.filters).not.toHaveProperty("brokerId");
  });

  it("the variant id maps to the registry id, never a guessed provider", () => {
    expect(variantIdToTenantProviderId("etrade")).toBe("etrade");
    expect(variantIdToTenantProviderId("yahoo-finance")).toBe("yahoo");
    expect(variantIdToTenantProviderId("bogus-variant")).toBeUndefined();
  });
});

describe("manual claim validation (#4431 item 1)", () => {
  it("accepts claims matching the tenant-resolved values (unconfigured env resolves to the alpaca default)", async () => {
    const resolved = await resolveManualScreenProviders(
      {},
      { providerId: "alpaca", brokerId: "alpaca" },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.provider).toBe("alpaca");
    expect(resolved.providers.dataProviderId).toBe("alpaca");
    expect(resolved.providers.brokerId).toBe("alpaca");
  });

  it("accepts absent claims — the run uses the tenant-resolved provider", async () => {
    const resolved = await resolveManualScreenProviders({}, {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.provider).toBe("alpaca");
  });

  it("refuses a provider mismatch with 409 FAILURE_PROVIDER_MISMATCH", async () => {
    const resolved = await resolveManualScreenProviders({}, { providerId: "etrade" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.response.status).toBe(409);
    const body = await resolved.response.json();
    expect(body.code).toBe("FAILURE_PROVIDER_MISMATCH");
    expect(body.requestedProvider).toBe("etrade");
    expect(body.selectedProvider).toBe("alpaca");
  });

  it("refuses a broker mismatch with 409 FAILURE_BROKER_MISMATCH", async () => {
    const resolved = await resolveManualScreenProviders({}, { brokerId: "etrade" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.response.status).toBe(409);
    const body = await resolved.response.json();
    expect(body.code).toBe("FAILURE_BROKER_MISMATCH");
    expect(body.requestedBroker).toBe("etrade");
    expect(body.selectedBroker).toBe("alpaca");
  });

  it("resolves the engine provider for a provider-less entry (alpaca default env)", async () => {
    expect(await resolveScreenProviderForRun({})).toBe("alpaca");
  });

  it("isStockScreenProvider admits the four screen providers and nothing else", () => {
    for (const provider of ["etrade", "yahoo", "alpaca", "public"]) {
      expect(isStockScreenProvider(provider)).toBe(true);
    }
    for (const provider of ["nasdaq", "bogus", "", undefined, null]) {
      expect(isStockScreenProvider(provider)).toBe(false);
    }
  });
});

describe("gate refusal responses (#4431 item 4)", () => {
  it("noBrokerConfiguredResponse is a 409 with the issue-literal code", async () => {
    const response = noBrokerConfiguredResponse();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("NO_BROKER_CONFIGURED");
    expect(body.error).toContain("No broker is configured");
  });

  it("brokerMismatchResponse is a 409 naming both brokers", async () => {
    const response = brokerMismatchResponse("etrade", "alpaca");
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("FAILURE_BROKER_MISMATCH");
    expect(body.requestedBroker).toBe("etrade");
    expect(body.selectedBroker).toBe("alpaca");
  });
});

describe("fell-back runs are surfaced (#4431 item 7)", () => {
  it("is silent when nothing fell back", () => {
    expect(providerFellBackNotice(state())).toBeNull();
  });

  it("names the defaulted axis and the default it runs on", () => {
    expect(providerFellBackNotice(state({ dataProviderFellBack: true }))).toContain(
      "data provider (alpaca)",
    );
    expect(providerFellBackNotice(state({ brokerFellBack: true }))).toContain("broker (alpaca)");
    const both = providerFellBackNotice(
      state({ dataProviderFellBack: true, brokerFellBack: true }),
    );
    expect(both).toContain("data provider (alpaca) and broker (alpaca)");
    expect(both).toContain("Choose a provider in Settings");
  });
});

describe("stale-comment code fact (#4431 item 6)", () => {
  it("the code default for an absent row is alpaca/alpaca", () => {
    expect(DEFAULT_TENANT_PROVIDERS).toEqual({ dataProviderId: "alpaca", brokerId: "alpaca" });
  });
});
