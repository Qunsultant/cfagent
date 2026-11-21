/**
 * Issue #4515 (BizCopilot slice 1) — the deterministic tenant
 * branch: intent parsing + in-process execution through the Tenants
 * page's own routes.
 *
 * The fakes below are the route handler's own test seams
 * (commercial / directory / operators) over one shared in-memory
 * world, so the executor is exercised through the real handler —
 * gate, idempotent create, settings merge, and 404/403 outcomes
 * included — not through a stub of it.
 */
import { describe, it, expect } from "vitest";
import {
  BIZCOPILOT_TENANTS_PAGE_URL,
  executeBizCopilotTenantIntent,
  parseBizCopilotTenantIntent,
  runBizCopilotTenantBranch,
  type BizCopilotTenantIntent,
} from "../src/services/bizCopilotTenants";
import type { CommercialStore, TenantSettingsRecord, CommercialAccountRecord } from "../src/data/commercialPorts";
import type { TenantDirectory } from "../src/data/tenantDirectoryPorts";
import type { StoreOperators, StoreOperatorEntry } from "../src/data/storeOperatorsPorts";

const OPERATOR = "op@example.com";
const NON_OPERATOR = "mallory@example.com";

function settingsRow(tenantId: string, overrides: Partial<TenantSettingsRecord> = {}): TenantSettingsRecord {
  return {
    tenantId,
    adsEnabled: true,
    updatedAtMs: 0,
    autoRefreshEnabled: false,
    autoRefreshIntervalS: 15,
    dataProviderId: "etrade",
    brokerId: "etrade",
    // Issue #5423: per-step timeout, null = unconfigured (same as the adapters' fresh row).
    turnStepTimeoutMs: null,
    ...overrides,
  };
}

function accountRow(userId: string, tenantId: string): CommercialAccountRecord {
  return {
    id: userId,
    tenantId,
    tier: "Free",
    creditsUSD: 0,
    includedRuns: 0,
    updatedAtMs: 0,
  };
}

/** One shared world backing the store + directory fakes (the real union: settings rows + account rows). */
function makeWorld() {
  const settings = new Map<string, TenantSettingsRecord>();
  const accounts = new Map<string, CommercialAccountRecord>();
  const commercial = {
    getAccount: async (userId: string) => accounts.get(userId) ?? null,
    getTenantAdsEnabled: async (tenantId: string) =>
      settings.get(tenantId)?.adsEnabled ?? true,
    setTenantAdsEnabled: async (tenantId: string, adsEnabled: boolean) => {
      const row = settings.get(tenantId) ?? settingsRow(tenantId);
      row.adsEnabled = adsEnabled;
      settings.set(tenantId, row);
      return row;
    },
    getTenantAutoRefresh: async (tenantId: string) => {
      const row = settings.get(tenantId);
      return { enabled: row?.autoRefreshEnabled ?? false, intervalS: row?.autoRefreshIntervalS ?? 15 };
    },
    setTenantAutoRefresh: async (tenantId: string, autoRefresh: { enabled: boolean; intervalS: number }) => {
      const row = settings.get(tenantId) ?? settingsRow(tenantId);
      row.autoRefreshEnabled = autoRefresh.enabled;
      row.autoRefreshIntervalS = autoRefresh.intervalS;
      settings.set(tenantId, row);
      return row;
    },
    getTenantProviders: async (tenantId: string) => {
      const row = settings.get(tenantId);
      return {
        dataProviderId: row?.dataProviderId ?? "etrade",
        brokerId: row?.brokerId ?? "etrade",
      };
    },
    setTenantProviders: async (
      tenantId: string,
      providers: { dataProviderId: string; brokerId: string },
    ) => {
      const row = settings.get(tenantId) ?? settingsRow(tenantId);
      row.dataProviderId = providers.dataProviderId;
      row.brokerId = providers.brokerId;
      settings.set(tenantId, row);
      return row;
    },
    // Issue #5423: per-step timeout (null = unconfigured — the
    // route's readSettings calls the getter on every read).
    getTenantTurnStepTimeoutMs: async (tenantId: string) =>
      settings.get(tenantId)?.turnStepTimeoutMs ?? null,
    setTenantTurnStepTimeoutMs: async (tenantId: string, timeoutMs: number) => {
      const row = settings.get(tenantId) ?? settingsRow(tenantId);
      row.turnStepTimeoutMs = timeoutMs;
      settings.set(tenantId, row);
      return row;
    },
  } as unknown as CommercialStore;
  const directory: TenantDirectory = {
    listTenantIds: async () => {
      const ids = new Set<string>(settings.keys());
      for (const account of accounts.values()) ids.add(account.tenantId);
      return [...ids].sort();
    },
    listTenantMembers: async (tenantId: string) =>
      [...accounts.values()].filter((a) => a.tenantId === tenantId).map((a) => a.id).sort(),
  };
  const operators: Pick<StoreOperators, "listOperators"> = {
    listOperators: async () =>
      [{ login: OPERATOR }] as unknown as StoreOperatorEntry[],
  };
  return {
    settings,
    accounts,
    deps: (userLogin: string) => ({
      env: {},
      userLogin,
      commercial,
      directory,
      operators,
    }),
  };
}

function parseResult(context: string): Record<string, unknown> {
  const marker = context.startsWith("BIZCOPILOT_TENANT_RESULT: ")
    ? "BIZCOPILOT_TENANT_RESULT: "
    : "BIZCOPILOT_TENANT_ERROR: ";
  expect(context.startsWith(marker)).toBe(true);
  return JSON.parse(context.slice(marker.length)) as Record<string, unknown>;
}

describe("BizCopilot tenant intent parsing (#4515)", () => {
  it("parses the list command", () => {
    expect(parseBizCopilotTenantIntent("List tenants")).toEqual({ action: "list" });
    expect(parseBizCopilotTenantIntent("show all tenants")).toEqual({ action: "list" });
    expect(parseBizCopilotTenantIntent("Show me the tenants?")).toEqual({ action: "list" });
    // The singular lists too — "Show tenant" is a complete
    // command, not a needs-identifier shape (#4701 audit).
    expect(parseBizCopilotTenantIntent("Show tenant")).toEqual({ action: "list" });
  });

  it("parses create with the tenant id preserved", () => {
    expect(parseBizCopilotTenantIntent("Create tenant acme")).toEqual({
      action: "create",
      tenantId: "acme",
    });
    expect(parseBizCopilotTenantIntent("create a tenant named Acme-Corp")).toEqual({
      action: "create",
      tenantId: "Acme-Corp",
    });
  });

  it("refuses to guess a create with a malformed id", () => {
    expect(parseBizCopilotTenantIntent("Create tenant a b")).toBeNull();
  });

  it("asks for the tenant id on a recognizable-but-incomplete command (#4701)", () => {
    expect(parseBizCopilotTenantIntent("Create a tenant")).toEqual({
      action: "needs-identifier",
      command: "create",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Create tenant ")).toEqual({
      action: "needs-identifier",
      command: "create",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Add a tenant")).toEqual({
      action: "needs-identifier",
      command: "create",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Get tenant")).toEqual({
      action: "needs-identifier",
      command: "detail",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Get the tenant")).toEqual({
      action: "needs-identifier",
      command: "detail",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Show members")).toEqual({
      action: "needs-identifier",
      command: "members",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Show settings")).toEqual({
      action: "needs-identifier",
      command: "settings-read",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("What are the settings?")).toEqual({
      action: "needs-identifier",
      command: "settings-read",
      tenantId: null,
    });
    expect(parseBizCopilotTenantIntent("Turn ads off")).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { adsEnabled: false },
    });
    expect(parseBizCopilotTenantIntent("Enable ads")).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { adsEnabled: true },
    });
    expect(parseBizCopilotTenantIntent("Disable auto-refresh")).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { autoRefreshEnabled: false },
    });
    expect(parseBizCopilotTenantIntent("Set auto-refresh interval to 30")).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { autoRefreshIntervalS: 30 },
    });
    expect(parseBizCopilotTenantIntent("Set auto-refresh interval to 0")).toBeNull();
    expect(parseBizCopilotTenantIntent("Set data provider to alpaca")).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { dataProviderId: "alpaca" },
    });
    expect(parseBizCopilotTenantIntent("Set broker to etrade")).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { brokerId: "etrade" },
    });
    expect(
      parseBizCopilotTenantIntent("Set data provider to alpaca and broker to etrade"),
    ).toEqual({
      action: "needs-identifier",
      command: "settings-update",
      tenantId: null,
      patch: { dataProviderId: "alpaca", brokerId: "etrade" },
    });
  });

  it("parses detail and member reads", () => {
    expect(parseBizCopilotTenantIntent("Show tenant acme")).toEqual({ action: "detail", tenantId: "acme" });
    expect(parseBizCopilotTenantIntent("show members of tenant acme")).toEqual({
      action: "detail",
      tenantId: "acme",
    });
    expect(parseBizCopilotTenantIntent("Show tenant acme details")).toEqual({
      action: "detail",
      tenantId: "acme",
    });
  });

  it("parses settings reads", () => {
    expect(parseBizCopilotTenantIntent("Show settings for tenant acme")).toEqual({
      action: "settings-read",
      tenantId: "acme",
    });
    expect(parseBizCopilotTenantIntent("What are the settings of acme")).toEqual({
      action: "settings-read",
      tenantId: "acme",
    });
  });

  it("parses settings updates: ads, auto-refresh, interval, providers", () => {
    expect(parseBizCopilotTenantIntent("Turn ads off for tenant acme")).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { adsEnabled: false },
    });
    expect(parseBizCopilotTenantIntent("Enable ads for acme")).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { adsEnabled: true },
    });
    expect(parseBizCopilotTenantIntent("Enable auto-refresh for tenant acme")).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { autoRefreshEnabled: true },
    });
    expect(parseBizCopilotTenantIntent("Set auto-refresh interval to 30 seconds for tenant acme")).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { autoRefreshIntervalS: 30 },
    });
    expect(parseBizCopilotTenantIntent("Set data provider to alpaca for tenant acme")).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { dataProviderId: "alpaca" },
    });
    expect(parseBizCopilotTenantIntent("Set broker to etrade for tenant acme")).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { brokerId: "etrade" },
    });
    expect(
      parseBizCopilotTenantIntent("Set data provider to alpaca and broker to etrade for tenant acme"),
    ).toEqual({
      action: "settings-update",
      tenantId: "acme",
      patch: { dataProviderId: "alpaca", brokerId: "etrade" },
    });
  });

  it("rejects a non-positive auto-refresh interval instead of guessing", () => {
    expect(parseBizCopilotTenantIntent("Set auto-refresh interval to 0 for acme")).toBeNull();
  });

  it("parses membership writes as an explicit refusal, never an action", () => {
    expect(parseBizCopilotTenantIntent("Add member alice to tenant acme")).toEqual({
      action: "membership-write-refused",
      tenantId: "acme",
      userId: "alice",
    });
    expect(parseBizCopilotTenantIntent("Remove user bob from tenant acme")).toEqual({
      action: "membership-write-refused",
      tenantId: "acme",
      userId: "bob",
    });
  });

  it("returns null for anything that is not an explicit tenant command", () => {
    for (const text of [
      "What is the weather?",
      "How can you improve yourself?",
      "Pause the loop",
      "Show tenant acme settings",
      "Create a tenant for the new team",
      "Tell me about tenants",
      // Incomplete membership writes stay null (#4701 audit): the
      // complete shape is already a deterministic refusal, so
      // there is no capability-denial fall-through hole — asking
      // for an id only to refuse adds a round trip with no value.
      "Add member alice",
    ]) {
      expect(parseBizCopilotTenantIntent(text), text).toBeNull();
    }
  });
});

describe("BizCopilot tenant execution through the page's routes (#4515)", () => {
  it("lists tenants with settings + member counts and the page link", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    world.accounts.set("alice", accountRow("alice", "acme"));
    const context = await executeBizCopilotTenantIntent({ action: "list" }, world.deps(OPERATOR));
    const parsed = parseResult(context);
    expect(parsed["action"]).toBe("list");
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    const result = parsed["result"] as { tenants: Array<Record<string, unknown>> };
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0]).toMatchObject({ tenantId: "acme", memberCount: 1 });
  });

  it("creates a tenant (settings row with store defaults) and is idempotent on retry", async () => {
    const world = makeWorld();
    const first = await executeBizCopilotTenantIntent(
      { action: "create", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    const firstParsed = parseResult(first);
    expect(firstParsed["action"]).toBe("create");
    expect(firstParsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    const tenant = (firstParsed["result"] as { tenant: Record<string, unknown> }).tenant;
    expect(tenant).toMatchObject({
      tenantId: "acme",
      adsEnabled: true,
      autoRefreshEnabled: false,
      autoRefreshIntervalS: 15,
    });
    const second = await executeBizCopilotTenantIntent(
      { action: "create", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    expect(parseResult(second)["result"]).toEqual(firstParsed["result"]);
    expect(world.settings.size).toBe(1);
  });

  it("reads a tenant's detail with account members", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    world.accounts.set("alice", accountRow("alice", "acme"));
    const context = await executeBizCopilotTenantIntent(
      { action: "detail", tenantId: "acme" },
      world.deps(OPERATOR),
    );
    const parsed = parseResult(context);
    const tenant = (parsed["result"] as { tenant: Record<string, unknown> }).tenant;
    expect(tenant).toMatchObject({ tenantId: "acme" });
    expect(tenant["members"]).toHaveLength(1);
    expect((tenant["members"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      userId: "alice",
      hasAccount: true,
    });
  });

  it("updates ads directly and merges auto-refresh / provider fields over the stored settings", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    const ads = await executeBizCopilotTenantIntent(
      { action: "settings-update", tenantId: "acme", patch: { adsEnabled: false } },
      world.deps(OPERATOR),
    );
    expect(
      ((parseResult(ads)["result"] as { tenant: Record<string, unknown> }).tenant)["adsEnabled"],
    ).toBe(false);
    expect(world.settings.get("acme")?.adsEnabled).toBe(false);

    const refresh = await executeBizCopilotTenantIntent(
      { action: "settings-update", tenantId: "acme", patch: { autoRefreshEnabled: true } },
      world.deps(OPERATOR),
    );
    const refreshTenant = (parseResult(refresh)["result"] as { tenant: Record<string, unknown> }).tenant;
    expect(refreshTenant).toMatchObject({ autoRefreshEnabled: true, autoRefreshIntervalS: 15 });

    const interval = await executeBizCopilotTenantIntent(
      { action: "settings-update", tenantId: "acme", patch: { autoRefreshIntervalS: 30 } },
      world.deps(OPERATOR),
    );
    const intervalTenant = (parseResult(interval)["result"] as { tenant: Record<string, unknown> }).tenant;
    expect(intervalTenant).toMatchObject({ autoRefreshEnabled: true, autoRefreshIntervalS: 30 });

    const provider = await executeBizCopilotTenantIntent(
      { action: "settings-update", tenantId: "acme", patch: { dataProviderId: "alpaca" } },
      world.deps(OPERATOR),
    );
    const providerTenant = (parseResult(provider)["result"] as { tenant: Record<string, unknown> }).tenant;
    expect(providerTenant).toMatchObject({ dataProviderId: "alpaca", brokerId: "etrade" });
  });

  it("surfaces an unknown tenant as an explicit error outcome", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotTenantIntent(
      { action: "detail", tenantId: "ghost" },
      world.deps(OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_TENANT_ERROR: ")).toBe(true);
    const parsed = parseResult(context);
    expect(parsed["status"]).toBe(404);
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
  });

  it("enforces the store-operator gate: a non-operator gets a 403 outcome, never the data", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    const context = await executeBizCopilotTenantIntent(
      { action: "list" },
      world.deps(NON_OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_TENANT_ERROR: ")).toBe(true);
    expect(parseResult(context)["status"]).toBe(403);
  });

  it("fails closed without a verified login", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotTenantIntent({ action: "list" }, world.deps(""));
    expect(context.startsWith("BIZCOPILOT_TENANT_ERROR: ")).toBe(true);
    expect(parseResult(context)["status"]).toBe(401);
  });

  it("refuses membership writes without calling any route", async () => {
    const world = makeWorld();
    const intent: BizCopilotTenantIntent = {
      action: "membership-write-refused",
      tenantId: "acme",
      userId: "alice",
    };
    const context = await executeBizCopilotTenantIntent(intent, world.deps(OPERATOR));
    const parsed = parseResult(context);
    expect(parsed["refused"]).toBe(true);
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    expect(world.settings.size).toBe(0);
  });

  it("answers a needs-identifier intent with the question and the page link, calling no route (#4701)", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotTenantIntent(
      { action: "needs-identifier", command: "create", tenantId: null },
      world.deps(OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_TENANT_RESULT: ")).toBe(true);
    const parsed = parseResult(context);
    expect(parsed["action"]).toBe("needs-identifier");
    expect(parsed["command"]).toBe("create");
    expect(parsed["tenantId"]).toBeNull();
    expect(parsed["needsIdentifier"]).toBe(true);
    expect(parsed["ask"]).toContain("Create tenant acme");
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    expect(world.settings.size).toBe(0);
  });

  it("names the exact settings change in a settings-update ask (#4701)", async () => {
    const world = makeWorld();
    const context = await executeBizCopilotTenantIntent(
      {
        action: "needs-identifier",
        command: "settings-update",
        tenantId: null,
        patch: { adsEnabled: false },
      },
      world.deps(OPERATOR),
    );
    const parsed = parseResult(context);
    expect(parsed["ask"]).toContain("Turn ads off for tenant acme");
    expect(world.settings.size).toBe(0);
  });
});

describe("BizCopilot tenant turn branch (#4515)", () => {
  it("returns empty context for a non-BizCopilot turn", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotTenantBranch({
      sourceTab: "Stock Copilot",
      userText: "List tenants",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(context).toBe("");
    expect(audits).toEqual([]);
    expect(world.settings.size).toBe(0);
  });

  it("returns empty context when the BizCopilot text is not a tenant command", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotTenantBranch({
      sourceTab: "BizCopilot",
      userText: "What can you do here?",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(context).toBe("");
    expect(audits).toEqual([]);
  });

  it("executes a BizCopilot tenant command and audits the action", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotTenantBranch({
      sourceTab: "BizCopilot",
      userText: "Create tenant acme",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      commercial: world.deps(OPERATOR).commercial,
      directory: world.deps(OPERATOR).directory,
      operators: world.deps(OPERATOR).operators,
    });
    expect(context.startsWith("BIZCOPILOT_TENANT_RESULT: ")).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "bizcopilot.tenant_action_executed",
      payload: { sourceTab: "BizCopilot", action: "create", tenantId: "acme" },
    });
    expect(world.settings.has("acme")).toBe(true);
  });

  it("answers the bare quick-chip command with the ask outcome instead of falling through (#4701)", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const context = await runBizCopilotTenantBranch({
      sourceTab: "BizCopilot",
      userText: "Create a tenant",
      env: {},
      userLogin: OPERATOR,
      audit: (type, payload) => audits.push({ type, payload }),
      commercial: world.deps(OPERATOR).commercial,
      directory: world.deps(OPERATOR).directory,
      operators: world.deps(OPERATOR).operators,
    });
    expect(context.startsWith("BIZCOPILOT_TENANT_RESULT: ")).toBe(true);
    expect(parseResult(context)["needsIdentifier"]).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "bizcopilot.tenant_action_executed",
      payload: {
        sourceTab: "BizCopilot",
        action: "needs-identifier",
        command: "create",
        tenantId: null,
      },
    });
    expect(world.settings.size).toBe(0);
  });
});
