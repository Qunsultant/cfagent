/**
 * #5609 (G-7): premium prices via getApprovedPrice.
 *
 * Fail-closed pins for the premium catalogue:
 * 1. An APPROVED premium price resolves — through the REAL D1
 *    adapter (seeded PROPOSED rows, approved by an operator), never
 *    a fixture mock.
 * 2. PROPOSED-only refuses — the seeded premium rows are PROPOSED
 *    until an operator approves them; the resolver returns null.
 * 3. A missing entry refuses — no row, no price, null.
 * 4. No catalogue bound at all refuses — unbound env, null.
 * 5. The premium HTTP route refuses 503 PriceUnavailable on a null
 *    price (before any challenge is minted); with an approved price
 *    it challenges 402 at that price.
 * 6. The MCP paid tool refuses 503 PriceUnavailable on a null price;
 *    with an approved price it challenges 402 at that price.
 * 7. The NLQ async refusal shows the approved figure when one
 *    resolves, and omits it when none does.
 * 8. No TRADING_PAID_SERVICES price reads remain anywhere — the
 *    descriptor is price-less; the catalogue is the one price source.
 *
 * Seeds stay PROPOSED/approval-gated (Mars, 2026-11-20, comment
 * 7055099801): options-scan $5, market-research $10, stock-signals
 * $2. This file approves them only inside its own throwaway D1 —
 * that is test setup, not a live price approval.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createD1PriceCatalogueDb,
  D1PriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { getApprovedPremiumPrice } from "../src/data/createPriceCataloguePorts";
import { PROPOSED_SEED_PRICES } from "../src/data/priceCataloguePorts";
import { TRADING_PAID_SERVICES } from "../src/services/agenticPayments";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";
import { PaidOptionsScreenerCommand } from "../src/mcps/openaimp/agenticPaymentCommands";
import { executeNLQQueryAsync } from "../src/agents/nlq";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import { APPROVED_PREMIUM_PRICES } from "./premiumPriceCatalogueFixture";

const RECIPIENT = "0x71C8363837918a211797E3c76A8B3C4258759550";
const PREMIUM_FAMILIES = ["options-scan", "market-research", "stock-signals"] as const;

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

function baseEnv(extra: Record<string, unknown> = {}): Env {
  return {
    X402_NETWORK: "base-sepolia",
    X402_RECIPIENT_ADDRESS: RECIPIENT,
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    ...extra,
  } as unknown as Env;
}

/** A D1 whose seeded premium rows are PROPOSED (approved by nobody). */
async function proposedD1(): Promise<MockD1Database> {
  const mock = new MockD1Database();
  await ensurePriceCatalogueSchema(createD1PriceCatalogueDb(mock as unknown as D1Database));
  return mock;
}

/** A D1 whose premium rows were approved by a test operator. */
async function approvedD1(): Promise<MockD1Database> {
  const mock = await proposedD1();
  const catalogue = new D1PriceCatalogueAdapter(
    createD1PriceCatalogueDb(mock as unknown as D1Database),
  );
  for (const family of PREMIUM_FAMILIES) {
    await catalogue.approvePrice({ family, approverId: "test-operator" });
  }
  return mock;
}

describe("premium prices via getApprovedPrice (#5609, G-7)", () => {
  it("an APPROVED premium price resolves to the owner seed, per family", async () => {
    const env = baseEnv({ AGENT_DB: await approvedD1() });
    expect(await getApprovedPremiumPrice(env, "options-scan")).toBe(
      APPROVED_PREMIUM_PRICES["options-scan"],
    );
    expect(await getApprovedPremiumPrice(env, "market-research")).toBe(
      APPROVED_PREMIUM_PRICES["market-research"],
    );
    expect(await getApprovedPremiumPrice(env, "stock-signals")).toBe(
      APPROVED_PREMIUM_PRICES["stock-signals"],
    );
    // The approved price IS the seed — the seeds are the owner
    // decision (Mars, 2026-11-20), not a second constant.
    expect(APPROVED_PREMIUM_PRICES["options-scan"]).toBe(PROPOSED_SEED_PRICES["options-scan"]);
    expect(APPROVED_PREMIUM_PRICES["market-research"]).toBe(PROPOSED_SEED_PRICES["market-research"]);
    expect(APPROVED_PREMIUM_PRICES["stock-signals"]).toBe(PROPOSED_SEED_PRICES["stock-signals"]);
  });

  it("PROPOSED-only refuses: the seeded premium rows resolve to null until an operator approves them", async () => {
    const env = baseEnv({ AGENT_DB: await proposedD1() });
    for (const family of PREMIUM_FAMILIES) {
      expect(await getApprovedPremiumPrice(env, family)).toBeNull();
    }
  });

  it("a missing entry refuses: no catalogue row, no price", async () => {
    const catalogue = new InMemoryPriceCatalogueAdapter(
      { "options-scan": 5 },
      { approvedBy: "test-operator" },
    );
    expect(await catalogue.getApprovedPrice("options-scan")).toBe(5);
    expect(await catalogue.getApprovedPrice("market-research")).toBeNull();
    expect(await catalogue.getApprovedPrice("stock-signals")).toBeNull();
  });

  it("no catalogue bound at all refuses: an unbound env resolves to null", async () => {
    for (const family of PREMIUM_FAMILIES) {
      expect(await getApprovedPremiumPrice(baseEnv(), family)).toBeNull();
    }
  });

  it("the premium route refuses 503 PriceUnavailable on a null price — before any challenge is minted", async () => {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("premium-5609");
    const ctx = {
      env: baseEnv(),
      sql: new MockSqlStorage(),
      getOrm: () => orm,
      getScreenerAgent: () => ({}) as any,
      persistScreenerReportCanonical: vi.fn(),
    } as unknown as PremiumRouteContext;
    for (const path of ["/premium/options-scan", "/premium/market-research", "/premium/stock-signals"]) {
      const res = await handlePremiumRoutes(
        new Request(`https://agent.internal${path}`, { method: "GET" }),
        new URL(`https://agent.internal${path}`),
        path,
        "premium-5609",
        ctx,
      );
      expect(res?.status).toBe(503);
      const body = (await res!.json()) as any;
      expect(body.error).toBe("PriceUnavailable");
      expect(body.message).toMatch(/No approved price is set/);
    }
  });

  it("the premium route challenges 402 at the approved price once the price is approved", async () => {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("premium-5609");
    const ctx = {
      env: baseEnv({ AGENT_DB: await approvedD1() }),
      sql: new MockSqlStorage(),
      getOrm: () => orm,
      getScreenerAgent: () => ({}) as any,
      persistScreenerReportCanonical: vi.fn(),
    } as unknown as PremiumRouteContext;
    const res = await handlePremiumRoutes(
      new Request("https://agent.internal/premium/options-scan", { method: "GET" }),
      new URL("https://agent.internal/premium/options-scan"),
      "/premium/options-scan",
      "premium-5609",
      ctx,
    );
    expect(res?.status).toBe(402);
    const body = (await res!.json()) as any;
    expect(body.protocols.x402.challenge.amount).toBe(APPROVED_PREMIUM_PRICES["options-scan"]);
  });

  it("the MCP paid tool refuses 503 PriceUnavailable on a null price", async () => {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("premium-5609");
    const res = await new PaidOptionsScreenerCommand().execute(
      { underlying: "NVDA" },
      { env: baseEnv(), orm, sessionId: "mcp-5609", audit: vi.fn() },
    );
    expect(res.status).toBe(503);
    expect((res as any).error).toBe("PriceUnavailable");
    expect((res as any).challenge).toBeUndefined();
  });

  it("the MCP paid tool challenges 402 at the approved price once the price is approved", async () => {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("premium-5609");
    const res = await new PaidOptionsScreenerCommand().execute(
      { underlying: "NVDA" },
      { env: baseEnv({ AGENT_DB: await approvedD1() }), orm, sessionId: "mcp-5609", audit: vi.fn() },
    );
    expect(res.status).toBe(402);
    expect((res as any).paid).toBe(false);
    expect((res as any).priceUSD).toBe(APPROVED_PREMIUM_PRICES["options-scan"]);
    expect((res as any).challenge).toBeDefined();
  });

  it("the NLQ async refusal shows the approved figure when one resolves, and omits it when none does", async () => {
    const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const quoteTimestamp = Date.now();
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: {
        symbol: "NVDA",
        underlyingPrice: 100,
        selectedExpiry: {
          year: expiryDate.getUTCFullYear(),
          month: expiryDate.getUTCMonth() + 1,
          day: expiryDate.getUTCDate(),
        },
        pairs: [
          {
            call: {
              timeStamp: quoteTimestamp,
              adjustedFlag: false,
              optionType: "CALL",
              strikePrice: 100,
              symbol: "NVDATESTC100",
              bid: 2,
              ask: 2.2,
              lastPrice: 2.1,
              volume: 500,
              openInterest: 1000,
              delta: 0.52,
              impliedVolatility: 0.38,
            },
          },
        ],
      },
    });
    const plan = {
      domain: "agentic_payments" as const,
      operation: "create" as const,
      agenticPaymentsData: { action: "paid_scan" as const, symbol: "NVDA" },
      terms: "NVDA",
      role: "any" as const,
      since: null,
      limit: 10,
    };

    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("trader_session_1");
    const approved = await executeNLQQueryAsync(
      orm,
      "session_trader",
      plan,
      baseEnv({ AGENT_DB: await approvedD1() }),
      "session_trader",
    );
    expect(approved.status).toBe("error");
    expect(approved.summary).toContain(
      `Paid Options Screener ($${APPROVED_PREMIUM_PRICES["options-scan"].toFixed(2)} USDC)`,
    );

    const unapproved = await executeNLQQueryAsync(
      orm,
      "session_trader",
      plan,
      baseEnv(),
      "session_trader",
    );
    expect(unapproved.status).toBe("error");
    expect(unapproved.summary).toContain("Paid Options Screener at the approved catalogue price");
    expect(unapproved.summary).not.toMatch(/\(\$\d/);
  });

  it("no TRADING_PAID_SERVICES price reads remain — the descriptor is price-less, the catalogue is the one price source", () => {
    for (const def of [
      TRADING_PAID_SERVICES.OPTIONS_SCREENER,
      TRADING_PAID_SERVICES.MARKET_RESEARCH,
      TRADING_PAID_SERVICES.STOCK_SIGNALS,
    ]) {
      expect("priceUSD" in def).toBe(false);
      expect(def.resource).toMatch(/^\/api\/premium\//);
      expect(typeof def.rateLimitPerMin).toBe("number");
    }
    for (const file of [
      "src/agents/routes/premium.ts",
      "src/mcps/openaimp/agenticPaymentCommands.ts",
      "src/agents/nlq/execution.ts",
      "src/services/agenticPayments.ts",
      "src/data/productCatalogue.ts",
      "src/data/productAccess.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/TRADING_PAID_SERVICES\.\w+\.priceUSD/);
    }
  });
});
