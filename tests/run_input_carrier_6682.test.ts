// @vitest-environment node
/**
 * Issue #6682 — one run-input carrier for all surfaces.
 *
 * Pins:
 *  - 6682-P01 the feed spec declares `symbols`; the binder normalizes a
 *    symbols list through the one normalizer (uppercase/trim/dedupe) and
 *    refuses an empty list, an undeclared input, and an unknown universe
 *    by name.
 *  - 6682-P02 the carrier binds dispatch inputs into an ephemeral spec
 *    definition whose feed.pull step params carry the bound inputs
 *    (explicit 5 symbols ⇒ the step requests those 5); a `sources`
 *    input resolves the registered feed job for that provider/dataset
 *    (broker-neutral source selection), and an unservable source
 *    refuses by name. Absent inputs ⇒ no carrier definition (the job's
 *    own definition runs, as today).
 *  - 6682-P03 the manual screen path carries form tickers: the request
 *    parser splits a `symbols` envelope, the spec carries it, and the
 *    workflow command's shard table carries a symbols shard — so
 *    feed.pull's explicitSymbolsFor sees the caller's list.
 *  - 6682-P04 the run_feed_job MCP command declares the same inputs
 *    (universe/symbols) in its schema — one input vocabulary per
 *    surface, no surface-local spelling.
 */
import { describe, expect, it } from "vitest";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { bindJobDefinitionParams } from "../src/services/jobDefinitionParamBinders";
import { buildFeedRunInputDefinition } from "../src/services/runInputCarrier";
import { parseStockScreenRequest } from "../src/trading/screeningSchemas";
import { buildStockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";
import { buildStockScreenWorkflowCommand } from "../src/workflows/screenExecutionBroker";
import { RunFeedJobCommand } from "../src/mcps/openaimp/feedJobCommands";

const FIVE = ["AAPL", "MSFT", "NVDA", "SPY", "QQQ"];

describe("6682-P01 feed spec symbols parameter", () => {
  it("declares symbols and binds it normalized", () => {
    const spec = jobDefinitionSpec("feed");
    expect(spec.parameters?.map((p) => p.name)).toContain("symbols");
    const bound = bindJobDefinitionParams(
      spec,
      { feedJobId: "alpaca-nasdaq100-quotes", symbols: ["aapl", " msft ", "AAPL", "nvda", "spy", "qqq"] },
      "owner@example.com",
    );
    expect(bound.symbols).toEqual(FIVE);
  });

  it("refuses an empty symbols list, an undeclared input, and an unknown universe by name", () => {
    const spec = jobDefinitionSpec("feed");
    expect(() =>
      bindJobDefinitionParams(spec, { feedJobId: "alpaca-nasdaq100-quotes", symbols: [] }, undefined),
    ).toThrow(/symbols/);
    expect(() =>
      bindJobDefinitionParams(spec, { feedJobId: "alpaca-nasdaq100-quotes", bogus: 1 }, undefined),
    ).toThrow(/bogus/);
    expect(() =>
      bindJobDefinitionParams(spec, { feedJobId: "alpaca-nasdaq100-quotes", universe: "nope" }, undefined),
    ).toThrow(/universe/);
  });
});

describe("6682-P02 dispatch carrier", () => {
  it("binds explicit symbols into the feed.pull step params", () => {
    const built = buildFeedRunInputDefinition("alpaca-nasdaq100-quotes", { symbols: FIVE }, "owner@example.com");
    expect(built).not.toBeNull();
    expect(built?.targetJobId).toBe("alpaca-nasdaq100-quotes");
    const step = (built?.config.root.steps as Array<Record<string, unknown>>)[0];
    const params = step.params as Record<string, unknown>;
    expect(params.feedJobId).toBe("alpaca-nasdaq100-quotes");
    expect(params.symbols).toEqual(FIVE);
  });

  it("resolves a sources input to the registered job for that provider", () => {
    const built = buildFeedRunInputDefinition(
      "alpaca-nasdaq100-quotes",
      { sources: ["yahoo"], symbols: FIVE },
      "owner@example.com",
    );
    expect(built?.targetJobId).toBe("yahoo-nasdaq100-quotes");
    const step = (built?.config.root.steps as Array<Record<string, unknown>>)[0];
    expect((step.params as Record<string, unknown>).feedJobId).toBe("yahoo-nasdaq100-quotes");
  });

  it("refuses an unservable source by name and returns null for absent inputs", () => {
    expect(() =>
      buildFeedRunInputDefinition("alpaca-nasdaq100-quotes", { sources: ["nasdaq"] }, undefined),
    ).toThrow(/nasdaq/);
    expect(buildFeedRunInputDefinition("alpaca-nasdaq100-quotes", {}, undefined)).toBeNull();
    expect(buildFeedRunInputDefinition("alpaca-nasdaq100-quotes", undefined, undefined)).toBeNull();
  });
});

describe("6682-P03 manual screen tickers reach the shard table", () => {
  it("parses a symbols envelope and builds a symbols shard", () => {
    const parsed = parseStockScreenRequest({ symbols: FIVE });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.symbols).toEqual(FIVE);
    expect(parsed.value.filters).not.toHaveProperty("symbols");

    const built = buildStockScreenRunSpec({
      env: {},
      method: "POST",
      rawFilters: { symbols: FIVE },
      query: new URLSearchParams(),
      asyncRequested: false,
      source: "market-data",
      provider: "alpaca",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.symbols).toEqual(FIVE);

    const command = buildStockScreenWorkflowCommand(built.spec, { userLogin: "owner@example.com" });
    expect(command.shards).toEqual([{ shardId: "symbols", symbols: FIVE }]);
  });
});

describe("6682-P04 run_feed_job declares the carrier inputs", () => {
  it("schema carries universe and symbols", () => {
    const cmd = new RunFeedJobCommand();
    const props = (cmd.jsonSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("universe");
    expect(props).toHaveProperty("symbols");
  });
});
