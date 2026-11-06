/**
 * Issue #2250 — the orchestrator chat tool for AiSearchAgent.
 *
 * Before this slice, AiSearchAgent (#2223) was reachable over A2A
 * and by direct method call, but NOT from a chat turn: the
 * orchestrator's toolset (the MCP command set) had no door onto it,
 * so there was no way to ask in chat for a search over the AI Search
 * instance — or over the generated reports #2246 indexes into it.
 *
 * These pins hold the tool's contract at the command seam:
 * - the command resolves the AI_SEARCH_AGENT stub on the fixed
 *   service instance and calls search() exactly once, with the
 *   query and the TURN's session login (context.sessionId — the
 *   identity every sibling command uses); a login carried in tool
 *   ARGUMENTS is never used (the schemas do not even declare one);
 * - the agent's answer is shaped into the tool's { text, data }
 *   answer WITHOUT laundering: a degraded agent answer is a
 *   degraded tool answer, stated in the text, with the agent's
 *   degraded note carried verbatim and zero fabricated rows;
 * - result rows pass through with their S2 fields and provenance
 *   (bucketKey / servedFileLink / indexingState) intact;
 * - report-type results are only ever the caller's — the tool
 *   threads the session login into the agent's #2246 discipline
 *   (pinned here with the agent's contract faked at the seam);
 * - a turn without a verified login passes NO callerLogin, so the
 *   agent's safe default (report-type results withheld) applies;
 * - the command is registered in the chat command set exactly once
 *   and declares the mcp:read scope.
 */
import { describe, it, expect } from "vitest";
import { AISearchAgentSearchCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
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

function stubContext(env: unknown, sessionId: string, auditLog: unknown[]) {
  return {
    env,
    orm: undefined,
    sessionId,
    audit: (type: string, agent: unknown, payload: Record<string, unknown>) =>
      auditLog.push({ type, agent, payload }),
  } as any;
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

describe("ai_search_agent_search — the orchestrator's door onto AiSearchAgent (#2250)", () => {
  it("resolves the stub on the service instance and calls search exactly once with the query and the SESSION login", async () => {
    const { namespace, calls } = fakeNamespace(async () => okResult());
    const auditLog: unknown[] = [];
    const cmd = new AISearchAgentSearchCommand();
    // A login smuggled into tool arguments must be ignored: identity
    // comes from the turn context, never from the call's payload.
    const answer = await cmd.execute(
      { query: "NVDA data center revenue", callerLogin: "mallory" } as any,
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, auditLog),
    );
    expect(calls.idFromName).toEqual([SERVICE_INSTANCE]);
    expect(calls.get).toEqual([`id:${SERVICE_INSTANCE}`]);
    expect(calls.search).toHaveLength(1);
    expect(calls.search[0].query).toBe("NVDA data center revenue");
    expect(calls.search[0].opts?.callerLogin).toBe(SESSION_LOGIN);
    expect(calls.search[0].opts?.limit).toBe(5);
    expect(answer.data.ok).toBe(true);
  });

  it("declares no login field in either schema — identity cannot arrive via arguments", () => {
    const cmd = new AISearchAgentSearchCommand();
    expect(Object.keys(cmd.jsonSchema.properties)).not.toContain("callerLogin");
    expect(Object.keys(cmd.jsonSchema.properties)).not.toContain("login");
    expect(Object.keys(cmd.jsonSchema.properties)).not.toContain("userLogin");
    expect(cmd.zodSchema.shape).not.toHaveProperty("callerLogin");
    const parsed = cmd.zodSchema.parse({
      query: "margin rules",
      callerLogin: "mallory",
    } as any) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("callerLogin");
  });

  it("passes an explicit limit through to the agent search", async () => {
    const { namespace, calls } = fakeNamespace(async () => okResult());
    const cmd = new AISearchAgentSearchCommand();
    await cmd.execute(
      { query: "options disclosures", limit: 3 },
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, []),
    );
    expect(calls.search[0].opts?.limit).toBe(3);
  });

  it("a turn without a verified login passes NO callerLogin — the agent's report discipline stays at its safe default", async () => {
    const { namespace, calls } = fakeNamespace(async () => okResult());
    const cmd = new AISearchAgentSearchCommand();
    await cmd.execute(
      { query: "quarterly report" },
      stubContext({ AI_SEARCH_AGENT: namespace }, "", []),
    );
    expect(calls.search).toHaveLength(1);
    expect(calls.search[0].opts?.callerLogin).toBeUndefined();
  });

  it("report-type results are only ever the caller's (the agent's #2246 contract, faked at the seam)", async () => {
    // The fake enforces the agent's real contract: report-type rows
    // are served only when callerLogin equals the row's ownerLogin.
    const corpus = [
      { title: "OCC risk disclosure", snippet: "…", source: "occ.pdf", score: 0.9 },
      { title: "Report: alice weekly screen", snippet: "…", source: "report:rep-alice", score: 0.8, ownerLogin: "alice" },
      { title: "Report: bob weekly screen", snippet: "…", source: "report:rep-bob", score: 0.85, ownerLogin: "bob" },
    ];
    const { namespace } = fakeNamespace(async (_q, opts) =>
      okResult({
        results: corpus
          .filter(
            (row) =>
              !row.source.startsWith("report:") ||
              row.ownerLogin === opts?.callerLogin,
          )
          .map(({ ownerLogin: _owner, ...row }) => row),
      }),
    );
    const cmd = new AISearchAgentSearchCommand();
    const answer = await cmd.execute(
      { query: "weekly screen" },
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, []),
    );
    const sources = (answer.data.results ?? []).map((r) => r.source);
    expect(sources).toContain("report:rep-alice");
    expect(sources).not.toContain("report:rep-bob");
  });

  it("rows pass through with S2 fields and provenance intact", async () => {
    const rows = [
      {
        title: "NVDA 10-K excerpt",
        snippet: "Data center revenue grew…",
        source: "knowledge/nvda-10k.pdf",
        score: 0.93,
        category: "sec_filing" as const,
        bucketKey: "knowledge/nvda-10k.pdf",
        servedFileLink: "/knowledge/file?key=knowledge%2Fnvda-10k.pdf",
        indexingState: "indexed" as const,
      },
    ];
    const { namespace } = fakeNamespace(async () => okResult({ results: rows }));
    const cmd = new AISearchAgentSearchCommand();
    const answer = await cmd.execute(
      { query: "NVDA revenue" },
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, []),
    );
    expect(answer.data.results).toEqual(rows);
    expect(answer.text).toContain("namespace");
    expect(answer.text).toContain("1 result(s)");
  });

  it("a degraded agent failure stays degraded in the tool answer — stated, with zero fabricated rows", async () => {
    // Adapted by #3342: the fake previously modelled the retired
    // REST path's degraded_fallback outcome. The surviving failure
    // shape for an unserved search is all_paths_failed; the fake
    // stands in for the agent, so its note is what the runner
    // would produce.
    const degradedNote =
      "All configured AI Search paths failed: mcp: the instance did not serve the query; the degraded answer was withheld rather than presented as results.";
    const { namespace } = fakeNamespace(async () => ({
      ok: false,
      path: "mcp" as const,
      code: "all_paths_failed" as const,
      correlationId: "corr-2",
      degraded: degradedNote,
      error: degradedNote,
    }));
    const cmd = new AISearchAgentSearchCommand();
    const answer = await cmd.execute(
      { query: "PDT margin rules" },
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, []),
    );
    expect(answer.data.ok).toBe(false);
    expect(answer.data.code).toBe("all_paths_failed");
    expect(answer.data.results ?? []).toHaveLength(0);
    expect(answer.text).toMatch(/degraded/i);
    expect(answer.text).toContain("withheld");
  });

  it("a not-configured agent answer is stated as such, never dressed up as results", async () => {
    // #3342: the runner's not_configured note names only the two
    // surviving paths (the REST clause is gone with the path).
    const note =
      "No AI Search access path is configured: the namespace path needs the ai_search_namespaces binding (env.AI_SEARCH) plus AI_SEARCH_INSTANCE, and the MCP path needs AI_SEARCH_MCP_ENDPOINT (the instance's dashboard-enabled public endpoint).";
    const { namespace } = fakeNamespace(async () => ({
      ok: false,
      code: "not_configured" as const,
      correlationId: "corr-3",
      degraded: note,
      error: note,
    }));
    const cmd = new AISearchAgentSearchCommand();
    const answer = await cmd.execute(
      { query: "anything" },
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, []),
    );
    expect(answer.data.ok).toBe(false);
    expect(answer.data.results ?? []).toHaveLength(0);
    expect(answer.text).toContain("No AI Search access path is configured");
  });

  it("an ok-but-degraded agent answer (report rows withheld) surfaces the degraded note in the text", async () => {
    const note =
      "1 report-type result(s) withheld under the report login discipline: report results are served only to the report owner's login (#2246).";
    const rows = [{ title: "Corpus doc", snippet: "…", source: "k/doc.pdf", score: 0.7 }];
    const { namespace } = fakeNamespace(async () =>
      okResult({ results: rows, degraded: note }),
    );
    const cmd = new AISearchAgentSearchCommand();
    const answer = await cmd.execute(
      { query: "screen results" },
      stubContext({ AI_SEARCH_AGENT: namespace }, SESSION_LOGIN, []),
    );
    expect(answer.data.ok).toBe(true);
    expect(answer.data.results).toEqual(rows);
    expect(answer.data.degraded).toBe(note);
    expect(answer.text).toContain("withheld");
  });

  it("a missing AI_SEARCH_AGENT binding answers honestly (not configured) and calls nothing", async () => {
    const cmd = new AISearchAgentSearchCommand();
    const answer = await cmd.execute(
      { query: "anything" },
      stubContext({}, SESSION_LOGIN, []),
    );
    expect(answer.data.ok).toBe(false);
    expect(answer.data.code).toBe("not_configured");
    expect(answer.data.results ?? []).toHaveLength(0);
    expect(answer.text).toMatch(/not configured/i);
  });

  it("the description does not overclaim: reports are conditional on indexing, degradation is named", () => {
    const cmd = new AISearchAgentSearchCommand();
    expect(cmd.description).toContain("AiSearchAgent");
    expect(cmd.description).toMatch(/indexed into the instance/);
    expect(cmd.description).toMatch(/degraded/i);
    expect(cmd.description).not.toMatch(/all (of )?(your|the) generated reports are/i);
  });

  it("is registered in the chat command set exactly once, with the mcp:read scope declared", () => {
    const cmd = McpToolFactory.getTool("ai_search_agent_search");
    expect(cmd).toBeInstanceOf(AISearchAgentSearchCommand);
    const names = McpToolFactory.getAllTools().map((t) => t.name);
    expect(names.filter((n) => n === "ai_search_agent_search")).toHaveLength(1);
    expect(MCP_TOOL_SCOPES["ai_search_agent_search"]).toBe("mcp:read");
  });
});
