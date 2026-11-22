import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handlePlatformTenantRoutes } from "../src/agents/routes/platformTenants";
import { handlePlatformUsersRoutes } from "../src/agents/routes/platformUsers";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryAuditPolicyAdapter } from "../src/data/inMemoryAuditPolicyAdapter";
import { createMemoryMembershipStore, type Membership } from "../src/security/authorization";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";
import type { Env } from "../src/types";

function makeAliasKv(map: Record<string, string>): KvLike {
  const store = new Map<string, string>(
    Object.entries(map).map(([k, v]) => [
      `${IAAA_ALIAS_KEY_PREFIX}login:${k}`,
      JSON.stringify({ githubLogin: k, internalUserId: v, recordedAtMs: 1 }),
    ]),
  );
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

describe("Issue #4605 — admin read audit & tenant-admin audit funnel", () => {
  it("routeRequest.ts supplies the orchestrator audit funnel to handlePlatformTenantRoutes", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "agents", "orchestrator", "routeRequest.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /handlePlatformTenantRoutes\([\s\S]*?audit:\s*\(type,\s*agent,\s*payload\)\s*=>\s*deps\.audit\(type,\s*agent,\s*payload\)/,
    );
  });

  it("tenant-admin create + update-settings emit both ctx.audit and a tenant-scoped Q7 chain entry", async () => {
    const commercial = new InMemoryCommercialAdapter();
    const knownTenants = new Set<string>();
    const directory = {
      listTenantIds: async () => {
        for (const s of [/* tracked below */] as string[]) knownTenants.add(s);
        return [...knownTenants];
      },
      listTenantMembers: async () => [],
    };
    const origSetAds = commercial.setTenantAdsEnabled.bind(commercial);
    commercial.setTenantAdsEnabled = async (tenantId: string, enabled: boolean) => {
      knownTenants.add(tenantId);
      return origSetAds(tenantId, enabled);
    };
    const auditPolicy = new InMemoryAuditPolicyAdapter();
    const audit = vi.fn();

    const createRes = await handlePlatformTenantRoutes(
      new Request("https://agent.test/api/platform-tenants", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "op1" },
        body: JSON.stringify({ tenantId: "acme" }),
      }),
      new URL("https://agent.test/api/platform-tenants"),
      "/api/platform-tenants",
      "s1",
      {
        env: {},
        audit,
        auditPolicy,
        commercial,
        directory,
        operators: { listOperators: async () => [{ login: "op1", addedAtMs: 1, addedBy: "seed" }] },
      },
    );
    expect(createRes?.status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));

    const patchRes = await handlePlatformTenantRoutes(
      new Request("https://agent.test/api/platform-tenants/acme/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-user-login": "op1" },
        body: JSON.stringify({ adsEnabled: false }),
      }),
      new URL("https://agent.test/api/platform-tenants/acme/settings"),
      "/api/platform-tenants/acme/settings",
      "s1",
      {
        env: {},
        audit,
        auditPolicy,
        commercial,
        directory,
        operators: { listOperators: async () => [{ login: "op1", addedAtMs: 1, addedBy: "seed" }] },
      },
    );
    expect(patchRes?.status).toBe(200);

    // The Q7 chain append is fire-and-forget (two async SHA-256
    // hashes); poll until both entries land instead of a fixed
    // 10ms wait that elapses under parallel load. (#5164: the
    // fixed wait failed 4 of 5 full 40-file runs on this branch
    // — both tests in this file, alternating — and 0 of 5 on
    // pristine main; the assertions below are unchanged.)
    for (let i = 0; i < 200; i++) {
      if ((await auditPolicy.listChainEntries("acme")).length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(audit).toHaveBeenCalledWith("platform-tenant-admin", "orchestrator", {
      actorLogin: "op1",
      action: "create",
      tenantId: "acme",
    });
    expect(audit).toHaveBeenCalledWith("platform-tenant-admin", "orchestrator", {
      actorLogin: "op1",
      action: "update-settings",
      tenantId: "acme",
    });

    const chain = await auditPolicy.listChainEntries("acme");
    expect(chain.map((e) => e.action)).toEqual([
      "platform.tenant_admin.create",
      "platform.tenant_admin.update-settings",
    ]);
  });

  it("user-admin lookup emits ctx.audit + tenant-scoped Q7 chain entry, while self-view me emits nothing", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "target-1", tenantId: "acme", tier: "Free" });
    const subscriptions = new InMemorySubscriptionAdapter();
    const auditPolicy = new InMemoryAuditPolicyAdapter();
    const audit = vi.fn();
    const adminMembership: Membership = {
      membershipId: "m-admin",
      internalUserId: "uid-admin",
      tenantId: "acme",
      roleBindings: [{ role: "platform-admin", scope: "platform" }],
      createdAtMs: 1,
    };
    const membershipStore = createMemoryMembershipStore();
    await membershipStore.put(adminMembership);
    const aliasKv = makeAliasKv({ "admin-1": "uid-admin", "target-1": "uid-target" });

    const meRes = await handlePlatformUsersRoutes(
      new Request("https://agent.test/api/admin/platform-users/me", {
        headers: { "x-user-login": "target-1" },
      }),
      new URL("https://agent.test/api/admin/platform-users/me"),
      "/api/admin/platform-users/me",
      "s1",
      { env: {} as Env, audit, auditPolicy, commercial, subscriptions, membershipStore, aliasKv },
    );
    expect(meRes?.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();

    const lookupRes = await handlePlatformUsersRoutes(
      new Request("https://agent.test/api/admin/platform-users/lookup?login=target-1", {
        headers: { "x-user-login": "admin-1" },
      }),
      new URL("https://agent.test/api/admin/platform-users/lookup?login=target-1"),
      "/api/admin/platform-users/lookup",
      "s1",
      { env: {} as Env, audit, auditPolicy, commercial, subscriptions, membershipStore, aliasKv },
    );
    expect(lookupRes?.status).toBe(200);

    // The Q7 chain append is fire-and-forget (two async SHA-256
    // hashes); poll until the entry lands instead of a fixed 10ms
    // wait that elapses under parallel load. (#5164: see the
    // companion wait above — same race, same fix; the assertion
    // below is unchanged.)
    for (let i = 0; i < 200; i++) {
      if ((await auditPolicy.listChainEntries("acme")).length >= 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(audit).toHaveBeenCalledWith("platform.user_admin.lookup", "orchestrator", {
      actorLogin: "admin-1",
      targetLogin: "target-1",
      tenantId: "acme",
      hasAccount: true,
    });
    const chain = await auditPolicy.listChainEntries("acme");
    expect(chain.map((e) => e.action)).toEqual(["platform.user_admin.lookup"]);
  });

  it("capability map records the #4605 user-admin read audit decision and tenant-admin funnel", () => {
    const doc = readFileSync(
      join(process.cwd(), "docs", "architecture", "business", "platform-entity-capability-map.md"),
      "utf8",
    );
    expect(doc).toContain("platform.user_admin.lookup");
    expect(doc).toContain("GET /api/admin/platform-users/me");
    expect(doc).toContain("platform.tenant_admin.*");
  });
});
