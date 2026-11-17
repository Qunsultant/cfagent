import { describe, it, expect, vi } from "vitest";
import {
  IBKR_CONFIG,
  resolveIbkrMcpUrl,
} from "../src/config/ibkr";
import {
  IBKR_SINGLE_PLATFORM_NOTICE,
  checkIbkrRegionAvailability,
  describeIbkrConnection,
  filterIbkrV1Tools,
  getIbkrAccessToken,
  isIbkrToolAllowedV1,
  recordIbkrDiscoveredTools,
  revokeIbkrConnection,
  storeIbkrTokenSet,
} from "../src/security/ibkrOAuth";
import {
  IBKR_MCP_SERVER_ID,
  createIbkrMcpFetch,
  ensureIbkrMcpConnection,
  ibkrTurnGate,
  type MeshMcpManagerPort,
} from "../src/agents/orchestrator/meshMcpClient";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

describe("Issue #4676 / #3410 (Gap 22) — IBKR Hosted MCP v1 Read-Only Integration", () => {
  it("resolves externalized IBKR MCP URL and blocks IN/JP regions cleanly", () => {
    expect(resolveIbkrMcpUrl()).toBe("https://api.ibkr.com/v1/api/mcp-public");
    expect(resolveIbkrMcpUrl({ IBKR_MCP_SERVER_URL: "https://ibkr-proxy.example.com/" })).toBe(
      "https://ibkr-proxy.example.com",
    );

    expect(checkIbkrRegionAvailability("US")).toEqual({ allowed: true });
    expect(checkIbkrRegionAvailability("IN")).toEqual({
      allowed: false,
      code: "IBKR_REGION_UNAVAILABLE",
      message: "Interactive Brokers MCP is not available in region IN.",
    });
    expect(checkIbkrRegionAvailability("jp")).toEqual({
      allowed: false,
      code: "IBKR_REGION_UNAVAILABLE",
      message: "Interactive Brokers MCP is not available in region JP.",
    });
  });

  it("registers 'ibkr' on the Agents SDK MCP manager and discovers tool_ibkr_* tools", async () => {
    const registered: Array<{ id: string; url: string }> = [];
    const connected: string[] = [];
    const discovered: string[] = [];
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let ready = false;

    const mcp: MeshMcpManagerPort = {
      async waitForConnections() {},
      getAITools(opts) {
        if (!ready || opts?.serverId !== IBKR_MCP_SERVER_ID) return {};
        return {
          tool_ibkr_get_positions: {},
          tool_ibkr_get_balances: {},
          tool_ibkr_place_order: {},
        };
      },
      async removeServer() {},
      async registerServer(id, opts) {
        registered.push({ id, url: opts.url });
      },
      async connectToServer(id) {
        connected.push(id);
      },
      async discoverIfConnected(id) {
        discovered.push(id);
        ready = true;
      },
    };

    const customFetch = createIbkrMcpFetch({
      getAccessToken: async () => "ibkr-secret-token",
      countryCode: "US",
      fetchImpl: vi.fn(async () => new Response("ok")) as unknown as typeof fetch,
    });

    const result = await ensureIbkrMcpConnection({
      mcp,
      fetch: customFetch,
      audit: (type, payload) => audits.push({ type, payload }),
    });

    expect(result).toEqual({ ready: true, toolCount: 3, reused: false });
    expect(registered).toEqual([{ id: "ibkr", url: IBKR_CONFIG.mcpServerUrl }]);
    expect(connected).toEqual(["ibkr"]);
    expect(discovered).toEqual(["ibkr"]);
    expect(audits).toEqual([
      { type: "ibkr_mcp.discovery_ready", payload: { serverId: "ibkr", toolCount: 3 } },
    ]);
  });

  it("enforces v1 read-only allowlist and refuses trade/write tools at the Copilot turn gate", () => {
    expect(isIbkrToolAllowedV1("tool_ibkr_get_positions")).toBe(true);
    expect(isIbkrToolAllowedV1("tool_ibkr_get_orders")).toBe(true);
    expect(isIbkrToolAllowedV1("tool_ibkr_list_accounts")).toBe(true);
    expect(isIbkrToolAllowedV1("tool_ibkr_place_order")).toBe(false);
    expect(isIbkrToolAllowedV1("tool_ibkr_cancel_order")).toBe(false);
    expect(isIbkrToolAllowedV1("tool_ibkr_submit_trade_instruction")).toBe(false);
    expect(isIbkrToolAllowedV1("tool_ibkr_modify_order")).toBe(false);

    // Pinned live allowlist still blocks any write-like name even if passed.
    expect(isIbkrToolAllowedV1("tool_ibkr_place_order", ["place_order", "get_positions"])).toBe(false);
    expect(isIbkrToolAllowedV1("tool_ibkr_get_positions", ["place_order", "get_positions"])).toBe(true);

    const gate = ibkrTurnGate({
      toolNames: [
        "tool_openaimp_execute_nlq",
        "tool_ibkr_get_positions",
        "tool_ibkr_get_balances",
        "tool_ibkr_place_order",
        "tool_ibkr_cancel_order",
      ],
    });
    expect(gate.blockedIbkrTools).toEqual(["tool_ibkr_place_order", "tool_ibkr_cancel_order"]);
    expect(gate.activeTools).toEqual([
      "tool_openaimp_execute_nlq",
      "tool_ibkr_get_positions",
      "tool_ibkr_get_balances",
    ]);

    expect(
      filterIbkrV1Tools(["get_positions", "get_balances", "place_order", "cancel_order"]),
    ).toEqual(["get_positions", "get_balances"]);
  });

  it("refuses unauthenticated or region-blocked calls cleanly and never leaks tokens in audits", async () => {
    const blockedFetch = createIbkrMcpFetch({
      getAccessToken: async () => "secret-tok",
      countryCode: "IN",
    });
    const blockedRes = await blockedFetch("https://api.ibkr.com/v1/api/mcp-public", {});
    expect(blockedRes.status).toBe(403);
    expect(await blockedRes.json()).toMatchObject({ code: "IBKR_REGION_UNAVAILABLE" });

    const noAuthFetch = createIbkrMcpFetch({
      getAccessToken: async () => null,
      countryCode: "US",
    });
    const noAuthRes = await noAuthFetch("https://api.ibkr.com/v1/api/mcp-public", {});
    expect(noAuthRes.status).toBe(401);
    expect(await noAuthRes.json()).toMatchObject({ code: "IBKR_AUTH_REQUIRED" });

    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const failingMcp: MeshMcpManagerPort = {
      async waitForConnections() {},
      getAITools: () => ({}),
      async removeServer() {},
      async registerServer() {
        throw new Error("401 Unauthorized Bearer secret-leak-xyz\nstack line 2");
      },
      async connectToServer() {},
      async discoverIfConnected() {},
    };
    const res = await ensureIbkrMcpConnection({
      mcp: failingMcp,
      fetch: noAuthFetch,
      audit: (type, payload) => audits.push({ type, payload }),
    });
    expect(res.ready).toBe(false);
    expect(res.error).not.toContain("secret-leak-xyz");
    expect(res.error).not.toContain("stack line 2");
    expect(JSON.stringify(audits)).not.toContain("secret-leak-xyz");
  });

  it("stores tokens only in SessionStore DO and exposes a secret-free connection description", async () => {
    const ns = makeMemoryDoNamespace();
    const env = { SESSION_STORE: ns } as unknown as Env;

    await storeIbkrTokenSet(env, {
      accessToken: "ibkr-access-secret-999",
      refreshToken: "ibkr-refresh-secret-888",
      expiresAt: Date.now() + 3_600_000,
      clientId: "dcr-client-1",
      issuer: "https://api.ibkr.com",
      tokenEndpoint: "https://api.ibkr.com/oauth/token",
      storedAt: "2026-11-17T00:00:00.000Z",
      userLogin: "trader@example.com",
      accountId: "U1234567",
    });

    const filtered = await recordIbkrDiscoveredTools(env, "trader@example.com", [
      "get_positions",
      "get_balances",
      "place_order",
    ]);
    expect(filtered).toEqual(["get_positions", "get_balances"]);

    const desc = await describeIbkrConnection(env, "trader@example.com");
    expect(desc.connected).toBe(true);
    expect(desc.accountId).toBe("U1234567");
    expect(desc.verifiedTools).toEqual(["get_positions", "get_balances"]);
    expect(desc.readOnlyV1).toBe(true);
    expect(desc.singlePlatformNotice).toBe(IBKR_SINGLE_PLATFORM_NOTICE);
    expect(JSON.stringify(desc)).not.toContain("ibkr-access-secret-999");
    expect(JSON.stringify(desc)).not.toContain("ibkr-refresh-secret-888");

    expect(await getIbkrAccessToken(env, "trader@example.com")).toBe("ibkr-access-secret-999");

    await revokeIbkrConnection(env, "trader@example.com");
    expect(await getIbkrAccessToken(env, "trader@example.com")).toBeNull();
  });
});
