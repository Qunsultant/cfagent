/**
 * #1723 (parent #1717, slice (c)): knowledge + memory unification pins.
 *
 * Two switches, one per pair (NEVER EITHER/OR — both code paths survive):
 * - KNOWLEDGE_MODE ("search" | "platform") over knowledge_search and
 *   query_platform_knowledge. Built-in default = the calling tool's own
 *   legacy contract (there is no REST search route whose behavior could
 *   serve as a single default): knowledge_search → "search", 
 *   query_platform_knowledge → "platform". An explicitly set level
 *   (run > session > user > env) overrides either tool. Invalid wins
 *   fail closed to the calling tool's legacy mode, logged + audited as
 *   knowledge.config_error, with no fall-through.
 * - MEMORY_READ_MODE ("capped" | "uncapped") over the memory read cap
 *   only (list presentation — never the existence of a write path).
 *   Built-in default = the calling surface's legacy cap: REST GET
 *   /memory → "capped" (100, remapped rows); MCP manage_session_memory
 *   list and the sqlite://memory/facts resource → "uncapped". Invalid
 *   wins fail closed to the surface legacy cap, audited as
 *   memory.config_error. Remember/delete/clear are NOT gated by it.
 *
 * New surface in this slice (transport + envelope only, same store,
 * same command — no new store/engine): POST /memory (remember) via
 * runRestTool("manage_session_memory", {action:"remember"}); the MCP
 * write path is NOT removed. Corpus routes are adjacent, NOT merged:
 * knowledgeCorpus.ts stays independent of the search switch.
 *
 * TDD Red: this file fails module-missing before
 * src/config/knowledgeMemoryModes.ts exists.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  KNOWLEDGE_MODE_SWITCH,
  MEMORY_READ_CAP,
  MEMORY_READ_MODE_SWITCH,
  knowledgeConfigErrorEvent,
  levelsForKnowledge,
  levelsForMemory,
  memoryConfigErrorEvent,
  resolveKnowledgeMode,
  resolveMemoryReadMode,
  type KnowledgeMode,
} from "../src/config/knowledgeMemoryModes";
import {
  KnowledgeSearchCommand,
  ManageSessionMemoryCommand,
  QueryPlatformKnowledgeCommand,
} from "../src/mcps/openaimp/commands";
import { handleMemoryResetRoutes, type MemoryResetRouteContext } from "../src/agents/routes/memoryReset";
import { readMCPResource } from "../src/mcps/openaimp/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

const audit = () => vi.fn();
const toolCtx = (overrides: Record<string, unknown> = {}) =>
  ({
    env: {},
    orm: {},
    sessionId: "sess-1723",
    audit: audit(),
    ...overrides,
  }) as any;

// #3342: the search contract's AI attempt reads the namespace
// binding, not the public endpoint — the fakes are binding envs.
// Chunks are native-shaped (text + item.key) so the binding
// adaptation keeps them; the pins below assert only
// length/count/message, as they did in the fetch era.
const aiChunks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    type: "text",
    score: 0.9,
    text: `chunk ${i}`,
    item: { key: `knowledge/doc-${i}` },
  }));

const bindingEnvChunks = (n: number) => ({
  AI_SEARCH_INSTANCE: "screener-search",
  AI_SEARCH: {
    get: (_name: string) => ({ search: async () => ({ chunks: aiChunks(n) }) }),
  },
});
const bindingEnvThrow = () => ({
  AI_SEARCH_INSTANCE: "screener-search",
  AI_SEARCH: {
    get: (_name: string) => ({
      search: async () => {
        throw new Error("boom");
      },
    }),
  },
});

describe("knowledge mode resolver", () => {
  it("blank levels fall back to the calling tool's legacy mode", () => {
    expect(resolveKnowledgeMode({}, "search").mode).toBe("search");
    expect(resolveKnowledgeMode({}, "platform").mode).toBe("platform");
    expect(resolveKnowledgeMode({}, "search").level).toBe("builtin");
  });
  it("resolution order is run > session > user > env", () => {
    const r = resolveKnowledgeMode(
      { run: "platform", session: "search", user: "search", env: "search" },
      "search"
    );
    expect(r).toMatchObject({ mode: "platform", level: "run" });
    expect(
      resolveKnowledgeMode({ session: "platform", user: "search", env: "search" }, "search")
    ).toMatchObject({ mode: "platform", level: "session" });
    expect(resolveKnowledgeMode({ user: "platform", env: "search" }, "search")).toMatchObject({
      mode: "platform",
      level: "user",
    });
    expect(resolveKnowledgeMode({ env: "platform" }, "search")).toMatchObject({
      mode: "platform",
      level: "env",
    });
  });
  it("values are case-insensitive and whitespace-tolerant", () => {
    expect(resolveKnowledgeMode({ run: "  PLATFORM " }, "search").mode).toBe("platform");
  });
  it("an invalid winning value fails closed to legacy with no fall-through", () => {
    const r = resolveKnowledgeMode({ run: "bogus", env: "platform" }, "search");
    expect(r).toMatchObject({ mode: "search", invalid: true, level: "run", raw: "bogus" });
  });
  it("levelsForKnowledge wires scoped carriers + run + env", () => {
    expect(levelsForKnowledge({ session: "platform", user: "search" }, undefined, "search")).toEqual({
      run: undefined,
      session: "platform",
      user: "search",
      env: "search",
    });
  });
  it("switch name + audit event are pinned", () => {
    expect(KNOWLEDGE_MODE_SWITCH).toBe("KNOWLEDGE_MODE");
    expect(knowledgeConfigErrorEvent()).toBe("knowledge.config_error");
  });
});

describe("knowledge_search / query_platform_knowledge under KNOWLEDGE_MODE", () => {
  it("knowledge_search default (search): AI chunks sliced to 5, count is pre-slice", async () => {
    const out = await new KnowledgeSearchCommand().execute(
      { query: "quantum lattice energy" },
      toolCtx({ env: bindingEnvChunks(7) })
    );
    expect(out.chunks).toHaveLength(5);
    expect(out.count).toBe(7);
    expect(out.message).toMatch(/Cloudflare AI Search/);
    expect(out).not.toHaveProperty("results");
  });

  it("knowledge_search default (search): empty AI result falls back to platform, max 3, score 1.0", async () => {
    const out = await new KnowledgeSearchCommand().execute(
      { query: "how to use the screener" },
      toolCtx({ env: bindingEnvChunks(0) })
    );
    expect(out.count).toBeLessThanOrEqual(3);
    expect(out.chunks).toHaveLength(out.count);
    expect(out.chunks.length).toBeGreaterThan(0);
    for (const c of out.chunks) expect(c.score).toBe(1.0);
    expect(out.message).toMatch(/Platform Knowledge Base/);
    expect(out.answer).toBeTruthy();
  });

  it("knowledge_search mode=platform: platform shape (results, no message), max 5", async () => {
    const out = await new KnowledgeSearchCommand().execute(
      { query: "how many workflows", mode: "platform" },
      toolCtx()
    );
    expect(out).toHaveProperty("results");
    expect(out).not.toHaveProperty("chunks");
    expect(out).not.toHaveProperty("message");
    expect(out.results).toHaveLength(5);
    expect(out.count).toBe(14);
    expect(out.answer).toBeTruthy();
  });

  it("knowledge_search mode=platform honors the category filter", async () => {
    const out = await new KnowledgeSearchCommand().execute(
      { query: "options strategy discovery", mode: "platform", category: "options" },
      toolCtx()
    );
    expect(out.results.length).toBeGreaterThan(0);
    const workflows = out.results.filter((r: any) => r.type === "workflow");
    expect(workflows.length).toBeGreaterThan(0);
    for (const r of workflows) expect(r.category).toBe("Options");
  });

  it("query_platform_knowledge default (platform): results shape, max 5, no message", async () => {
    const out = await new QueryPlatformKnowledgeCommand().execute(
      { query: "how many workflows" },
      toolCtx()
    );
    expect(out.results).toHaveLength(5);
    expect(out.count).toBe(14);
    expect(out).not.toHaveProperty("chunks");
    expect(out).not.toHaveProperty("message");
  });

  it("query_platform_knowledge mode=search: AI-first chunks shape + message", async () => {
    const out = await new QueryPlatformKnowledgeCommand().execute(
      { query: "quantum lattice energy", mode: "search" },
      toolCtx({ env: bindingEnvChunks(7) })
    );
    expect(out.chunks).toHaveLength(5);
    expect(out.message).toMatch(/Cloudflare AI Search/);
    expect(out).not.toHaveProperty("results");
  });

  it("search mode keeps the no-throw error shape when AI fails and platform is empty", async () => {
    const out = await new QueryPlatformKnowledgeCommand().execute(
      { query: "zxqv wjbk plumbus", mode: "search" },
      toolCtx({ env: bindingEnvThrow() })
    );
    expect(out).toMatchObject({ query: "zxqv wjbk plumbus", count: 0, chunks: [] });
    expect(out.error).toBeTruthy();
  });

  it("an invalid mode fails closed to the tool legacy + audits knowledge.config_error", async () => {
    const ctx = toolCtx();
    const out = await new QueryPlatformKnowledgeCommand().execute(
      { query: "how many workflows", mode: "bogus" },
      ctx
    );
    expect(out.results).toHaveLength(5); // legacy platform, not search
    const calls = (ctx.audit as any).mock.calls as Array<[string, string, Record<string, unknown>]>;
    const err = calls.find(([t]) => t === "knowledge.config_error");
    expect(err).toBeTruthy();
    expect(err![2]).toMatchObject({ setting: "KNOWLEDGE_MODE", resolved: "platform" });
  });

  it("env level overrides the builtin legacy when no higher level is set", async () => {
    const out = await new KnowledgeSearchCommand().execute(
      { query: "how many workflows" },
      toolCtx({ env: { KNOWLEDGE_MODE: "platform" } })
    );
    expect(out).toHaveProperty("results");
  });
});

/* ---- memory fakes ---- */
const makeMemoryOrm = (n: number) => {
  const store = new Map<string, { key: string; value: string; updatedAt: string }>();
  for (let i = 0; i < n; i++) {
    const key = `k${String(i).padStart(3, "0")}`;
    store.set(key, { key, value: `v${i}`, updatedAt: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z` });
  }
  // Distinct updatedAt ordering: pad index into the date so DESC is k149 first.
  let idx = 0;
  for (const rec of store.values()) {
    rec.updatedAt = `2026-02-${String(1 + Math.floor(idx / 60)).padStart(2, "0")}T00:${String(idx % 60).padStart(2, "0")}:00.000Z`;
    idx++;
  }
  return {
    store,
    memory: {
      findMany: (opts?: { limit?: number }) => {
        const rows = [...store.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return opts?.limit ? rows.slice(0, opts.limit) : rows;
      },
      findById: (key: string) => store.get(key),
      create: (rec: { key: string; value: string; updatedAt: string }) => {
        store.set(rec.key, rec);
        return rec;
      },
      update: (key: string, patch: { value: string; updatedAt: string }) => {
        const rec = { key, ...patch };
        store.set(key, rec);
        return rec;
      },
      delete: (key: string) => store.delete(key),
    },
    sql: { exec: vi.fn() },
  };
};

const routeCtx = (orm: any, overrides: Partial<MemoryResetRouteContext> = {}) =>
  ({
    ensureTables: () => ({ exec: vi.fn() }),
    getOrm: () => orm,
    audit: vi.fn(),
    abortAllRequests: vi.fn(),
    resetTurnState: vi.fn(),
    clearConversationMessages: vi.fn(async () => {}),
    ...overrides,
  }) as unknown as MemoryResetRouteContext;

const callRoute = (
  method: string,
  path: string,
  ctx: MemoryResetRouteContext,
  body?: unknown
) => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const req = new Request(`https://agent.internal${path}`, init);
  const url = new URL(`https://agent.internal${path}`);
  return handleMemoryResetRoutes(req, url, url.pathname, "sess-1723", ctx);
};

describe("memory read mode resolver", () => {
  it("blank levels fall back to the surface legacy cap", () => {
    expect(resolveMemoryReadMode({}, "capped")).toMatchObject({ mode: "capped", level: "builtin" });
    expect(resolveMemoryReadMode({}, "uncapped")).toMatchObject({ mode: "uncapped", level: "builtin" });
    expect(MEMORY_READ_CAP).toBe(100);
  });
  it("resolution order is run > session > user > env; invalid fails closed, no fall-through", () => {
    expect(resolveMemoryReadMode({ run: "capped", env: "uncapped" }, "uncapped")).toMatchObject({
      mode: "capped",
      level: "run",
    });
    const bad = resolveMemoryReadMode({ run: "bogus", env: "capped" }, "uncapped");
    expect(bad).toMatchObject({ mode: "uncapped", invalid: true, level: "run" });
    expect(levelsForMemory({ session: "capped" }, undefined, "uncapped")).toEqual({
      run: undefined,
      session: "capped",
      user: undefined,
      env: "uncapped",
    });
    expect(MEMORY_READ_MODE_SWITCH).toBe("MEMORY_READ_MODE");
    expect(memoryConfigErrorEvent()).toBe("memory.config_error");
  });
});

describe("manage_session_memory list under MEMORY_READ_MODE", () => {
  it("MCP list default is uncapped (legacy)", async () => {
    const ctx = toolCtx({ orm: makeMemoryOrm(150) });
    const out = await new ManageSessionMemoryCommand().execute({ action: "list" }, ctx);
    expect(out.count).toBe(150);
    expect(out.memories).toHaveLength(150);
  });
  it("MCP list mode=capped returns the first 100", async () => {
    const ctx = toolCtx({ orm: makeMemoryOrm(150) });
    const out = await new ManageSessionMemoryCommand().execute({ action: "list", mode: "capped" }, ctx);
    expect(out.count).toBe(100);
    expect(out.memories).toHaveLength(100);
  });
  it("MCP list env=capped caps; invalid fails closed to uncapped + audits", async () => {
    const ctx = toolCtx({ orm: makeMemoryOrm(150), env: { MEMORY_READ_MODE: "capped" } });
    const capped = await new ManageSessionMemoryCommand().execute({ action: "list" }, ctx);
    expect(capped.count).toBe(100);
    const badCtx = toolCtx({ orm: makeMemoryOrm(150), env: { MEMORY_READ_MODE: "bogus" } });
    const out = await new ManageSessionMemoryCommand().execute({ action: "list" }, badCtx);
    expect(out.count).toBe(150);
    const calls = (badCtx.audit as any).mock.calls as Array<[string, string, Record<string, unknown>]>;
    expect(calls.find(([t]) => t === "memory.config_error")).toBeTruthy();
  });
  it("remember is NOT gated by the read mode and still audits memory.remembered once", async () => {
    const ctx = toolCtx({ orm: makeMemoryOrm(3) });
    const out = await new ManageSessionMemoryCommand().execute(
      { action: "remember", key: "k-new", value: "v-new", mode: "capped" },
      ctx
    );
    expect(out).toMatchObject({ success: true, stored: true, key: "k-new" });
    const calls = (ctx.audit as any).mock.calls as Array<[string]>;
    expect(calls.filter(([t]) => t === "memory.remembered")).toHaveLength(1);
    expect(calls.find(([t]) => t === "memory.config_error")).toBeUndefined();
  });
});

describe("REST /memory under MEMORY_READ_MODE + new POST remember", () => {
  it("GET default is capped at 100 with remapped rows", async () => {
    const orm = makeMemoryOrm(150);
    const ctx = routeCtx(orm);
    const res = await callRoute("GET", "/memory", ctx);
    const body = await res!.json();
    expect(body.count).toBe(100);
    expect(body.memories).toHaveLength(100);
    expect(Object.keys(body.memories[0]).sort()).toEqual(["key", "updatedAt", "value"]);
  });
  it("GET ?mode=uncapped returns all rows; GET ?mode=bogus fails closed to capped", async () => {
    const orm = makeMemoryOrm(150);
    const all = await (await callRoute("GET", "/memory?mode=uncapped", routeCtx(orm)))!.json();
    expect(all.count).toBe(150);
    const bad = await (await callRoute("GET", "/memory?mode=bogus", routeCtx(orm)))!.json();
    expect(bad.count).toBe(100);
  });
  it("POST /memory remembers via the same command: 200, upsert, exactly one audit", async () => {
    const orm = makeMemoryOrm(3);
    const ctx = routeCtx(orm);
    const res = await callRoute("POST", "/memory", ctx, { key: "pref", value: "dark" });
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toMatchObject({ success: true, stored: true, key: "pref", value: "dark" });
    expect(body.updatedAt).toBeTruthy();
    expect(orm.store.get("pref")?.value).toBe("dark");
    const audits = (ctx.audit as any).mock.calls as Array<[string]>;
    expect(audits.filter(([t]) => t === "memory.remembered")).toHaveLength(1);
    // Upsert: remembering the same key again updates, not duplicates.
    await callRoute("POST", "/memory", ctx, { key: "pref", value: "light" });
    expect(orm.store.get("pref")?.value).toBe("light");
    expect(orm.store.size).toBe(4);
  });
  it("POST /memory with missing key/value is 400, not 500", async () => {
    const ctx = routeCtx(makeMemoryOrm(0));
    const res = await callRoute("POST", "/memory", ctx, { key: "only-key" });
    expect(res!.status).toBe(400);
    const badJson = await callRoute("POST", "/memory", ctx, "{not json");
    expect(badJson!.status).toBe(400);
  });
  it("sqlite://memory/facts resource: default uncapped, env=capped caps at 100", async () => {
    const orm = makeMemoryOrm(150);
    const full = await readMCPResource("sqlite://memory/facts", { orm, sessionId: "s" } as any);
    expect(JSON.parse(full.text)).toHaveLength(150);
    const capped = await readMCPResource("sqlite://memory/facts", {
      orm,
      sessionId: "s",
      env: { MEMORY_READ_MODE: "capped" },
    } as any);
    expect(JSON.parse(capped.text)).toHaveLength(100);
  });
});

describe("scope boundaries (no merge into corpus, no new store)", () => {
  it("corpus routes stay independent of the search switch and of the memory command", () => {
    const corpus = readFileSync("src/agents/routes/knowledgeCorpus.ts", "utf8");
    expect(corpus).not.toContain("KNOWLEDGE_MODE");
    expect(corpus).not.toContain("knowledge_search");
    const memoryRoute = readFileSync("src/agents/routes/memoryReset.ts", "utf8");
    expect(memoryRoute).toContain('runRestTool("manage_session_memory", { action: "remember"');
    expect(memoryRoute).not.toMatch(/CREATE TABLE/i);
  });
  it("audit resource session filter is untouched by this slice", () => {
    const idx = readFileSync("src/mcps/openaimp/index.ts", "utf8");
    expect(idx).toContain('where: { sessionId }, orderBy: "created_at DESC", limit: 30');
  });
});
