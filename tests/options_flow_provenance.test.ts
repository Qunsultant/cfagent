import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// src/server.ts re-exports the agent classes, whose real module graph pulls
// in `cloudflare:` protocol imports the node test loader cannot resolve.
// Mock the agent SDK entry points with plain stand-ins (same pattern as
// tests/schedules_create_route.test.ts); the /api/options/flows routes under
// test never touch them.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  // Issue #199: src/server.ts re-exports PaymentsAgent/ScheduledAgent,
  // which `extend Agent` when the module loads — the stub must be an
  // extendable class, otherwise `extends undefined` throws at import time.
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { makeFakeSessionStore } from "./fake-session-store";
import {
  RAW_LIVE_FLOW_ITEMS,
  FLOW_PROVENANCE_NOTICE,
  calculateFlowSummary,
  convertOptionChainToFlowItems,
  describeFlowProvenance,
  generateDynamicFlowUniverse,
  summarizeFlowProvenance,
} from "../src/trading/options/flows/flowService";
import type { LiveFlowItem } from "../src/trading/options/flows/types";
import type { ETradeOptionChain } from "../src/types";
import worker from "../src/server";

/**
 * Issue #119 (audit F17/F18): the options flow service has no trade-tape
 * source. Every item must carry a provenance that cannot be mistaken for a
 * real executed print, every surface must disclose the modelled basis, and
 * the fabricated RAW_NEWS_FLOW_ITEMS wire must stay deleted.
 */

// #1754: /api/options/flows/* is session-gated. These envelope pins
// keep every assertion and only gain a session: the envelope behavior
// under test is unchanged, the caller is now authenticated.
const FLOWS_SESSION_ID = "0d9a1754-1c2b-4e3f-8a5b-119000000001";
function authedFlowsRequest(path: string) {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", FLOWS_SESSION_ID, { githubLogin: "octocat-119", userLogin: "octocat-119" });
  return {
    request: new Request(`https://agent.test${path}`, {
      headers: { Cookie: `session_id=${FLOWS_SESSION_ID}` },
    }),
    env: { SESSION_STORE: sessionStoreNs } as any,
  };
}

const mockChain: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 125.5,
  selectedExpiry: { year: 2026, month: 11, day: 20 },
  pairs: [
    {
      call: {
        symbol: "NVDA",
        optionType: "CALL",
        strikePrice: 130,
        lastPrice: 4.5,
        bid: 4.3,
        ask: 4.4,
        volume: 2500,
        openInterest: 1000,
        delta: 0.45,
      },
      put: {
        symbol: "NVDA",
        optionType: "PUT",
        strikePrice: 120,
        lastPrice: 2.2,
        bid: 2.1,
        ask: 2.15,
        volume: 350,
        openInterest: 500,
        delta: -0.35,
      },
    },
  ],
};

const PROVENANCE_VOCABULARY = ["chain-derived", "static", "generated"];

describe("Issue #119 — flow item provenance", () => {
  it("stamps chain-converted items as chain-derived, never as live prints", () => {
    const items = convertOptionChainToFlowItems(mockChain);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.provenance).toBe("chain-derived");
      expect(PROVENANCE_VOCABULARY).toContain(item.provenance);
    }
  });

  it("stamps the generated fallback universe as generated", () => {
    const items = generateDynamicFlowUniverse({ symbols: ["NVDA", "AAPL"] });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.provenance === "generated")).toBe(true);
  });

  it("stamps the static fixture table as static", () => {
    expect(RAW_LIVE_FLOW_ITEMS.length).toBeGreaterThan(0);
    expect(RAW_LIVE_FLOW_ITEMS.every((i) => i.provenance === "static")).toBe(true);
  });

  it("summarizeFlowProvenance counts a mixed set and always discloses the modelled basis", () => {
    const mixed: LiveFlowItem[] = [
      ...convertOptionChainToFlowItems(mockChain),
      ...generateDynamicFlowUniverse({ symbols: ["NVDA"] }),
      RAW_LIVE_FLOW_ITEMS[0],
    ];
    const summary = summarizeFlowProvenance(mixed);
    expect(summary.isModelled).toBe(true);
    expect(summary.notice).toBe(FLOW_PROVENANCE_NOTICE);
    expect(summary.notice).toContain("not a live exchange trade tape");
    expect(summary.provenances.sort()).toEqual(["chain-derived", "generated", "static"]);
    const total =
      summary.counts["chain-derived"] + summary.counts.generated + summary.counts.static;
    expect(total).toBe(mixed.length);
    expect(summary.counts.generated).toBeGreaterThan(0);
    expect(summary.counts.static).toBe(1);
  });

  it("describeFlowProvenance states the basis in words and never claims executions", () => {
    const chainOnly = describeFlowProvenance(convertOptionChainToFlowItems(mockChain));
    expect(chainOnly).toContain("chain-derived from option-chain snapshots");
    expect(chainOnly).toContain("not executed trade prints");

    const withGenerated = describeFlowProvenance([
      ...convertOptionChainToFlowItems(mockChain),
      ...generateDynamicFlowUniverse({ symbols: ["NVDA"] }),
    ]);
    expect(withGenerated).toContain("generated sample items");

    expect(describeFlowProvenance([])).toContain("no flow items were available");
  });

  it("calculateFlowSummary carries the provenance of its input items", () => {
    const items = generateDynamicFlowUniverse({ symbols: ["NVDA"] });
    const summary = calculateFlowSummary(items);
    expect(summary.provenance.isModelled).toBe(true);
    expect(summary.provenance.provenances).toEqual(["generated"]);
    expect(summary.provenance.counts.generated).toBe(items.length);
  });
});

describe("Issue #119 — /api/options/flows route envelopes disclose provenance", () => {
  // Issue #925 pin update (same PR, not a deletion): this test previously
  // asserted the forbidden behaviour — that an unknown ticker yields the
  // generated sample universe. Under #925 the PROD failure path returns
  // empty + an explicit unavailable state instead, so the pin now asserts
  // exactly that, keeping the envelope provenance assertions.
  it("GET /live with all sources failing returns empty + dataUnavailable, never generated samples (issue #925)", async () => {
    const { request, env } = authedFlowsRequest("/api/options/flows/live?tickers=ZZZUNKNOWN");
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.flows)).toBe(true);
    expect(body.flows).toEqual([]);
    expect(body.dataUnavailable).toBe(true);
    expect(typeof body.unavailableReason).toBe("string");
    for (const item of body.flows) {
      expect(PROVENANCE_VOCABULARY).toContain(item.provenance);
    }
    expect(body.provenance).toBeDefined();
    expect(body.provenance.isModelled).toBe(true);
    expect(body.provenance.notice).toContain("not a live exchange trade tape");
    const counted =
      body.provenance.counts["chain-derived"] +
      body.provenance.counts.generated +
      body.provenance.counts.static;
    expect(counted).toBe(body.flows.length);
  }, 30000);

  it("GET /historical discloses that no historical tape exists", async () => {
    const { request, env } = authedFlowsRequest("/api/options/flows/historical?tickers=ZZZUNKNOWN");
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.provenance?.isModelled).toBe(true);
    expect(body.note).toContain("No historical options trade tape");
  }, 30000);
});

describe("Issue #119 — fabricated news wire stays deleted (source pins)", () => {
  const flowServiceSrc = readFileSync("src/trading/options/flows/flowService.ts", "utf8");
  // Slice 5 of Qunsultant/cfagent#2902 (2026-11-05): the options-flows
  // block moved verbatim from src/server.ts to
  // src/server/routes/trading.ts; the entry surface is server.ts +
  // routes/*.ts, so the pin reads both files.
  const serverSrc =
    readFileSync("src/server.ts", "utf8") +
    readFileSync("src/server/routes/trading.ts", "utf8");
  // Issue #399: nlq.ts was decomposed into src/agents/nlq/* modules; the
  // flow-answer prose now lives in the execution module. The barrel
  // src/agents/nlq.ts only re-exports.
  const nlqSrc = readFileSync("src/agents/nlq/execution.ts", "utf8");

  it("flowService.ts contains no fake news wire and no fabricated outlet attributions", () => {
    expect(flowServiceSrc).not.toContain("RAW_NEWS_FLOW_ITEMS");
    expect(flowServiceSrc).not.toContain("Bloomberg");
    expect(flowServiceSrc).not.toContain("Reuters");
    expect(flowServiceSrc).not.toContain("Wall Street Journal");
    // The generated-universe doc comment must not promise authenticity again.
    expect(flowServiceSrc).not.toContain("authentic execution points");
  });

  it("the server entry no longer imports the deleted news wire and stamps route provenance", () => {
    expect(serverSrc).not.toContain("RAW_NEWS_FLOW_ITEMS");
    expect(serverSrc).toContain("summarizeFlowProvenance(flows)");
  });

  it("NLQ flow answers state the modelled basis instead of claiming prints", () => {
    expect(nlqSrc).not.toContain("dynamic institutional prints");
    expect(nlqSrc).toContain("describeFlowProvenance(filtered)");
    expect(nlqSrc).toContain("no live options trade tape");
  });
});

describe("Issue #131 — fabricated insider/congress fixture tables stay deleted (source pins)", () => {
  const flowServiceSrc = readFileSync("src/trading/options/flows/flowService.ts", "utf8");
  // Slice 5 of Qunsultant/cfagent#2902 (2026-11-05): as above, the
  // entry surface is server.ts + src/server/routes/trading.ts.
  const serverSrc =
    readFileSync("src/server.ts", "utf8") +
    readFileSync("src/server/routes/trading.ts", "utf8");

  // Every TypeScript source under src/, concatenated — the fabricated
  // tables and the people invented for them must not resurface anywhere.
  const srcTree = (readdirSync("src", { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => readFileSync(`src/${f}`, "utf8"))
    .join("\n");

  it("the dormant table identifiers are gone from flowService, server, and all of src/", () => {
    expect(flowServiceSrc).not.toContain("RAW_INSIDER_FLOW_ITEMS");
    expect(flowServiceSrc).not.toContain("RAW_CONGRESS_FLOW_ITEMS");
    expect(serverSrc).not.toContain("RAW_INSIDER_FLOW_ITEMS");
    expect(serverSrc).not.toContain("RAW_CONGRESS_FLOW_ITEMS");
    expect(srcTree).not.toContain("RAW_INSIDER_FLOW_ITEMS");
    expect(srcTree).not.toContain("RAW_CONGRESS_FLOW_ITEMS");
  });

  it("no fabricated insider trade is attributed to a named real executive in src/", () => {
    const fabricatedExecutives = [
      "Angela A Korch",
      "Lynanne Kunkel",
      "Robert A Katz",
      "Gregory Jon Sullivan",
      "Julie A DeCecco",
      "Celeste Burgoyne",
      "Jensen Huang",
      "Vaibhav Taneja",
      "Arthur D Levinson",
    ];
    for (const name of fabricatedExecutives) {
      expect(srcTree).not.toContain(name);
    }
  });

  it("no fabricated congressional trade is attributed to a named real politician in src/", () => {
    const fabricatedPoliticians = [
      "Nancy Pelosi",
      "Michael McCaul",
      "Ro Khanna",
      "Tommy Tuberville",
      "Dan Goldman",
      "Markwayne Mullin",
    ];
    for (const name of fabricatedPoliticians) {
      expect(srcTree).not.toContain(name);
    }
  });

  it("the insider/congress routes still run on the real fetchers, not fixture data", () => {
    expect(serverSrc).toContain("fetchRealSecInsiderFilings");
    expect(serverSrc).toContain("fetchRealCongressDisclosures");
  });
});
