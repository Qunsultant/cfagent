/**
 * Issue #4741 (BizCopilot, umbrella #4514) — the MCP tool for tenant
 * administration: command + executor-reuse + permission coverage.
 *
 * The fakes below are the route handler's own test seams (commercial /
 * directory / operators) over one shared in-memory world — the same
 * world shape as tests/bizcopilot_tenants_4515.test.ts, so the tool is
 * exercised through the real executor and the real handler (gate,
 * idempotent create, settings merge, 404/403 outcomes included),
 * not through a stub of it. The tool carries the seams as optional
 * constructor deps; the factory constructs with none (production
 * composes the adapters from env).
 *
 * Permission honesty, pinned here: the MCP scope gate does NOT deny
 * a non-operator session today (recorded defaults: a session holds
 * every scope; no call site threads a role resolver yet — CISO
 * follow-up, ADR 0012 / #5350). What denies a non-operator is the
 * route's store-operator gate, reached verbatim through the tool.
 * The tests prove the declaration + the adapter derivation (the
 * mechanism that restricts once a resolver is threaded) AND the
 * end-to-end non-operator refusal with no mutation.
 */
import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  BIZCOPILOT_TENANT_TOOL_ACTIONS,
  ManageTenantsCommand,
} from "../src/mcps/openaimp/bizCopilotTenantCommands";
import {
  MCP_PERMISSION_DENIED_CODE,
  MCP_TOOL_SCOPES,
  createInMemoryMcpPermissionPort,
  createProductionMcpPermissionPort,
  scopesForIaaaRoles,
} from "../src/mcps/openaimp/mcpPermissionPorts";
import { MCP_TOOLS } from "../src/mcps/openaimp";
import { buildMcpCatalog } from "../src/mcps/openaimp/catalog";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import { BIZCOPILOT_TENANTS_PAGE_URL } from "../src/services/bizCopilotTenants";
import type { CommercialStore, TenantSettingsRecord, CommercialAccountRecord } from "../src/data/commercialPorts";
import type { TenantDirectory } from "../src/data/tenantDirectoryPorts";
import type { StoreOperators, StoreOperatorEntry } from "../src/data/storeOperatorsPorts";
import type { McpToolContext } from "../src/patterns/interfaces";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

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
    // Issue #5425: SLO thresholds, null = unconfigured (same as the adapters' fresh row).
    sloUptimeTargetRatio: null,
    sloP95LatencyMaxMs: null,
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

/** One shared world backing the store + directory fakes (same shape as #4515). */
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
    // Issue #5425: SLO thresholds (null = unconfigured — the
    // route's readSettings calls the getters on every read).
    getTenantSloUptimeTargetRatio: async (tenantId: string) =>
      settings.get(tenantId)?.sloUptimeTargetRatio ?? null,
    setTenantSloUptimeTargetRatio: async (tenantId: string, ratio: number) => {
      const row = settings.get(tenantId) ?? settingsRow(tenantId);
      row.sloUptimeTargetRatio = ratio;
      settings.set(tenantId, row);
      return row;
    },
    getTenantSloP95LatencyMaxMs: async (tenantId: string) =>
      settings.get(tenantId)?.sloP95LatencyMaxMs ?? null,
    setTenantSloP95LatencyMaxMs: async (tenantId: string, maxMs: number) => {
      const row = settings.get(tenantId) ?? settingsRow(tenantId);
      row.sloP95LatencyMaxMs = maxMs;
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
    seams: {
      commercial,
      directory,
      operators,
    },
  };
}

function parseOutcome(context: string): Record<string, unknown> {
  const marker = context.startsWith("BIZCOPILOT_TENANT_RESULT: ")
    ? "BIZCOPILOT_TENANT_RESULT: "
    : "BIZCOPILOT_TENANT_ERROR: ";
  expect(context.startsWith(marker)).toBe(true);
  return JSON.parse(context.slice(marker.length)) as Record<string, unknown>;
}

function toolContext(
  userLogin: string | undefined,
  audits: Array<{ type: string; payload: Record<string, unknown> }>,
): McpToolContext {
  return {
    env: {},
    orm: {} as never,
    sessionId: "sess-4741",
    actingLogin: userLogin === undefined ? undefined : () => userLogin,
    audit: (type, _agent, payload) => audits.push({ type, payload }),
  } as McpToolContext;
}

async function runTool(
  input: Record<string, unknown>,
  userLogin: string | undefined,
  world: ReturnType<typeof makeWorld>,
  audits: Array<{ type: string; payload: Record<string, unknown> }> = [],
): Promise<string> {
  const command = new ManageTenantsCommand(world.seams);
  return command.execute(input, toolContext(userLogin, audits));
}

describe("registration (#4741)", () => {
  it("registers manage_tenants in the factory, exactly once", () => {
    const command = McpToolFactory.getTool("manage_tenants");
    expect(command).toBeDefined();
    expect(command).toBeInstanceOf(ManageTenantsCommand);
    expect(command!.name).toBe("manage_tenants");
    const names = McpToolFactory.getAllTools().map((t) => t.name);
    expect(names.filter((n) => n === "manage_tenants")).toHaveLength(1);
  });

  it("exposes the tool in tools/list", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain("manage_tenants");
  });

  it("declares the mcp:admin scope and the synchronous classification", () => {
    expect(MCP_TOOL_SCOPES["manage_tenants"]).toBe("mcp:admin");
    expect(isSynchronousMcpTool("manage_tenants")).toBe(true);
  });

  it("adds the tool to the served MCP catalogue", () => {
    // #6438: the explorer reads GET /api/mcp/catalog, so the served
    // catalogue is the assertion — and the category is now the tool's
    // permission scope, as served (no hand-written "System & Audit").
    const entry = buildMcpCatalog().tools.find((t) => t.name === "manage_tenants");
    expect(entry).toBeDefined();
    expect(entry!.scope).toBe("mcp:admin");
  });

  it("carries the six-action enum in the schema", () => {
    const command = McpToolFactory.getTool("manage_tenants")!;
    expect(command.jsonSchema.required).toEqual(["action"]);
    expect(
      (command.jsonSchema.properties as Record<string, { enum?: string[] }>)["action"]?.enum,
    ).toEqual([...BIZCOPILOT_TENANT_TOOL_ACTIONS]);
    expect(BIZCOPILOT_TENANT_TOOL_ACTIONS).toEqual([
      "list",
      "create",
      "detail",
      "settings-read",
      "settings-update",
      "membership-write-refused",
    ]);
  });
});

describe("schema validation (#4741)", () => {
  it("rejects an unknown action", async () => {
    const world = makeWorld();
    await expect(runTool({ action: "delete" }, OPERATOR, world)).rejects.toThrow();
  });

  it("asks for the tenant id instead of calling without it (no fall-through denial)", async () => {
    const world = makeWorld();
    for (const action of ["create", "detail", "settings-read", "settings-update", "membership-write-refused"]) {
      await expect(runTool({ action }, OPERATOR, world)).rejects.toThrow(
        `tenantId is required for action '${action}'`,
      );
    }
    expect(world.settings.size).toBe(0);
  });

  it("requires a user id for the membership refusal and a patch field for settings-update", async () => {
    const world = makeWorld();
    await expect(
      runTool({ action: "membership-write-refused", tenantId: "acme" }, OPERATOR, world),
    ).rejects.toThrow("userId is required for action 'membership-write-refused'");
    await expect(
      runTool({ action: "settings-update", tenantId: "acme" }, OPERATOR, world),
    ).rejects.toThrow("at least one settings field is required for action 'settings-update'");
    expect(world.settings.size).toBe(0);
  });
});

describe("executor reuse — all six activities via the tool (#4741)", () => {
  it("lists tenants through the page's own routes", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    world.accounts.set("alice@example.com", accountRow("alice@example.com", "acme"));
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const outcome = await runTool({ action: "list" }, OPERATOR, world, audits);
    const parsed = parseOutcome(outcome);
    expect(parsed["action"]).toBe("list");
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "bizcopilot.tenant_action_executed",
      payload: { action: "list", tenantId: null, via: "mcp_tool" },
    });
  });

  it("creates a tenant and audits the action", async () => {
    const world = makeWorld();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const outcome = await runTool({ action: "create", tenantId: "acme" }, OPERATOR, world, audits);
    const parsed = parseOutcome(outcome);
    expect(parsed["action"]).toBe("create");
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    expect(world.settings.has("acme")).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "bizcopilot.tenant_action_executed",
      payload: { action: "create", tenantId: "acme", via: "mcp_tool" },
    });
  });

  it("reads detail and settings through the tool", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    world.accounts.set("alice@example.com", accountRow("alice@example.com", "acme"));
    const detail = parseOutcome(await runTool({ action: "detail", tenantId: "acme" }, OPERATOR, world));
    expect(detail["action"]).toBe("detail");
    expect(detail["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    const settings = parseOutcome(
      await runTool({ action: "settings-read", tenantId: "acme" }, OPERATOR, world),
    );
    expect(settings["action"]).toBe("settings-read");
    expect(settings["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
  });

  it("updates settings directly for ads and merges over stored settings for providers", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    const adsOff = parseOutcome(
      await runTool({ action: "settings-update", tenantId: "acme", adsEnabled: false }, OPERATOR, world),
    );
    expect(adsOff["action"]).toBe("settings-update");
    expect(world.settings.get("acme")?.adsEnabled).toBe(false);
    // Provider change merges: the stored ads value survives the read-then-merge.
    await runTool(
      { action: "settings-update", tenantId: "acme", dataProviderId: "alpaca" },
      OPERATOR,
      world,
    );
    expect(world.settings.get("acme")?.dataProviderId).toBe("alpaca");
    expect(world.settings.get("acme")?.adsEnabled).toBe(false);
    expect(world.settings.get("acme")?.brokerId).toBe("etrade");
  });

  it("refuses membership writes deterministically, with no route call", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    const outcome = await runTool(
      { action: "membership-write-refused", tenantId: "acme", userId: "bob@example.com" },
      OPERATOR,
      world,
    );
    const parsed = parseOutcome(outcome);
    expect(parsed["action"]).toBe("membership-write-refused");
    expect(parsed["refused"]).toBe(true);
    expect(parsed["pageUrl"]).toBe(BIZCOPILOT_TENANTS_PAGE_URL);
    expect(world.settings.get("acme")).toEqual(settingsRow("acme"));
  });
});

describe("permission coverage (#4741)", () => {
  it("a non-operator gets a 403 outcome and nothing is mutated", async () => {
    const world = makeWorld();
    world.settings.set("acme", settingsRow("acme"));
    const before = JSON.stringify([...world.settings.entries()]);
    const list = parseOutcome(await runTool({ action: "list" }, NON_OPERATOR, world));
    expect(list["status"]).toBe(403);
    const create = parseOutcome(
      await runTool({ action: "create", tenantId: "evil" }, NON_OPERATOR, world),
    );
    expect(create["status"]).toBe(403);
    expect(world.settings.has("evil")).toBe(false);
    expect(JSON.stringify([...world.settings.entries()])).toBe(before);
  });

  it("fails closed without a verified login", async () => {
    const world = makeWorld();
    const outcome = parseOutcome(await runTool({ action: "list" }, undefined, world));
    expect(outcome["status"]).toBe(401);
  });

  it("the gate denies an unknown principal before the command runs", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    const auditLogs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const mockEnv = { AI: {}, ORCHESTRATOR_AGENT: {}, AGENT_SESSIONS: {} } as unknown as Env;
    await expect(
      McpToolFactory.executeTool(
        "manage_tenants",
        { action: "list" },
        {
          env: mockEnv,
          orm,
          sessionId: "session_1",
          audit: (type, _agent, payload) => auditLogs.push({ type, payload }),
          principal: { kind: "unknown", login: null },
          permissionPort: createInMemoryMcpPermissionPort(),
        },
      ),
    ).rejects.toMatchObject({ code: MCP_PERMISSION_DENIED_CODE });
    expect(auditLogs.some((l) => l.type === "mcp.permission_denied")).toBe(true);
  });

  it("the production port allows a session principal today (recorded defaults — the route gate is the enforcement)", async () => {
    const port = createProductionMcpPermissionPort();
    const decision = await port.authorize({ kind: "session", login: NON_OPERATOR }, "manage_tenants");
    expect(decision).toMatchObject({ allowed: true, scope: "mcp:admin" });
  });

  it("the GAP-4 adapter derives mcp:admin only from platform-privilege permissions", () => {
    expect(scopesForIaaaRoles([])).not.toContain("mcp:admin");
    // member holds task/artifact permissions only — no audit:read, no mcp:admin.
    expect(scopesForIaaaRoles(["member"])).not.toContain("mcp:admin");
    expect(scopesForIaaaRoles(["platform-admin"])).toContain("mcp:admin");
    expect(scopesForIaaaRoles(["auditor"])).toContain("mcp:admin");
  });

  it("the adapter governs the gate once a role resolver is threaded", async () => {
    const memberPort = createInMemoryMcpPermissionPort({
      resolveRoles: async () => ["member"],
    });
    const memberDecision = await memberPort.authorize(
      { kind: "session", login: NON_OPERATOR },
      "manage_tenants",
    );
    expect(memberDecision.allowed).toBe(false);
    const adminPort = createInMemoryMcpPermissionPort({
      resolveRoles: async () => ["platform-admin"],
    });
    const adminDecision = await adminPort.authorize(
      { kind: "session", login: OPERATOR },
      "manage_tenants",
    );
    expect(adminDecision).toMatchObject({ allowed: true, scope: "mcp:admin" });
  });
});

describe("steering (#4741)", () => {
  it("steers BizCopilot turns to the tool and requires the id", () => {
    const prompt = buildOrchestratorSystemPrompt({
      route: { agent: "orchestrator", confidence: 1, reason: "test" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
    expect(prompt).toContain("'tool_openaimp_manage_tenants'");
    expect(prompt).toContain("the tenant id is required");
  });
});
