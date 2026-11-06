/**
 * Issue #3323 — POST /search/ai-agent: the Search hub's door onto the
 * REAL AiSearchAgent.
 *
 * Before this slice the hub's "Search Agent" tab (POST /search/agent)
 * called AiSearchInstanceService directly — no hub surface ever reached
 * the AiSearchAgent. This route dispatches to the agent through the
 * AI_SEARCH_AGENT Durable Object binding on the fixed service
 * instance "aisearch", mirroring AISearchAgentSearchCommand.execute
 * (#2250): the same binding resolution, the same instance, the same
 * answer shaping — with the ROUTE's session login threaded as
 * callerLogin so the agent's #2246 discipline serves report-type
 * results only to their owner.
 *
 * Red honesty: on the pristine tree the route does not exist, so
 * handleSearchHubRoutes falls through (null) for /search/ai-agent
 * and every pin below that expects a response fails at assertion.
 *
 * Pins:
 * - 401 unauthenticated (the shared routeIdentity response);
 * - the DO stub is resolved on "aisearch" and receives the ROUTE's
 *   session login as callerLogin — a login smuggled into the request
 *   BODY is never used (the body schema carries no login field);
 * - the agent's typed result passes through unaltered: result rows
 *   keep every chunk field (bucketKey / servedFileLink /
 *   indexingState provenance included), the serving `path` label and
 *   the `degraded` note ride along verbatim, failure answers keep
 *   their code / errorToken / error;
 * - binding absent or misshapen -> the honest not_configured answer
 *   (ok:false, zero results, nothing fabricated), HTTP 200 in-band
 *   like the sibling /search/agent degraded contract;
 * - empty query -> 400; wrong method / unknown path -> null.
 */
import { describe, it, expect } from "vitest";
import { handleSearchHubRoutes } from "../src/agents/routes/searchHub";
import type { AiSearchAgentSearchResult } from "../src/agents/aiSearchPaths";

const SERVICE_INSTANCE = "aisearch";
const SESSION_LOGIN = "alice";

interface SearchCall {
  query: string;
  opts: { callerLogin?: string; limit?: number } | undefined;
}

/** A fake AI_SEARCH_AGENT namespace: records resolution + search. */
function fakeNamespace(
  searchImpl: (
    query: string,
    opts: { callerLogin?: string; limit?: number } | undefined,
  ) => Promise<AiSearchAgentSearchResult>,
) {
  const calls = {
    idFromName: [] as string[],
    get: [] as unknown[],
    search: [] as SearchCall[],
  };
  const stub = {
    search: async (
      query: string,
      opts?: { callerLogin?: string; limit?: number },
    ) => {
      calls.search.push({ query, opts });
      return searchImpl(query, opts);
    },
  };
  const namespace = {
    idFromName: (name: string) => {
      calls.idFromName.push(name);
      return `id:${name}`;
    },
    get: (id: unknown) => {
      calls.get.push(id);
      return stub;
    },
  };
  return { namespace, calls };
}

const okResult = (
  over: Partial<AiSearchAgentSearchResult> = {},
): AiSearchAgentSearchResult => ({
  ok: true,
  path: "namespace",
  correlationId: "corr-1",
  results: [],
  ...over,
});

function postAiAgent(
  body: unknown,
  opts: { env?: unknown; login?: string | null } = {},
) {
  const login = opts.login === undefined ? SESSION_LOGIN : opts.login;
  return handleSearchHubRoutes(
    new Request("https://agent.internal/api/search/ai-agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(login ? { "x-user-login": login } : {}),
      },
      body: JSON.stringify(body),
    }),
    new URL("https://agent.internal/api/search/ai-agent"),
    "/api/search/ai-agent",
    "sess",
    { env: (opts.env ?? {}) as any, userLogin: login ?? "" },
  );
}

describe("POST /search/ai-agent — the Search hub's AiSearchAgent door (#3323)", () => {
  it("requires a session (shared 401)", async () => {
    const { namespace } = fakeNamespace(async () => okResult());
    const res = await postAiAgent(
      { query: "options risk" },
      { env: { AI_SEARCH_AGENT: namespace }, login: null },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({
      success: false,
      error: "An authenticated E*TRADE account is required.",
    });
  });

  it("rejects an empty query", async () => {
    const { namespace } = fakeNamespace(async () => okResult());
    const res = await postAiAgent(
      { query: "  " },
      { env: { AI_SEARCH_AGENT: namespace } },
    );
    expect(res!.status).toBe(400);
  });

  it("resolves the stub on the service instance and threads the ROUTE session login as callerLogin", async () => {
    const { namespace, calls } = fakeNamespace(async () => okResult());
    // A login smuggled into the request body must be ignored:
    // identity comes from the route's session, never the payload.
    const res = await postAiAgent(
      { query: "NVDA data center revenue", callerLogin: "mallory", login: "mallory" },
      { env: { AI_SEARCH_AGENT: namespace } },
    );
    expect(res!.status).toBe(200);
    expect(calls.idFromName).toEqual([SERVICE_INSTANCE]);
    expect(calls.get).toEqual([`id:${SERVICE_INSTANCE}`]);
    expect(calls.search).toHaveLength(1);
    expect(calls.search[0].query).toBe("NVDA data center revenue");
    expect(calls.search[0].opts?.callerLogin).toBe(SESSION_LOGIN);
    expect(calls.search[0].opts?.limit).toBe(5);
  });

  it("passes an explicit limit through to the agent search", async () => {
    const { namespace, calls } = fakeNamespace(async () => okResult());
    await postAiAgent(
      { query: "options disclosures", limit: 3 },
      { env: { AI_SEARCH_AGENT: namespace } },
    );
    expect(calls.search[0].opts?.limit).toBe(3);
  });

  it("passes the agent's result through unaltered — chunk metadata, path label, degraded note intact", async () => {
    const item = {
      title: "Weekly options report",
      snippet: "Generated report body excerpt",
      source: "knowledge/reports/weekly.md",
      score: 0.87,
      category: "options_disclosure" as const,
      bucketKey: "knowledge/reports/weekly.md",
      servedFileLink: "/api/knowledge/file?key=knowledge%2Freports%2Fweekly.md",
      indexingState: "indexed" as const,
    };
    const { namespace } = fakeNamespace(async () =>
      okResult({
        results: [item],
        degraded: "1 report-type result(s) withheld: not owned by the caller",
        correlationId: "corr-9",
      }),
    );
    const res = await postAiAgent(
      { query: "weekly report" },
      { env: { AI_SEARCH_AGENT: namespace } },
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({
      ok: true,
      path: "namespace",
      degraded: "1 report-type result(s) withheld: not owned by the caller",
      results: [item],
      correlationId: "corr-9",
    });
  });

  it("passes a failed agent answer through with its code, errorToken and error (results default to zero rows)", async () => {
    const { namespace } = fakeNamespace(async () => ({
      ok: false,
      // #3342: the fake previously labelled this failure with the
      // retired "rest" path; the surviving paths are namespace/mcp.
      path: "mcp" as const,
      code: "all_paths_failed" as const,
      errorToken: "ERR_TOOL_EXECUTION_FAILED" as any,
      error: "every configured path failed",
      correlationId: "corr-2",
    }));
    const res = await postAiAgent(
      { query: "margin rules" },
      { env: { AI_SEARCH_AGENT: namespace } },
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({
      ok: false,
      path: "mcp",
      results: [],
      code: "all_paths_failed",
      errorToken: "ERR_TOOL_EXECUTION_FAILED",
      error: "every configured path failed",
      correlationId: "corr-2",
    });
  });

  it("binding absent -> the honest not_configured answer, in-band (200, zero results, nothing fabricated)", async () => {
    const res = await postAiAgent({ query: "options risk" }, { env: {} });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_configured");
    expect(body.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    expect(body.results).toEqual([]);
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("AI_SEARCH_AGENT");
    expect(typeof body.correlationId).toBe("string");
  });

  it("binding misshapen -> the same honest not_configured answer", async () => {
    const res = await postAiAgent(
      { query: "options risk" },
      { env: { AI_SEARCH_AGENT: { get: "not-a-function" } } },
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_configured");
    expect(body.results).toEqual([]);
  });

  it("wrong method falls through (null)", async () => {
    const res = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/search/ai-agent", { method: "GET" }),
      new URL("https://agent.internal/api/search/ai-agent"),
      "/api/search/ai-agent",
      "sess",
      { env: {}, userLogin: SESSION_LOGIN },
    );
    expect(res).toBeNull();
  });
});
