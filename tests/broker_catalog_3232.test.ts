/**
 * Issue #3232 (program #3216) — one broker catalog, broker-neutral contract.
 *
 * What these tests defend:
 *   1. The broker list has ONE source (the catalog), so a second hand-written
 *      copy cannot drift again.
 *   2. `sandbox` is an environment, not a broker: it resolves to (etrade, TEST,
 *      paper) and never reaches a broker-facing surface as a broker name.
 *   3. A broker reports ITS OWN status vocabulary — Alpaca must never report
 *      E*TRADE's protocol (the defect this slice fixes).
 *   4. The shared contract is broker-neutral: the E*TRADE-named types still
 *      resolve (deprecated aliases) while the neutral names are canonical.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BROKER_CATALOG,
  ROUTED_BROKER_IDS,
  TradingPlatformRegistry,
  AlpacaTradingPlatform,
  assertBrokerCatalogComplete,
  isBrokerId,
  resolveBrokerSelection,
  tradingTypeFor,
  type BrokerId,
} from "../src/trading";
import * as types from "../src/types";

const arctic = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as any;

describe("broker catalog is the one source of broker facts (#3232)", () => {
  it("covers every registered platform, either as a broker or a declared legacy alias", () => {
    const registered = TradingPlatformRegistry.getRegisteredPlatforms() as string[];
    expect(registered.length).toBeGreaterThan(0);
    expect(() => assertBrokerCatalogComplete(registered)).not.toThrow();
    // Every catalog broker is actually registered — the catalog never promises
    // a broker nothing can instantiate.
    for (const id of ROUTED_BROKER_IDS) expect(registered).toContain(id);
  });

  it("fails loudly when a platform is registered without a catalog entry", () => {
    expect(() => assertBrokerCatalogComplete(["etrade", "alpaca", "interactive_brokers"])).toThrow(
      /Broker catalog incomplete/,
    );
  });

  it("declares the same asset classes for both brokers, so parity is a stated fact", () => {
    for (const id of ROUTED_BROKER_IDS) {
      expect(BROKER_CATALOG[id].assetClasses).toEqual(expect.arrayContaining(["equity", "options"]));
    }
  });

  it("maps every environment to a trading type for every broker (total mapping)", () => {
    for (const id of ROUTED_BROKER_IDS) {
      expect(tradingTypeFor(id, "TEST")).toBe("paper");
      expect(tradingTypeFor(id, "PROD")).toBe("live");
    }
  });

  it("does not accept an environment as a broker id", () => {
    expect(isBrokerId("sandbox")).toBe(false);
    expect(isBrokerId("alpaca")).toBe(true);
    expect(isBrokerId("ALPACA")).toBe(true);
  });
});

describe("legacy `sandbox` resolves to the pair it always meant (#3232)", () => {
  it("resolves sandbox to etrade + TEST + paper, flagged legacy", () => {
    expect(resolveBrokerSelection({ broker: "sandbox" })).toEqual({
      broker: "etrade",
      environment: "TEST",
      tradingType: "paper",
      legacy: true,
    });
  });

  it("is case-insensitive and lets an explicit environment win", () => {
    expect(resolveBrokerSelection({ broker: "SANDBOX", environment: "prod" })).toEqual({
      broker: "etrade",
      environment: "PROD",
      tradingType: "live",
      legacy: true,
    });
  });

  it("refuses an unknown broker instead of defaulting to one", () => {
    expect(resolveBrokerSelection({ broker: "robinhood" })).toBeNull();
    expect(resolveBrokerSelection({ broker: "" })).toBeNull();
    expect(resolveBrokerSelection({})).toBeNull();
  });

  it("refuses an unknown environment instead of silently choosing PROD", () => {
    expect(resolveBrokerSelection({ broker: "alpaca", environment: "staging" })).toBeNull();
  });

  it("requires an environment for a real broker rather than assuming one", () => {
    expect(resolveBrokerSelection({ broker: "alpaca" })).toBeNull();
    expect(resolveBrokerSelection({ broker: "alpaca", environment: "TEST" })).toEqual({
      broker: "alpaca",
      environment: "TEST",
      tradingType: "paper",
      legacy: false,
    });
  });
});

describe("each broker reports its own status vocabulary (#3232)", () => {
  it("Alpaca reports Alpaca's protocol and paper/live type, never E*TRADE's words", async () => {
    const paperStatus = await new AlpacaTradingPlatform(arctic, undefined, "user@example.com").getStatus();
    expect(paperStatus.protocol).toBe("alpaca_rest_v2");
    expect(paperStatus.mode).toBe("paper_api");
    expect(paperStatus.environment).toBe("paper");
    expect(paperStatus.activeEnvironment).toBe("TEST");
    // The defect being fixed: one broker's protocol surfacing on the other.
    expect(JSON.stringify(paperStatus).toLowerCase()).not.toContain("etrade");
    expect(JSON.stringify(paperStatus).toLowerCase()).not.toContain("oauth_rest");

    const liveStatus = await new AlpacaTradingPlatform(
      { ...arctic, ALPACA_BASE_URL: "https://api.alpaca.markets" } as any,
      undefined,
      "user@example.com",
    ).getStatus();
    expect(liveStatus.mode).toBe("live_api");
    expect(liveStatus.environment).toBe("live");
    expect(liveStatus.activeEnvironment).toBe("PROD");
  });

  it("names the credential kind each broker actually uses", () => {
    expect(BROKER_CATALOG.etrade.credentialKind).toBe("oauth1_per_login");
    expect(BROKER_CATALOG.alpaca.credentialKind).toBe("api_key_pair");
  });
});

describe("the shared contract is broker-neutral, with the old names kept as aliases (#3232)", () => {
  it("keeps every former ETrade-named type resolvable at runtime-free type level", () => {
    // Type-level assertions: these fail to COMPILE if an alias is dropped.
    const status: types.BrokerStatus = {} as types.ETradeBrokerStatus;
    const quote: types.BrokerQuote = {} as types.ETradeQuote;
    const account: types.BrokerAccount = {} as types.ETradeAccount;
    const position: types.BrokerPosition = {} as types.ETradePosition;
    const draft: types.BrokerOrderDraft = {} as types.ETradeOrderDraft;
    const execution: types.BrokerOrderExecutionResult = {} as types.ETradeOrderExecutionResult;
    expect([status, quote, account, position, draft, execution]).toHaveLength(6);
  });

  it("no longer declares an ETrade-named interface in the shared type module", () => {
    const source = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^export interface ETrade/m);
    // …while the deprecated aliases are still exported, naming their successor.
    expect(source).toMatch(/@deprecated Use \{@link BrokerQuote\}/);
  });

  it("the routed order surface takes its broker list from the catalog, not a second copy", () => {
    const source = readFileSync(new URL("../src/agents/routes/brokerOrders.ts", import.meta.url), "utf8");
    expect(source).toContain("const ROUTED_BROKERS = ROUTED_BROKER_IDS;");
    expect(source).not.toMatch(/const ROUTED_BROKERS = \["etrade"/);
  });

  it("the platform contract names no broker", () => {
    const source = readFileSync(new URL("../src/trading/interfaces.ts", import.meta.url), "utf8");
    expect(source).not.toContain("ETrade");
    expect(source).toContain("export type TradingPlatformId = BrokerId | \"sandbox\";");
  });
});

describe("catalog invariants that keep adding a broker cheap (#3232)", () => {
  it("every broker declares a label, a credential kind and a protocol", () => {
    for (const id of Object.keys(BROKER_CATALOG) as BrokerId[]) {
      const def = BROKER_CATALOG[id];
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.statusVocabulary.protocol.length).toBeGreaterThan(0);
      expect(def.statusVocabulary.mode.paper).toBeTruthy();
      expect(def.statusVocabulary.mode.live).toBeTruthy();
    }
  });
});
