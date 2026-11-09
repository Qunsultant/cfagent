/**
 * Issue #3873 — `alpaca_place_order` advertised `quantity` and then ignored it.
 *
 * The transcript's failure: “place a 1 market buy order for msft” →
 * “qty is not recognized despite quantity:1”. The tool's zod schema made `qty`
 * required and its MCP normalizer copied the input verbatim, so a caller using
 * the documented alias — the spelling the REST paths accept — lost the size.
 *
 * These pins fail on the pre-fix tree: `quantity` alone is rejected, and
 * `orderAction`/`orderType`/`limitPrice` are silently dropped in MCP mode.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const storedPair = vi.hoisted(() => ({ record: null as null | { keyId: string; secretKey: string } }));
vi.mock("../src/trading/alpaca/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trading/alpaca/credentialStore")>();
  return { ...actual, getAlpacaCredentials: async () => storedPair.record };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { AlpacaPlaceOrderCommand } from "../src/mcps/openaimp/marketDataCommands";
import { normalizeMarketDataOrderInput } from "../src/config/marketDataModes";
import type { Env } from "../src/types";

const KEY_ID = ["PK", "TEST"].join("");
const SECRET = ["SK", "TEST"].join("");

const PAPER_ENV = {
  ALPACA_API_KEY_ID: KEY_ID,
  ALPACA_API_SECRET_KEY: SECRET,
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as unknown as Env;

function makeOrm(sessionId: string): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(sessionId);
  return orm;
}

function mcpContext(orm: DatabaseORM, env: Env): any {
  return { env, orm, sessionId: "sess_3873", audit: () => {} };
}

type FetchCall = { url: string; init: any };

/** An accepted paper order: no fill claimed, only an id and status. */
function installFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        id: "order_3873",
        client_order_id: "client_3873",
        symbol: "MSFT",
        qty: "1",
        side: "buy",
        type: "market",
        status: "accepted",
        time_in_force: "day",
        submitted_at: "2026-11-09T15:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alpaca_place_order accepts quantity (#3873)", () => {
  it("places the stated size when only `quantity` is sent", async () => {
    const calls = installFetch();
    const orm = makeOrm("sess_3873");
    const command = new AlpacaPlaceOrderCommand();

    const result: any = await command.execute(
      { symbol: "MSFT", quantity: 1, side: "buy", type: "market" } as any,
      mcpContext(orm, PAPER_ENV),
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body);
    // Alpaca accepts a numeric or string size; the shape is what this pins.
    expect(String(body.qty)).toBe("1");
    expect(body.symbol).toBe("MSFT");
    expect(body.side).toBe("buy");
  });

  it("prefers qty when both spellings are sent", () => {
    const normalized = normalizeMarketDataOrderInput(
      { symbol: "MSFT", qty: 3, quantity: 1, side: "buy", type: "market" } as any,
      "mcp",
    );
    expect(normalized.qty).toBe(3);
  });

  it("names both accepted keys when neither is sent", async () => {
    installFetch();
    const orm = makeOrm("sess_3873");
    const command = new AlpacaPlaceOrderCommand();

    const result: any = await command.execute(
      { symbol: "MSFT", side: "buy", type: "market" } as any,
      mcpContext(orm, PAPER_ENV),
    );

    expect(result.success).toBe(false);
    expect(result.refusal).toBe("quantity_required");
    expect(result.message).toContain("qty");
    expect(result.message).toContain("quantity");
  });

  it("honours the side/type/limit aliases in MCP mode", () => {
    const normalized = normalizeMarketDataOrderInput(
      {
        symbol: "MSFT",
        quantity: 2,
        orderAction: "sell",
        orderType: "limit",
        limitPrice: 410.5,
      } as any,
      "mcp",
    );
    expect(normalized).toMatchObject({ qty: 2, side: "sell", type: "limit", limit_price: 410.5 });
  });

  it("the published schema no longer forces `qty`", () => {
    const command = new AlpacaPlaceOrderCommand();
    const schema = command.jsonSchema as any;
    expect(schema.required).not.toContain("qty");
    expect(schema.required).toContain("symbol");
    expect(schema.required).toContain("side");
    expect(schema.properties.quantity.description).not.toMatch(/ignored/i);
    expect(command.zodSchema.safeParse({ symbol: "MSFT", quantity: 1, side: "buy" }).success).toBe(true);
  });
});
