import { describe, it, expect } from "vitest";
import {
  InMemoryTenantCredentialStore,
  KvTenantCredentialStore,
  migrateLegacyEnvCredentialsToTenant,
  resolveTenantCredentials,
  tenantCredentialKey,
} from "../src/services/tenantCredentialStore";

describe("Per-tenant provider & broker credential store (#4614)", () => {
  it("isolates credentials strictly per tenantId and rejects empty tenantId", async () => {
    const store = new InMemoryTenantCredentialStore();

    await store.setCredential("tenant-alpha", "broker", "alpaca", {
      apiKey: "alpha-key",
      apiSecret: "alpha-secret",
      environment: "paper",
    });
    await store.setCredential("tenant-beta", "broker", "alpaca", {
      apiKey: "beta-key",
      apiSecret: "beta-secret",
      environment: "live",
    });

    const alpha = await store.getCredential("tenant-alpha", "broker", "alpaca");
    const beta = await store.getCredential("tenant-beta", "broker", "alpaca");
    const gamma = await store.getCredential("tenant-gamma", "broker", "alpaca");

    expect(alpha?.apiKey).toBe("alpha-key");
    expect(alpha?.provenanceProviderId).toBe("alpaca");
    expect(beta?.apiKey).toBe("beta-key");
    expect(beta?.environment).toBe("live");
    expect(gamma).toBeNull();

    expect(tenantCredentialKey("tenant-alpha", "broker", "alpaca")).not.toBe(
      tenantCredentialKey("tenant-beta", "broker", "alpaca"),
    );

    await expect(
      store.getCredential("", "broker", "alpaca"),
    ).rejects.toThrow(/non-empty tenantId/);
  });

  it("migrates legacy env-level broker/provider credentials and E*TRADE login tokens into a tenant-scoped record", async () => {
    const backing = new Map<string, string>();
    const kvStore = new KvTenantCredentialStore({
      get: async (k) => backing.get(k) ?? null,
      put: async (k, v) => {
        backing.set(k, v);
      },
      delete: async (k) => backing.delete(k),
    });

    const migration = await migrateLegacyEnvCredentialsToTenant(
      kvStore,
      "tenant-acme",
      {
        ALPACA_API_KEY: "alp-env-key",
        ALPACA_API_SECRET_KEY: "alp-env-sec",
        ETRADE_CONSUMER_KEY: "et-key",
        ETRADE_CONSUMER_SECRET: "et-sec",
        FMP_API_KEY: "fmp-key",
      },
      [
        {
          kind: "broker",
          id: "alpaca",
          apiKeyEnvVars: ["ALPACA_API_KEY", "ALPACA_API_KEY_ID"],
          apiSecretEnvVars: ["ALPACA_API_SECRET_KEY"],
          defaultEnvironment: "paper",
        },
        {
          kind: "provider",
          id: "alpaca",
          apiKeyEnvVars: ["ALPACA_API_KEY", "ALPACA_API_KEY_ID"],
          apiSecretEnvVars: ["ALPACA_API_SECRET_KEY"],
        },
        {
          kind: "broker",
          id: "etrade",
          apiKeyEnvVars: ["ETRADE_CONSUMER_KEY"],
          apiSecretEnvVars: ["ETRADE_CONSUMER_SECRET"],
        },
        {
          kind: "provider",
          id: "fmp",
          apiKeyEnvVars: ["FMP_API_KEY"],
        },
      ],
      [
        {
          kind: "broker",
          id: "etrade",
          oauthToken: "tok-1",
          oauthTokenSecret: "sec-1",
          environment: "sandbox",
          login: "alice",
        },
      ],
    );

    expect(migration.migratedKeys).toEqual([
      "broker:alpaca",
      "provider:alpaca",
      "broker:etrade",
      "provider:fmp",
    ]);

    const acmeEtrade = await resolveTenantCredentials({}, "broker", "etrade", {
      store: kvStore,
      tenantId: "tenant-acme",
    });
    expect(acmeEtrade?.oauthToken).toBe("tok-1");
    expect(acmeEtrade?.provenanceProviderId).toBe("etrade");
    expect(acmeEtrade?.migratedFrom).toBe("login:alice");

    // Another tenant never sees tenant-acme's migrated credentials
    const otherTenant = await resolveTenantCredentials({}, "broker", "etrade", {
      store: kvStore,
      tenantId: "tenant-other",
    });
    expect(otherTenant).toBeNull();
  });
});
