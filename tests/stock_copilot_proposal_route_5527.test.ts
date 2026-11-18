/**
 * Issue #5527 — the introspection panel can file a governed proposal.
 *
 * The dispatch exists since #5057 (MCP `stock_copilot_introspect` with
 * `fileProposalGapId` + `approveProposalFiling`), but the browser cannot call
 * MCP. This adds the HTTP path the panel uses, with the same gate: no
 * `approve: true`, no filing; no token, a coded 503; unknown gap, a coded 404.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleStockCopilotRoutes,
  type StockCopilotRouteContext,
} from "../src/agents/routes/stockCopilot";

function sqlStub() {
  return {
    exec: (query: string) => {
      // DDL and writes are no-ops; every read is empty.
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) return [];
      return [];
    },
  } as any;
}

function ctx(overrides: Partial<StockCopilotRouteContext> = {}) {
  return {
    env: {} as any,
    sql: sqlStub(),
    getScreenerExecutionContext: async () => ({
      userLogin: "trader1",
      email: "trader@example.com",
    }),
    readSettingRaw: () => null,
    audit: () => {},
    ...overrides,
  } as unknown as StockCopilotRouteContext;
}

function post(body: unknown) {
  return new Request("https://agent.internal/api/stock-copilot/proposals/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PATH = "/api/stock-copilot/proposals/file";

describe("Issue #5527 — proposal filing route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses without an explicit approval", async () => {
    const res = await handleStockCopilotRoutes(
      post({ gapId: "GAP_STATIC_UNIVERSE_BOTTLENECK" }),
      new URL("https://agent.internal" + PATH),
      PATH,
      "session-1",
      ctx(),
    );

    expect(res!.status).toBe(400);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("COPILOT_PROPOSAL_APPROVAL_REQUIRED");
  });

  it("refuses an unknown gap id", async () => {
    const res = await handleStockCopilotRoutes(
      post({ gapId: "GAP_DOES_NOT_EXIST", approve: true }),
      new URL("https://agent.internal" + PATH),
      PATH,
      "session-1",
      ctx(),
    );

    expect(res!.status).toBe(404);
    expect(((await res!.json()) as any).code).toBe("COPILOT_PROPOSAL_NOT_FOUND");
  });

  it("refuses with the filer code when no token is configured", async () => {
    const res = await handleStockCopilotRoutes(
      post({ gapId: "GAP_STATIC_UNIVERSE_BOTTLENECK", approve: true }),
      new URL("https://agent.internal" + PATH),
      PATH,
      "session-1",
      ctx(),
    );

    expect(res!.status).toBe(503);
    expect(((await res!.json()) as any).code).toBe(
      "COPILOT_PROPOSAL_FILER_UNAVAILABLE",
    );
  });

  it("files through GitHub when approved and a token is configured", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(String(url));
      return new Response(
        JSON.stringify({ number: 6001, html_url: "https://github.com/o/r/issues/6001" }),
        { status: 201 },
      );
    });

    const res = await handleStockCopilotRoutes(
      post({ gapId: "GAP_STATIC_UNIVERSE_BOTTLENECK", approve: true }),
      new URL("https://agent.internal" + PATH),
      PATH,
      "session-1",
      ctx({ env: { GITHUB_ISSUE_TOKEN: "tok", GITHUB_ISSUE_REPO: "o/r" } as any }),
    );

    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.filed.number).toBe(6001);
    expect(body.filed.gapId).toBe("GAP_STATIC_UNIVERSE_BOTTLENECK");
    expect(requests[0]).toContain("api.github.com/repos/o/r/issues");
  });

  it("leaves every other path alone", async () => {
    const res = await handleStockCopilotRoutes(
      new Request("https://agent.internal/api/other", { method: "POST" }),
      new URL("https://agent.internal/api/other"),
      "/api/other",
      "session-1",
      ctx(),
    );
    expect(res).toBeNull();
  });
});
