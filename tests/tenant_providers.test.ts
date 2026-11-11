/**
 * Provider / broker agnosticism, slice 1: tenant selections.
 *
 * Pins: defaults are the Alpaca data provider / Alpaca broker (#3990;
 * was the etrade data provider / Alpaca broker, #3812); invalid ids
 * are rejected, never stored; a non-etrade broker gets the coded
 * unavailable response, never an E*TRADE error; the unified strategy
 * run record stamps provider/broker into provenance.
 */
import { describe, expect, it } from "vitest";
import {
  brokerUnavailableResponse,
  isBrokerId,
  isDataProviderId,
  normalizeTenantProviders,
  resolveTenantBroker,
} from "../src/services/tenantProviders";
import { ALL_MIGRATIONS, MIGRATION_0028_TENANT_PROVIDERS } from "../src/data/migrationRunner";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveOutcome, codedMessage } from "../src/outcomes/outcomeAspects";
import { recordStrategyScreenRun } from "../src/services/optionsServeRecord";

describe("tenant provider selection ids", () => {
  it("accepts every registered data provider id and all three broker ids", () => {
    for (const id of ["etrade", "public", "yahoo", "nasdaq", "alpaca"]) expect(isDataProviderId(id)).toBe(true);
    expect(isBrokerId("etrade")).toBe(true);
    expect(isBrokerId("alpaca")).toBe(true);
    // Issue #3990: Public.com is a broker now (it was data-only) —
    // a broker MAY also be a data source, registered with its
    // declared capabilities.
    expect(isBrokerId("public")).toBe(true);
  });

  it("rejects unknown ids and pure data providers are not brokers by accident", () => {
    expect(isDataProviderId("schwab")).toBe(false);
    expect(isBrokerId("schwab")).toBe(false);
    expect(isBrokerId("yahoo")).toBe(false);
    expect(isBrokerId("nasdaq")).toBe(false);
    expect(normalizeTenantProviders({ dataProviderId: "etrade", brokerId: "schwab" })).toBeNull();
    expect(normalizeTenantProviders({ dataProviderId: "schwab", brokerId: "etrade" })).toBeNull();
    expect(normalizeTenantProviders({ dataProviderId: "etrade" })).toBeNull();
  });

  it("normalizes a valid pair unchanged", () => {
    expect(normalizeTenantProviders({ dataProviderId: "yahoo", brokerId: "alpaca" })).toEqual({
      dataProviderId: "yahoo",
      brokerId: "alpaca",
    });
  });
});

describe("migration 0027", () => {
  it("is registered after migration 0026 with etrade defaults", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0028_TENANT_PROVIDERS);
    expect(MIGRATION_0028_TENANT_PROVIDERS.version).toBe(28);
    expect(MIGRATION_0028_TENANT_PROVIDERS.sql).toContain("data_provider_id");
    expect(MIGRATION_0028_TENANT_PROVIDERS.sql).toContain("broker_id");
    expect(MIGRATION_0028_TENANT_PROVIDERS.sql).toContain("DEFAULT 'etrade'");
  });
});

describe("in-memory tenant providers store", () => {
  it("defaults to alpaca data provider / alpaca broker for an absent row", async () => {
    const store = new InMemoryCommercialAdapter();
    await expect(store.getTenantProviders("tenant-1")).resolves.toEqual({
      dataProviderId: "alpaca",
      brokerId: "alpaca",
    });
  });

  it("stores a selection and preserves auto-refresh fields", async () => {
    const store = new InMemoryCommercialAdapter();
    await store.setTenantAutoRefresh("tenant-1", { enabled: true, intervalS: 30 });
    const record = await store.setTenantProviders("tenant-1", { dataProviderId: "nasdaq", brokerId: "alpaca" });
    expect(record.dataProviderId).toBe("nasdaq");
    expect(record.brokerId).toBe("alpaca");
    expect(record.autoRefreshEnabled).toBe(true);
    expect(record.autoRefreshIntervalS).toBe(30);
    await expect(store.getTenantProviders("tenant-1")).resolves.toEqual({
      dataProviderId: "nasdaq",
      brokerId: "alpaca",
    });
  });
});

describe("broker unavailable code", () => {
  it("resolves to the single catalog entry with http 409 and no upstream text", () => {
    const resolved = resolveOutcome("FAILURE_BROKER_UNAVAILABLE");
    expect(resolved.entry?.httpStatus).toBe(409);
    expect(resolved.entry?.retryable).toBe(false);
    expect(codedMessage("FAILURE_BROKER_UNAVAILABLE")).toContain("Change the broker selection in Settings.");
  });

  it("brokerUnavailableResponse carries the code and the selected broker, never an E*TRADE error", async () => {
    const res = brokerUnavailableResponse("alpaca");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("FAILURE_BROKER_UNAVAILABLE");
    expect(body.selectedBroker).toBe("alpaca");
    expect(String(body.message)).not.toContain("oauth_problem");
    expect(String(body.message)).not.toContain("E*TRADE");
  });
});

describe("resolveTenantBroker fail-open", () => {
  it("defaults to the platform default broker (alpaca) when the store is absent", async () => {
    // Issue #3937 (user decision 2026-11-10): the GLOBAL default is
    // alpaca/paper — the legacy etrade fallback is gone, so every surface
    // (neutral routes, legacy E*TRADE surfaces, email/Slack/voice, options
    // routes, copilot resolver, panels) resolves the same broker.
    await expect(resolveTenantBroker({} as never)).resolves.toBe("alpaca");
  });
});

describe("unified run record provenance stamping", () => {
  it("stamps dataProviderId / brokerId into provenance, defaulting to etrade data / alpaca broker", () => {
    const bodies: Array<Record<string, unknown>> = [];
    const orm = {
      storeCanonicalReport: (input: Record<string, unknown>) => {
        bodies.push(input);
        return { reportId: "r1", created: true };
      },
    } as never;
    recordStrategyScreenRun(orm, {
      userLogin: "u1",
      symbol: "TSLA",
      trigger: "manual",
      mode: "strategies",
      ranked: [],
      dataProviderId: "yahoo",
      brokerId: "alpaca",
    });
    const provenance = (bodies[0].body as Record<string, unknown>).provenance as Record<string, unknown>;
    expect(provenance.dataProviderId).toBe("yahoo");
    expect(provenance.brokerId).toBe("alpaca");

    bodies.length = 0;
    recordStrategyScreenRun(orm, {
      userLogin: "u1",
      symbol: "TSLA",
      trigger: "manual",
      mode: "strategies",
      ranked: [],
    });
    const legacy = (bodies[0].body as Record<string, unknown>).provenance as Record<string, unknown>;
    expect(legacy.dataProviderId).toBe("etrade");
    expect(legacy.brokerId).toBe("alpaca");
  });
});
