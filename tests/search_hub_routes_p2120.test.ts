/**
 * #2120 slice 1: searchHub route pins (node env, no DOM).
 * The route module is NEW: on the pristine tree these pins fail at
 * COLLECTION (module does not exist) — an unrun file, not a pass.
 * Agent tab with env lacking AI_SEARCH_ENDPOINT exercises the
 * service-native shape via its degraded contract (#1169 S3: zero
 * results + degraded "endpoint_not_configured"); it asserts the
 * shape, never live index results.
 */
import { describe, it, expect } from "vitest";
import { handleSearchHubRoutes } from "../src/agents/routes/searchHub";

const ctx = (env: any = {}, userLogin = "tester") => ({ env, userLogin });

const post = (path: string, body: any, login: string | null = "tester") =>
  handleSearchHubRoutes(
    new Request(`https://agent.internal${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(login ? { "x-user-login": login } : {}),
      },
      body: JSON.stringify(body),
    }),
    new URL(`https://agent.internal${path}`),
    path,
    "sess",
    ctx({}, login ?? "")
  );

describe("#2120 slice 1 searchHub routes", () => {
  it("POST /search/agent requires a session (shared 401)", async () => {
    const res = await post("/api/search/agent", { query: "x" }, null);
    expect(res!.status).toBe(401);
    // Shared unauthenticatedResponse() (#1185 precedent) — NOT the
    // inline "Unauthorized: Please log in." body some modules use.
    expect(await res!.json()).toEqual({
      success: false,
      error: "An authenticated E*TRADE account is required.",
    });
  });

  it("POST /search/agent rejects an empty query", async () => {
    const res = await post("/api/search/agent", { query: "  " });
    expect(res!.status).toBe(400);
  });

  it("POST /search/agent returns the service-native shape (degraded, no endpoint configured)", async () => {
    // Adapted by #1169 S3: this pin asserted results.length > 0 with
    // no endpoint configured — that was the removed fallback corpus
    // answering through the route. Post-S3 the honest shape is zero
    // results + the in-band degraded reason, asserted here at
    // greater strength (exact reason + exact zero counts).
    const res = await post("/api/search/agent", { query: "options risk" });
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.query).toBe("options risk");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toEqual([]);
    expect(body.degraded).toBe("endpoint_not_configured");
    expect(body.provider).toBe("cloudflare_ai_search");
    expect(body.totalMatches).toBe(0);
    expect(typeof body.totalMatches).toBe("number");
  });

  it("POST /search/knowledge requires a session (shared 401)", async () => {
    const res = await post("/api/search/knowledge", { query: "x" }, null);
    expect(res!.status).toBe(401);
  });

  it("POST /search/knowledge returns native catalog results, platform-mode only", async () => {
    const res = await post("/api/search/knowledge", { query: "screener" });
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.results[0].title).toBeTruthy();
    expect(typeof body.results[0].relevanceScore).toBe("number");
    expect(typeof body.results[0].category).toBe("string");
  });

  it("POST /search/knowledge category filter uses the catalog code", async () => {
    // Pre-existing catalog contract (platformKnowledge.ts): the
    // category filter applies to the WORKFLOWS section only; FAQ /
    // decisioning / capability sections are unfiltered. The route
    // passes category through; the pin asserts the workflow half.
    // maxResults 50: the default 8 slots can fill with higher-bias
    // FAQ/decisioning entries and crowd workflows out entirely.
    const res = await post("/api/search/knowledge", { query: "options", category: "options", maxResults: 50 });
    const body = await res!.json();
    expect(body.count).toBeGreaterThan(0);
    const workflows = body.results.filter((r: any) => r.type === "workflow");
    expect(workflows.length).toBeGreaterThan(0);
    for (const r of workflows) {
      expect(r.category).toBe("Options");
    }
  });

  it("unknown paths and wrong methods fall through (null)", async () => {
    const res = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/other", { method: "GET" }),
      new URL("https://agent.internal/api/other"),
      "/api/other",
      "sess",
      ctx()
    );
    expect(res).toBeNull();
    const get = await handleSearchHubRoutes(
      new Request("https://agent.internal/api/search/agent", { method: "GET" }),
      new URL("https://agent.internal/api/search/agent"),
      "/api/search/agent",
      "sess",
      ctx()
    );
    expect(get).toBeNull();
  });
});
