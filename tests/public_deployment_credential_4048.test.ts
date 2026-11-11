// @vitest-environment node
/**
 * Issue #4048 — the deployment credential, and the account read the copilot
 * was missing.
 *
 * PUBLIC_API_KEY is a deployment secret like ALPACA_*: when a user has no
 * stored personal token the Public credential resolves from env, and the
 * status surface NAMES the source so a shared key is never mistaken for the
 * user's own account. A stored token always wins.
 *
 * The deployment key is a READ credential only: `refuseDeploymentCredential`
 * on the Public platform refuses preview/place/cancel when it
 * is what would serve the call, because the account behind
 * PUBLIC_API_KEY is one account shared by every tenant on the deployment.
 * The refusal sits at the platform seam, so the copilot tools and the
 * neutral broker routes both pass through it.
 *
 * Red before this slice (observed 2026-11-11 on the branch head): the
 * account-read block called `readFileSync` without importing it —
 * `2 failed | 3 passed`, `ReferenceError: readFileSync is not defined` at
 * this file's account-read test. It asserted source text, so no behaviour
 * was covered at all. The behavioural tests below replace it: they execute
 * the registered tool through McpToolFactory against a stubbed Public MCP
 * transport. No live network, no live order — every MCP call goes through
 * the injected fake fetch, and the placement tools are asserted never to be
 * reached.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  getPublicAccessToken,
  getPublicConnectionStatus,
  getPublicCredentialSource,
  storePublicPersonalToken,
} from "../src/security/publicOAuth";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MESH_TOOL_FAMILIES } from "../src/agents/registry";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import { TradingPlatformRegistry } from "../src/trading";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

const LOGIN = "owner@example.com";
const DEPLOYMENT = "public-deployment-token-123456";

function envWith(extra: Record<string, unknown> = {}): Env {
  const store = makeFakeSessionStore();
  return {
    SESSION_STORE: store.namespace as never,
    ...extra,
  } as unknown as Env;
}

/* ------------------------- fake Public MCP transport ------------------------- */

type RpcCall = { method: string; tool?: string };

const TOOL_SCHEMAS: Record<string, { properties: Record<string, unknown>; required: string[] }> = {
  get_accounts: { properties: {}, required: [] },
  get_portfolio: { properties: {}, required: [] },
  get_orders: { properties: {}, required: [] },
  preflight_order: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  place_order: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  cancel_order: { properties: { order_id: { type: "string" } }, required: ["order_id"] },
};

const TOOL_RESULTS: Record<string, unknown> = {
  get_accounts: {
    accounts: [{ account_id: "acc-1", account_number: "P-1234", account_type: "individual", cash_available: 4200 }],
  },
  get_portfolio: {
    positions: [
      // average cost present: the P&L the broker sent is carried through
      { symbol: "AAPL", quantity: 10, market_value: 3423.7, average_cost: 300 },
      // average cost absent: unknown basis, never "marketValue − 0" as a gain
      { symbol: "MSFT", quantity: 2, market_value: 800 },
    ],
    buying_power: 5000,
  },
};

function installFakeMcp(calls: RpcCall[]) {
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: { body?: string }): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method === "tools/list") {
        calls.push({ method: "tools/list" });
        return Response.json({
          result: {
            tools: Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
              name,
              inputSchema: { type: "object", ...schema },
            })),
          },
        });
      }
      if (body.method === "tools/call") {
        const name = body.params?.name ?? "";
        calls.push({ method: "tools/call", tool: name });
        return Response.json({
          result: { content: [{ type: "text", text: JSON.stringify(TOOL_RESULTS[name] ?? {}) }] },
        });
      }
      return Response.json({}, { status: 404 });
    }
  );
}

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(LOGIN);
  return orm;
}

function ctx(orm: DatabaseORM, env: Env): any {
  return { env, orm, sessionId: LOGIN, audit: vi.fn() };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Issue #4048 — Public deployment credential", () => {
  it("reports a deployment connection, naming the source, when only env is set", async () => {
    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    const status = await getPublicConnectionStatus(env, LOGIN);
    expect(status.connected).toBe(true);
    expect(status.verified).toBe(false);
    expect(status.method).toBe("deployment");
    expect(status.source).toBe("deployment");
    // the deployment key is shared: never hand out a hint of its value
    expect(status.tokenHint).toBeNull();
    expect(await getPublicAccessToken(env, LOGIN)).toBe(DEPLOYMENT);
    expect(await getPublicCredentialSource(env, LOGIN)).toBe("deployment");
  });

  it("lets a stored personal token override the deployment key", async () => {
    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    await storePublicPersonalToken(env, LOGIN, "personal-token-abcdef");
    const status = await getPublicConnectionStatus(env, LOGIN);
    expect(status.source).toBe("user");
    expect(status.method).toBe("personal");
    expect(await getPublicAccessToken(env, LOGIN)).toBe("personal-token-abcdef");
    expect(await getPublicCredentialSource(env, LOGIN)).toBe("user");
  });

  it("stays disconnected when neither credential exists", async () => {
    const env = envWith();
    const status = await getPublicConnectionStatus(env, LOGIN);
    expect(status.connected).toBe(false);
    expect(status.verified).toBe(false);
    expect(status.source).toBeNull();
    expect(status.tokenHint).toBeNull();
    expect(await getPublicAccessToken(env, LOGIN)).toBeNull();
    expect(await getPublicCredentialSource(env, LOGIN)).toBeNull();
  });

  it("ignores a blank or too-short deployment value", async () => {
    for (const value of ["", "   ", "short"]) {
      const env = envWith({ PUBLIC_API_KEY: value });
      expect((await getPublicConnectionStatus(env, LOGIN)).connected).toBe(false);
      expect(await getPublicAccessToken(env, LOGIN)).toBeNull();
    }
  });
});

describe("Issue #4048 — the account read the copilot was missing", () => {
  it("reads one account and two positions from the platform, never a trade path", async () => {
    // public_account reaches trading only through TradingPlatformRegistry.getPlatform
    // (publicPlatform in src/mcps/openaimp/publicCommands.ts), so the seam is stubbed
    // there — the pattern tests/account_panel_parity_3359.test.ts uses — and the
    // REGISTERED command is executed, not a reimplementation of it.
    const account = {
      accountId: "acc-1",
      accountNumber: "P-1234",
      accountType: "individual",
      cashAvailableForInvestment: 4200,
    };
    const positions = [
      { symbol: "AAPL", quantity: 10, marketValue: 3423.7, pricePaid: 300, costBasis: 3000, costBasisKnown: true, totalGain: 423.7 },
      // basis the broker did not send: the derived fields must be dropped, not
      // reported as marketValue − 0 (the #4048 rule in the command)
      { symbol: "MSFT", quantity: 2, marketValue: 800, pricePaid: 400, costBasis: 800, costBasisKnown: false, totalGain: 0 },
    ];
    const platformStub = {
      getPositions: vi.fn(async () => ({ account, positions })),
      previewOrder: vi.fn(),
      placeOrder: vi.fn(),
      placeOrderRemote: vi.fn(),
    };
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(() => platformStub as any);

    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    const context = ctx(makeOrm(), env);
    const result = await McpToolFactory.getTool("public_account")!.execute({}, context);

    expect(result.provider).toBe("public");
    expect(result.provenance).toBe("live");
    expect(result.accounts).toHaveLength(1);
    expect(result.account.accountId).toBe("acc-1");
    expect(result.positions).toHaveLength(2);
    expect(result.positions.map((p: any) => p.symbol)).toEqual(["AAPL", "MSFT"]);
    // buying power is the account's cash available, carried through as the broker sent it
    expect(result.buyingPower).toBe(4200);

    const msft = result.positions.find((p: any) => p.symbol === "MSFT");
    expect(msft).toMatchObject({
      pricePaid: null,
      costBasis: null,
      totalGain: null,
      totalGainPercent: null,
    });

    expect(context.audit).toHaveBeenCalledWith(
      "public.account_read",
      "trading",
      expect.objectContaining({ source: "deployment", login: LOGIN, accountId: "acc-1", positions: 2 })
    );

    // read-only: the read reached the platform, and no trade path did
    expect(platformStub.getPositions).toHaveBeenCalledTimes(1);
    expect(platformStub.previewOrder).not.toHaveBeenCalled();
    expect(platformStub.placeOrder).not.toHaveBeenCalled();
    expect(platformStub.placeOrderRemote).not.toHaveBeenCalled();
  });

  it("executes public_account against the broker and reports whose credential served it", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    const context = ctx(orm, env);

    const result = await McpToolFactory.getTool("public_account")!.execute({}, context);

    expect(result.provider).toBe("public");
    expect(result.provenance).toBe("live");
    expect(result.credentialSource).toBe("deployment");
    // the account the broker returned, and its buying power — not a guess
    expect(result.account.accountId).toBe("acc-1");
    expect(result.accounts).toHaveLength(1);
    expect(result.buyingPower).toBe(5000);

    expect(result.positions).toHaveLength(2);
    const aapl = result.positions.find((p: any) => p.symbol === "AAPL");
    expect(aapl).toMatchObject({ quantity: 10, pricePaid: 300, costBasis: 3000 });
    expect(aapl.totalGain).toBeCloseTo(423.7, 6);
    // Public omitted the average cost: the basis-derived fields are unknown,
    // not the whole market value reported as a gain
    const msft = result.positions.find((p: any) => p.symbol === "MSFT");
    expect(msft.costBasisKnown).toBe(false);
    expect(msft.pricePaid).toBeNull();
    expect(msft.costBasis).toBeNull();
    expect(msft.totalGain).toBeNull();
    expect(msft.totalGainPercent).toBeNull();

    // the audit row says whose balance was read
    expect(context.audit).toHaveBeenCalledWith(
      "public.account_read",
      "trading",
      expect.objectContaining({ source: "deployment", login: LOGIN, accountId: "acc-1", positions: 2 })
    );

    // read-only: the two account reads, and no preflight, placement or cancel
    const called = calls.filter((c) => c.method === "tools/call").map((c) => c.tool);
    expect(called.sort()).toEqual(["get_accounts", "get_portfolio"]);
  });

  it("names the user's own credential when a stored token wins", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    await storePublicPersonalToken(env, LOGIN, "personal-token-abcdef");
    const context = ctx(orm, env);

    const result = await McpToolFactory.getTool("public_account")!.execute({}, context);

    expect(result.credentialSource).toBe("user");
    expect(context.audit).toHaveBeenCalledWith(
      "public.account_read",
      "trading",
      expect.objectContaining({ source: "user" })
    );
  });

  it("refuses every trade tool when the only credential is the deployment key", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    const context = ctx(orm, env);

    const inputs: Record<string, Record<string, unknown>> = {
      public_preview_order: { symbol: "AAPL", quantity: 1, side: "buy", type: "market" },
      public_place_order: { orderId: "draft-from-another-path" },
      public_cancel_order: { order_id: "ord-1" },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const tool = McpToolFactory.getTool(name)!;
      await expect(tool.execute(input, context)).rejects.toThrow(/PUBLIC_DEPLOYMENT_CREDENTIAL_READ_ONLY/);
    }
    // nothing reached the broker: no preflight, no placement, no cancel
    expect(calls.filter((c) => c.method === "tools/call")).toEqual([]);
  });

  it("the platform seam refuses the deployment credential for the neutral broker routes too", async () => {
    const env = envWith({ PUBLIC_API_KEY: DEPLOYMENT });
    const platform = new PublicTradingPlatform(env, makeOrm(), LOGIN, "PROD");
    const refusal = /PUBLIC_DEPLOYMENT_CREDENTIAL_READ_ONLY/;
    await expect(
      platform.previewOrder({ symbol: "AAPL", quantity: 1, action: "BUY", orderType: "MARKET" } as any)
    ).rejects.toThrow(refusal);
    await expect(platform.executeOrder("draft-1", "did:test", "approved")).rejects.toThrow(refusal);
    await expect(platform.placeOrderRemote({ orderId: "draft-1", symbol: "AAPL", action: "BUY", quantity: 1 } as any)).rejects.toThrow(
      refusal
    );
    await expect(platform.cancelOrderRemote("ord-1")).rejects.toThrow(refusal);
  });
});

describe("Issue #4048 — the declaration surfaces the new tool touches", () => {
  it("registers public_account in the mesh family, the scope map and the attribution audit", () => {
    const family = MESH_TOOL_FAMILIES.find((entry: any) => entry.commands?.includes("public_get_quote"));
    expect(family, "the Public family is registered").toBeTruthy();
    expect(family!.commands).toContain("public_account");
    expect(MCP_TOOL_SCOPES["public_account"]).toBe("mcp:read");
    const audit = readFileSync("docs/architecture/security/tool-attribution-audit-1763.md", "utf8");
    expect(audit).toMatch(/^\| `public_account` \| mcp:read \|/m);
    // declared where the MCP surface is built, not only registered later
    const publicCommands = readFileSync("src/mcps/openaimp/publicCommands.ts", "utf8");
    expect(publicCommands).toMatch(/readonly name = "public_account"/);
  });
});

describe("Issue #4048 — the tool inventory accounts for itself", () => {
  const doc = readFileSync("docs/architecture/agentic/mcp-server-inventory.md", "utf8");

  function between(startHeading: string, endHeading: string): string {
    const start = doc.indexOf(startHeading);
    const end = doc.indexOf(endHeading, start + startHeading.length);
    if (start < 0 || end < 0) throw new Error(`section ${startHeading} not found`);
    return doc.slice(start, end);
  }

  it("the domain rows sum to the stated total, which is the scope map's size", () => {
    const body = between("### 2.1", "### 2.2");
    const rows = [...body.matchAll(/^\| ([^|]+?) \| (\d+) \|/gm)].map((m) => ({
      name: m[1].trim(),
      count: Number(m[2]),
    }));
    const stated = body.match(/^\| \*\*Total\*\* \| \*\*(\d+)\*\* \|/m);
    expect(rows.length).toBeGreaterThan(15);
    expect(stated, "the table states a total").not.toBeNull();
    const sum = rows.reduce((n, row) => n + row.count, 0);
    expect(sum).toBe(Number(stated![1]));
    expect(sum).toBe(Object.keys(MCP_TOOL_SCOPES).length);
  });

  it("the scope rows sum to the same total and each matches the scope map", () => {
    const body = between("### 2.2", "### 2.3");
    const rows = [...body.matchAll(/^\| `(mcp:[a-z]+)` \| (\d+) \|/gm)].map((m) => ({
      scope: m[1],
      count: Number(m[2]),
    }));
    expect(rows.length).toBeGreaterThan(0);
    const sum = rows.reduce((n, row) => n + row.count, 0);
    expect(sum).toBe(Object.keys(MCP_TOOL_SCOPES).length);
    for (const row of rows) {
      const actual = Object.values(MCP_TOOL_SCOPES).filter((scope) => scope === row.scope).length;
      expect(row.count, `scope ${row.scope}`).toBe(actual);
    }
  });

  it("the synchronous/queued split adds up to the tool count", () => {
    const body = between("### 2.3", "## 3.");
    const headings = body.match(/### 2\.3 Synchronous vs queued — (\d+) synchronous, (\d+) queued/);
    expect(headings, "the heading states both counts").not.toBeNull();
    const syncInBody = body.match(/\*\*(\d+) tools are synchronous\*\*/);
    const queuedInBody = body.match(/other \*\*(\d+) tools are queued\*\*/);
    expect(syncInBody).not.toBeNull();
    expect(queuedInBody).not.toBeNull();

    const sync = Object.keys(MCP_TOOL_SCOPES).filter((name) => isSynchronousMcpTool(name)).length;
    const total = Object.keys(MCP_TOOL_SCOPES).length;
    expect(Number(headings![1])).toBe(sync);
    expect(Number(headings![2])).toBe(total - sync);
    expect(Number(syncInBody![1])).toBe(sync);
    expect(Number(queuedInBody![1])).toBe(total - sync);
  });
});
