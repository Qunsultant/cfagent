/**
 * Issue #4603 — Decide: does tenant creation stay a settings-row write?
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  TENANT_CREATION_MODE,
  handlePlatformTenantRoutes,
  type PlatformTenantRouteContext,
} from "../src/agents/routes/platformTenants";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";

describe("Issue #4603 — tenant creation stays a settings-row write by design", () => {
  it("exports TENANT_CREATION_MODE = 'settings_row_only' and surfaces creationMode on POST /platform-tenants", async () => {
    expect(TENANT_CREATION_MODE).toBe("settings_row_only");

    const commercial = new InMemoryCommercialAdapter();
    const directory = new InMemoryTenantDirectoryAdapter();
    directory.seedTenant("tenant-existing", []);
    const ctx: PlatformTenantRouteContext = {
      env: { COMMERCIAL_STORE_OPERATORS: "op1" } as unknown as { AGENT_DB?: unknown },
      commercial,
      directory,
      operators: { listOperators: async () => [] },
    };

    const res = await handlePlatformTenantRoutes(
      new Request("https://worker.test/platform-tenants", {
        method: "POST",
        headers: { "x-user-login": "op1", "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "tenant-settings-only" }),
      }),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "s-1",
      ctx,
    );
    expect(res?.status).toBe(201);
    const body = (await res?.json()) as {
      tenant: { tenantId: string; adsEnabled: boolean };
      creationMode: string;
    };
    expect(body.tenant.tenantId).toBe("tenant-settings-only");
    expect(body.creationMode).toBe("settings_row_only");
    expect(await commercial.getTenantAdsEnabled("tenant-settings-only")).toBe(true);

    const replay = await handlePlatformTenantRoutes(
      new Request("https://worker.test/platform-tenants", {
        method: "POST",
        headers: { "x-user-login": "op1", "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "tenant-existing" }),
      }),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "s-1",
      ctx,
    );
    expect(replay?.status).toBe(200);
    const replayBody = (await replay?.json()) as {
      tenant: { tenantId: string };
      creationMode: string;
    };
    expect(replayBody.tenant.tenantId).toBe("tenant-existing");
    expect(replayBody.creationMode).toBe("settings_row_only");
  });

  it("pins the settings-row-only decision in docs/architecture/business/platform-entity-capability-map.md §7.11", () => {
    const doc = readFileSync(
      new URL("../docs/architecture/business/platform-entity-capability-map.md", import.meta.url),
      "utf-8",
    );
    expect(doc).toContain("Tenant create writes only a settings row (#4603 — decided: stands by design)");
    expect(doc).toContain('TENANT_CREATION_MODE = "settings_row_only"');
  });
});
