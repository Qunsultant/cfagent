/**
 * Issue #4602 — Mark login-as-tenant ids so they cannot collide with real tenant ids
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LOGIN_TENANT_PREFIX,
  toLoginTenantId,
  isLoginTenantId,
  resolveEffectiveTenantId,
} from "../src/services/platformIdentity";
import {
  handlePlatformTenantRoutes,
  type PlatformTenantRouteContext,
} from "../src/agents/routes/platformTenants";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";

describe("Issue #4602 — login-as-tenant namespace marker", () => {
  it("prefixes personal login-as-tenant ids with 'login:' without double-prefixing", () => {
    expect(LOGIN_TENANT_PREFIX).toBe("login:");
    expect(toLoginTenantId("alice")).toBe("login:alice");
    expect(toLoginTenantId("login:alice")).toBe("login:alice");
    expect(isLoginTenantId("login:alice")).toBe(true);
    expect(isLoginTenantId("acme")).toBe(false);
    expect(isLoginTenantId(null)).toBe(false);

    expect(resolveEffectiveTenantId(null, "alice")).toBe("login:alice");
    expect(resolveEffectiveTenantId("acme", "alice")).toBe("acme");
  });

  it("rejects real tenant creation using the reserved 'login:' prefix so a login string can never collide with a real tenant", async () => {
    const commercial = new InMemoryCommercialAdapter();
    const directory = new InMemoryTenantDirectoryAdapter();
    const ctx: PlatformTenantRouteContext = {
      env: { COMMERCIAL_STORE_OPERATORS: "op1" } as unknown as { AGENT_DB?: unknown },
      commercial,
      directory,
      operators: { listOperators: async () => [] },
    };

    const rejected = await handlePlatformTenantRoutes(
      new Request("https://worker.test/platform-tenants", {
        method: "POST",
        headers: { "x-user-login": "op1", "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "login:alice" }),
      }),
      new URL("https://worker.test/platform-tenants"),
      "/platform-tenants",
      "s-1",
      ctx,
    );
    expect(rejected?.status).toBe(400);
    const body = (await rejected?.json()) as { error: string };
    expect(body.error).toContain("login:");
  });

  it("documents the marker and legacy row migration note in docs/architecture/business/platform-entity-capability-map.md §7.10", () => {
    const doc = readFileSync(
      new URL("../docs/architecture/business/platform-entity-capability-map.md", import.meta.url),
      "utf-8",
    );
    expect(doc).toContain("LOGIN_TENANT_PREFIX");
    expect(doc).toContain("Migration note:");
  });
});
