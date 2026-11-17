import { describe, expect, it, vi } from "vitest";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { handleBrokerOrderRoutes } from "../src/agents/routes/brokerOrders";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import type { Env } from "../src/types";

describe("Option exercise & assignment visibility (#4672)", () => {
  it("exerciseOptionPosition refuses empty symbol and missing credentials", async () => {
    const provider = new AlpacaMarketDataProvider({} as Env);
    const emptyRes = await provider.exerciseOptionPosition("   ");
    expect(emptyRes.success).toBe(false);
    expect(emptyRes.status).toBe("refused");

    const unconfigured = await provider.exerciseOptionPosition("AAPL261218C00200000");
    expect(unconfigured.success).toBe(false);
    expect(unconfigured.status).toBe("failed");
    expect(unconfigured.message).toMatch(/credentials/i);
  });

  it("exerciseOptionPosition submits POST /v2/positions/{id}/exercise and surfaces refusals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "position not eligible for exercise" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const env = {
        ALPACA_API_KEY: "test-key",
        ALPACA_SECRET_KEY: "test-secret",
        ALPACA_ENVIRONMENT: "paper",
      } as unknown as Env;
      const platform = new AlpacaTradingPlatform(env, undefined, "tester_4672");

      const ok = await platform.exerciseOption("AAPL261218C00200000");
      expect(ok.success).toBe(true);
      expect(ok.status).toBe("submitted");
      expect(ok.broker).toBe("alpaca");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/v2/positions/AAPL261218C00200000/exercise"),
        expect.objectContaining({ method: "POST" }),
      );

      const refused = await platform.exerciseOption("AAPL261218C00200000");
      expect(refused.success).toBe(false);
      expect(refused.status).toBe("refused");
      expect(refused.httpStatus).toBe(422);
      expect(refused.message).toContain("position not eligible for exercise");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("POST /broker/position/exercise enforces auth, validation, and broker capability", async () => {
    const ctx = (broker: string) => ({
      env: { BROKER_ID: broker } as unknown as Env,
      getOrm: () => undefined,
      readSettingRaw: () => broker,
    });

    const url = new URL("https://example.com/api/broker/position/exercise");
    const unauth = await handleBrokerOrderRoutes(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbolOrContractId: "AAPL261218C00200000" }),
      }),
      url,
      "/api/broker/position/exercise",
      "sess_4672",
      ctx("alpaca") as any,
    );
    expect(unauth?.status).toBe(401);

    const missingSymbol = await handleBrokerOrderRoutes(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "tester_4672" },
        body: JSON.stringify({}),
      }),
      url,
      "/api/broker/position/exercise",
      "sess_4672",
      ctx("alpaca") as any,
    );
    expect(missingSymbol?.status).toBe(400);

    const unsupported = await handleBrokerOrderRoutes(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "tester_4672" },
        body: JSON.stringify({ symbolOrContractId: "AAPL261218C00200000" }),
      }),
      url,
      "/api/broker/position/exercise",
      "sess_4672",
      ctx("etrade") as any,
    );
    expect(unsupported?.status).toBe(501);
    const body = (await unsupported?.json()) as { code?: string };
    expect(body.code).toBe("provider_unsupported");
  });

  it("registers alpaca_exercise_option MCP tool with mcp:trade permission", () => {
    const tool = McpToolFactory.getTool("alpaca_exercise_option");
    expect(tool).toBeDefined();
    expect(MCP_TOOL_SCOPES["alpaca_exercise_option"]).toBe("mcp:trade");
  });
});
