import { describe, it, expect, vi, beforeEach } from "vitest";
// Issue #1953: ResearchAgent is a PortThink now — mock the
// Think-coupled adapter module with a plain base class (the
// api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader. The agents
// mock this replaced served the same purpose pre-migration.
vi.mock("../src/actors/thinkAdapter", () => {
  return {
    PortThink: class MockPortThink {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { ResearchAgent } from "../src/agents/research-agent";
import type { ResearchReport } from "../src/services/researchPipeline";

/**
 * #336: pre-entry refresh + delivery contract.
 */

const mockGetQuote = vi.fn();

vi.mock("../src/services/researchProviders", () => ({
  PlatformResearchDataProvider: class {
    getQuote = mockGetQuote;
  },
}));

function fixtureReport(): ResearchReport {
  return {
    runId: "run-336",
    generationId: "gen-1",
    trigger: "scheduled",
    userLogin: "tester",
    createdAt: "2026-10-20T12:00:00.000Z",
    rulesVersion: "v1",
    configSnapshot: {} as any,
    regime: { regime: "chop", notes: [], asOf: 0 },
    summary: "s",
    ideas: [
      {
        rank: 1,
        symbol: "AVGO",
        entrySpot: 300,
        score: 28,
      } as any,
      {
        rank: 2,
        symbol: "STALE",
        entrySpot: 100,
        score: 25,
      } as any,
    ],
    watchlist: [],
    rejected: [],
    stats: {} as any,
    oodaTrace: [],
  };
}

function makeAgent(): ResearchAgent {
  const agent = Object.create(ResearchAgent.prototype) as ResearchAgent;
  (agent as any).env = {};
  (agent as any).ctx = { storage: { get: async () => null, put: async () => {} } };
  return agent;
}

describe("#336 pre-entry refresh", () => {
  beforeEach(() => {
    mockGetQuote.mockReset();
  });

  it("flags ideas that moved >=2% since entry", async () => {
    mockGetQuote.mockImplementation(async (symbol: string) =>
      symbol === "AVGO" ? { price: 307.5 } : { price: 100 }
    );
    const flags = await makeAgent().refreshIdeaQuotes(fixtureReport(), "tester");
    expect(flags).toHaveLength(1);
    expect(flags[0].symbol).toBe("AVGO");
    expect(flags[0].status).toBe("moved");
    expect(flags[0].detail).toContain("2.50%");
  });

  it("flags ideas with no live quote as stale", async () => {
    mockGetQuote.mockImplementation(async (symbol: string) =>
      symbol === "AVGO" ? { price: 300 } : null
    );
    const flags = await makeAgent().refreshIdeaQuotes(fixtureReport(), "tester");
    expect(flags).toHaveLength(1);
    expect(flags[0].symbol).toBe("STALE");
    expect(flags[0].status).toBe("stale");
  });

  it("returns no flags when nothing moved", async () => {
    mockGetQuote.mockImplementation(async (symbol: string) =>
      symbol === "AVGO" ? { price: 301 } : { price: 100.5 }
    );
    const flags = await makeAgent().refreshIdeaQuotes(fixtureReport(), "tester");
    expect(flags).toHaveLength(0);
  });

  it("never throws when the provider fails", async () => {
    mockGetQuote.mockRejectedValue(new Error("boom"));
    const flags = await makeAgent().refreshIdeaQuotes(fixtureReport(), "tester");
    // Provider throw per-symbol is caught inside; all ideas flag as stale
    // rather than the refresh failing.
    expect(flags.length).toBe(2);
    expect(flags.every((f) => f.status === "stale")).toBe(true);
  });
});
