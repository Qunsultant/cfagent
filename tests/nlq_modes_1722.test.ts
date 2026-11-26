/**
 * #1722 (parent #1717, slice (b)): NLQ unification — NEVER EITHER/OR,
 * ALWAYS CONFIGURABLE.
 *
 * ONE runtime switch, NLQ_MODE ("rest" | "mcp"), over the NLQ port
 * contract. Built-in default "rest" — the REST-sync public route
 * behavior (named explicitly here and in the PR body so the owner can
 * overturn it; the async-job contract is the other "public route"
 * spelling, and it is NOT the default). Resolution order, owner
 * directive 2026-10-26: run > session > user > global env > built-in.
 * The first non-blank level wins; an unrecognized winning value FAILS
 * CLOSED to "rest", logged + audited as nlq.config_error (no
 * fall-through to a lower level).
 *
 * What the switch governs (port/validation contract only):
 * - "rest": the full-function execution (executeNaturalLanguageQuery)
 *   with the calling context's bound ports — REST route: scheduling,
 *   scan/profile stores, discovery + fit runners, social brief (trusted
 *   only); async job nlq.execute: scheduling, stock screen
 *   (ScreenerAgent, maxItems 10), discovery + fit runners, stores
 *   (no social port exists on the async context, in either mode);
 *   MCP: no ports are bound on MCP contexts, so rest = the full
 *   function with no options — which RESTORES the LLM validation +
 *   planSource patch the legacy facade path skipped.
 * - "mcp": each surface's own legacy execution, verbatim — EXCEPT
 *   #1686: the REST route's mcp branch now threads the DO blob
 *   handle (`storage`) so mcp-mode screens capture like rest-mode
 *   screens; ports, stores, and runners stay absent there. The async
 *   job still drops to the MCP-direct shape (full function, NO
 *   options); MCP facade path keeps planNLQ + executeNLQQueryAsync
 *   (no validation patch); MCP direct keeps the full function with
 *   no options (its legacy already).
 *
 * What the switch does NOT govern (enforcement, never opt-out):
 * - REST x-user-login gate: 401 without it, in BOTH modes.
 * - Webhook social-port withholding: x-nlq-source: webhook removes
 *   the social brief port in BOTH modes (in mcp mode there is no port
 *   to remove; a run/session/user/env value can never re-grant it).
 * - Identity: REST keeps x-user-login, MCP keeps sessionId, async
 *   keeps payload userLogin / session key, in both modes.
 * - Transport envelopes stay per surface (REST sync result vs MCP
 *   async-job receipt vs job result); the switch does not change
 *   delivery shape. Chat-error fallback is untouched: it is a degraded
 *   error path, not an intentional NLQ execution, and must not depend
 *   on a caller-settable mode.
 *
 * Pinned port matrix (scan appendix (b) N01), both modes:
 * | context      | rest mode                              | mcp mode                 |
 * | REST /nlq    | sched YES, stock NO→listings fallback, | ports NO, stores NO, |
 * |              | social YES (trusted only), disc YES,   | runners NO, storage YES|
 * |              | stores YES, LLM fn YES                 | (capture), LLM fn YES |
 * |              |                                        | (full fn + storage)    |
 * | async job    | sched YES, stock YES, social NO,       | all ports NO, stores NO, |
 * |              | disc YES, stores YES, LLM fn YES       | runners NO, LLM fn YES  |
 * | MCP facade   | ports NO, stores NO, runners NO,       | plan+async, NO validation|
 * |              | LLM fn YES (validation restored)       | patch (legacy verbatim) |
 * | MCP direct   | ports NO, stores NO, runners NO,       | identical (legacy verbatim)|
 * |              | LLM fn YES                             |                          |
 * Discovery/fit without runners (verified on current main, closing the
 * scan's untraced item; issue #1918 unified the two actions):
 * the unified options_fit_discovery action's scope leg without a
 * discovery runner → "Discovery isn't wired in this context.";
 * its fit leg without a fit runner → "Fit discovery isn't
 * available in this context — the Name↔Strategy discovery runner
 * (Phase 2 of epic #1096) is not wired here." (nlqOptionsStrategy).
 * Scheduling without a port: "Scheduling (…) unavailable: no live
 * agent scheduling port … NOT executed". Social without a port:
 * "Social brief: this action requires the asynchronous NLQ executor
 * with a live social brief port. Nothing was stored."
 * No endpoint is removed and no code path is deleted by this slice.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockD1Database } from "./mock-d1";
import { MockSqlStorage } from "./mock-sql";

vi.mock("../src/agents/nlq", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/agents/nlq")>();
  return {
    ...mod,
    executeNaturalLanguageQuery: vi.fn(async () => ({
      plan: { operation: "table_data", domain: "test" },
      result: { domain: "test", count: 2, rows: [{ a: 1 }] },
    })),
    planNLQ: vi.fn(async () => ({ operation: "table_data", domain: "test" })),
    executeNLQQueryAsync: vi.fn(async () => ({ domain: "test", count: 2 })),
  };
});

import {
  handleMcpChatNlqRoutes,
  type McpChatNlqRouteContext,
} from "../src/agents/routes/mcpChatNlq";
import { executeNaturalLanguageQuery } from "../src/agents/nlq";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  resolveNlqMode,
  levelsForNlq,
  nlqConfigErrorEvent,
} from "../src/config/nlqModes";
import {
  submitAsyncJob,
  executeAsyncJob,
} from "../src/agents/orchestrator/asyncJobs";

const nlqMock = () => executeNaturalLanguageQuery as unknown as ReturnType<typeof vi.fn>;

const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const routeCtx = (overrides: Record<string, any> = {}): McpChatNlqRouteContext =>
  ({
    getOrm: () => ({}) as any,
    getStorageSql: () => ({}),
    // #6503 — the /nlq route builds the agent-schedule capability
    // deps over the D1 unified store (fail-closed without AGENT_DB:
    // 500), same as tests/mcp_chat_nlq_routes_extraction.test.ts.
    env: { AGENT_DB: new MockD1Database() },
    audit: vi.fn(),
    submitAsyncJob: vi.fn(async () => ({ jobId: "j1", status: "queued" as const, statusUrl: "/jobs/j1" })),
    getAsyncJob: vi.fn(() => undefined),
    listAsyncJobs: vi.fn(() => []),
    extractMessageText: () => "",
    getMessages: async () => [],
    recordMessage: vi.fn(),
    runAgenticChatTurn: vi.fn(async () => ({
      result: { text: Promise.resolve("reply") },
      route: { agent: "trading", confidence: 0.9, reason: "r", needsConfirmation: false },
    })),
    buildChatErrorFallback: vi.fn(async () => "fallback"),
    nlqSchedulingPort: () => ({ id: "scheduling" }),
    nlqSocialBriefPort: () => ({ id: "social" }),
    ...overrides,
  }) as McpChatNlqRouteContext;

const postNlq = (ctx: McpChatNlqRouteContext, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  handleMcpChatNlqRoutes(
    req("POST", "/nlq", body, { "x-user-login": "bob", ...headers }),
    new URL("https://agent.internal/nlq"),
    "/nlq",
    "sess",
    ctx
  );

const toolCtx = (overrides: Record<string, any> = {}) => {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  const audit = vi.fn();
  return {
    sql,
    orm,
    audit,
    // #6503 — the async-job nlq.execute path builds the
    // agent-schedule capability over the D1 unified store
    // (fail-closed without AGENT_DB).
    ctx: { env: { AGENT_DB: new MockD1Database() }, orm, sessionId: "sess-1", audit, ...overrides } as any,
  };
};

describe("resolver: run > session > user > env > builtin(rest)", () => {
  it("defaults to rest when every level is blank", () => {
    expect(resolveNlqMode({})).toEqual({ mode: "rest", invalid: false, raw: undefined, level: "builtin" });
  });
  it("is case-insensitive and trims", () => {
    expect(resolveNlqMode({ env: "  MCP " }).mode).toBe("mcp");
    expect(resolveNlqMode({ env: "Rest" }).mode).toBe("rest");
  });
  it("run wins over session/user/env", () => {
    expect(resolveNlqMode({ run: "mcp", session: "rest", user: "rest", env: "rest" })).toMatchObject({ mode: "mcp", level: "run" });
  });
  it("session wins over user/env; user wins over env", () => {
    expect(resolveNlqMode({ session: "mcp", user: "rest", env: "rest" })).toMatchObject({ mode: "mcp", level: "session" });
    expect(resolveNlqMode({ user: "mcp", env: "rest" })).toMatchObject({ mode: "mcp", level: "user" });
  });
  it("a blank run falls through to session", () => {
    expect(resolveNlqMode({ run: "  ", session: "mcp" })).toMatchObject({ mode: "mcp", level: "session" });
  });
  it("an invalid winning value fails closed to rest without falling through", () => {
    expect(resolveNlqMode({ run: "bogus", env: "mcp" })).toEqual({ mode: "rest", invalid: true, raw: "bogus", level: "run" });
    expect(resolveNlqMode({ env: "bogus" })).toMatchObject({ mode: "rest", invalid: true, level: "env" });
  });
  it("a non-string winning value is invalid, not silently rest", () => {
    expect(resolveNlqMode({ run: 42 as any })).toMatchObject({ mode: "rest", invalid: true, level: "run" });
  });
  it("levelsForNlq maps the scoped carrier + run + env", () => {
    expect(levelsForNlq({ session: "mcp", user: "rest" }, undefined, "rest")).toEqual({
      run: undefined,
      session: "mcp",
      user: "rest",
      env: "rest",
    });
    expect(levelsForNlq(undefined, "rest", undefined).run).toBe("rest");
  });
  it("the config-error event name is nlq.config_error", () => {
    expect(nlqConfigErrorEvent()).toBe("nlq.config_error");
  });
});

describe("REST POST /nlq: rest vs mcp port contract", () => {
  it("default (rest) passes the full port set + validateWithLLM passthrough", async () => {
    nlqMock().mockClear();
    const audit = vi.fn();
    const ctx = routeCtx({ audit });
    const res = await postNlq(ctx, { query: "show me trades", validateWithLLM: true });
    expect(res!.status).toBe(200);
    const args = nlqMock().mock.calls[0];
    expect(args[4]).toBe("bob");
    expect(args[6].schedulingPort).toEqual({ id: "scheduling" });
    expect(args[6].socialBriefPort).toEqual({ id: "social" });
    expect(args[6].scanRunStore).toBeDefined();
    expect(args[6].profileStore).toBeDefined();
    expect(args[6].discoveryRunner).toBeDefined();
    expect(args[6].fitDiscoveryRunner).toBeDefined();
    expect(args[6].stockScreenPort).toBeUndefined();
    expect(args[6].validateWithLLM).toBe(true);
    expect(audit).toHaveBeenCalledWith("nlq.executed", "nlq", expect.objectContaining({ query: "show me trades" }));
  });
  it("body mode mcp threads storage only (capture): ports/stores/runners stay absent", async () => {
    nlqMock().mockClear();
    const audit = vi.fn();
    const blob = { id: "blob" };
    const ctx = routeCtx({ audit, getStorage: () => blob });
    const res = await postNlq(ctx, { query: "show me trades", mode: "mcp" });
    expect(res!.status).toBe(200);
    const args = nlqMock().mock.calls[0];
    expect(args[4]).toBe("bob");
    expect(args[6]).toBeDefined();
    expect(args[6].storage).toBe(blob);
    expect(Object.keys(args[6])).toEqual(["storage"]);
    expect(args[6].schedulingPort).toBeUndefined();
    expect(args[6].socialBriefPort).toBeUndefined();
    expect(args[6].discoveryRunner).toBeUndefined();
    expect(args[6].fitDiscoveryRunner).toBeUndefined();
    expect(args[6].scanRunStore).toBeUndefined();
    expect(args[6].profileStore).toBeUndefined();
    expect(audit).toHaveBeenCalledWith("nlq.executed", "nlq", expect.objectContaining({ query: "show me trades" }));
  });
  it("env NLQ_MODE=mcp selects mcp without a body mode (storage threaded)", async () => {
    nlqMock().mockClear();
    const blob = { id: "blob" };
    const ctx = routeCtx({ env: { NLQ_MODE: "mcp" }, getStorage: () => blob });
    await postNlq(ctx, { query: "show me trades" });
    expect(nlqMock().mock.calls[0][6]).toBeDefined();
    expect(nlqMock().mock.calls[0][6].storage).toBe(blob);
    expect(Object.keys(nlqMock().mock.calls[0][6])).toEqual(["storage"]);
  });
  it("session carrier on the route ctx selects mcp (storage threaded)", async () => {
    nlqMock().mockClear();
    const blob = { id: "blob" };
    const ctx = routeCtx({ scopedNlqModes: { session: "mcp" }, getStorage: () => blob });
    await postNlq(ctx, { query: "show me trades" });
    expect(nlqMock().mock.calls[0][6]).toBeDefined();
    expect(nlqMock().mock.calls[0][6].storage).toBe(blob);
    expect(Object.keys(nlqMock().mock.calls[0][6])).toEqual(["storage"]);
  });
  it("webhook + rest withholds ONLY the social port (scheduling stays)", async () => {
    nlqMock().mockClear();
    const ctx = routeCtx();
    await postNlq(ctx, { query: "show me trades" }, { "x-nlq-source": "webhook" });
    const args = nlqMock().mock.calls[0];
    expect(args[6].socialBriefPort).toBeUndefined();
    expect(args[6].schedulingPort).toEqual({ id: "scheduling" });
    expect(args[6].discoveryRunner).toBeDefined();
  });
  it("webhook + run mode rest can never re-grant the social port", async () => {
    nlqMock().mockClear();
    const ctx = routeCtx();
    await postNlq(ctx, { query: "show me trades", mode: "rest" }, { "x-nlq-source": "webhook" });
    expect(nlqMock().mock.calls[0][6].socialBriefPort).toBeUndefined();
  });
  it("the x-user-login gate stands in mcp mode (401, no execution)", async () => {
    nlqMock().mockClear();
    const ctx = routeCtx();
    const res = await handleMcpChatNlqRoutes(
      req("POST", "/nlq", { query: "show me trades", mode: "mcp" }),
      new URL("https://agent.internal/nlq"),
      "/nlq",
      "sess",
      ctx
    );
    expect(res!.status).toBe(401);
    expect(nlqMock()).not.toHaveBeenCalled();
  });
  it("an invalid mode fails closed to rest and audits nlq.config_error", async () => {
    nlqMock().mockClear();
    const audit = vi.fn();
    const ctx = routeCtx({ audit });
    await postNlq(ctx, { query: "show me trades", mode: "bogus" });
    expect(nlqMock().mock.calls[0][6].schedulingPort).toEqual({ id: "scheduling" });
    expect(audit).toHaveBeenCalledWith("nlq.config_error", "nlq", expect.objectContaining({ setting: "NLQ_MODE", resolved: "rest" }));
  });
});

describe("MCP execute_nlq: facade vs direct, rest vs mcp", () => {
  it("direct, default rest: full function, no options, sessionId identity, audit", async () => {
    nlqMock().mockClear();
    const { ctx, audit } = toolCtx();
    const result = await McpToolFactory.executeTool("execute_nlq", { query: "show me trades" }, ctx);
    expect(result.domain).toBe("test");
    const args = nlqMock().mock.calls[0];
    expect(args[1]).toBe("sess-1");
    expect(args[4]).toBe("sess-1");
    expect(args[5]).toBeUndefined();
    expect(args[6]).toBeUndefined();
    expect(audit).toHaveBeenCalledWith("nlq.executed", "nlq", expect.objectContaining({ query: "show me trades" }));
  });
  it("direct, mode mcp: legacy direct verbatim (full function, no options)", async () => {
    nlqMock().mockClear();
    const { ctx } = toolCtx();
    await McpToolFactory.executeTool("execute_nlq", { query: "show me trades", mode: "mcp" }, ctx);
    expect(nlqMock().mock.calls[0][6]).toBeUndefined();
  });
  it("facade, mode mcp: legacy plan+async via the facade, full function NOT called", async () => {
    nlqMock().mockClear();
    const facade = { executeNlq: vi.fn(async () => ({ domain: "facade", count: 1 })) };
    const { ctx } = toolCtx({ facade });
    const result = await McpToolFactory.executeTool("execute_nlq", { query: "show me trades", mode: "mcp" }, ctx);
    expect(facade.executeNlq).toHaveBeenCalledWith("show me trades");
    expect(result.domain).toBe("facade");
    expect(nlqMock()).not.toHaveBeenCalled();
  });
  it("facade, default rest: full function (validation restored), facade NOT called", async () => {
    nlqMock().mockClear();
    const facade = { executeNlq: vi.fn(async () => ({ domain: "facade", count: 1 })) };
    const { ctx, audit } = toolCtx({ facade });
    const result = await McpToolFactory.executeTool("execute_nlq", { query: "show me trades" }, ctx);
    expect(facade.executeNlq).not.toHaveBeenCalled();
    expect(nlqMock()).toHaveBeenCalledTimes(1);
    expect(result.domain).toBe("test");
    expect(audit).toHaveBeenCalledWith("nlq.executed", "nlq", expect.objectContaining({ query: "show me trades" }));
  });
  it("facade, env NLQ_MODE=mcp: legacy facade path", async () => {
    nlqMock().mockClear();
    const facade = { executeNlq: vi.fn(async () => ({ domain: "facade", count: 1 })) };
    const { ctx } = toolCtx({ facade, env: { NLQ_MODE: "mcp" } });
    await McpToolFactory.executeTool("execute_nlq", { query: "show me trades" }, ctx);
    expect(facade.executeNlq).toHaveBeenCalledTimes(1);
    expect(nlqMock()).not.toHaveBeenCalled();
  });
  it("facade, session carrier mcp: legacy facade path", async () => {
    nlqMock().mockClear();
    const facade = { executeNlq: vi.fn(async () => ({ domain: "facade", count: 1 })) };
    const { ctx } = toolCtx({ facade, scopedNlqModes: { session: "mcp" } });
    await McpToolFactory.executeTool("execute_nlq", { query: "show me trades" }, ctx);
    expect(facade.executeNlq).toHaveBeenCalledTimes(1);
  });
  it("invalid mode fails closed to rest and audits nlq.config_error", async () => {
    nlqMock().mockClear();
    const facade = { executeNlq: vi.fn(async () => ({ domain: "facade", count: 1 })) };
    const { ctx, audit } = toolCtx({ facade });
    await McpToolFactory.executeTool("execute_nlq", { query: "show me trades", mode: "bogus" }, ctx);
    expect(facade.executeNlq).not.toHaveBeenCalled();
    expect(nlqMock()).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith("nlq.config_error", "orchestrator", expect.objectContaining({ setting: "NLQ_MODE", resolved: "rest" }));
  });
});

describe("async job nlq.execute: rest vs mcp port contract", () => {
  // Minimal mas_async_jobs fake (same idiom as the #1236 feed tests):
  // MockSqlStorage's UPDATE returns no rowsWritten, so the executor's
  // claim (rowsWritten !== 1 → return) would silently skip the job.
  class FakeJobSql {
    rows: Array<Record<string, unknown>> = [];
    exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
      const q = query.trim().replace(/\s+/g, " ");
      const done = (rows: Array<Record<string, unknown>>, rowsWritten = 0) =>
        Object.assign([...rows], { rowsWritten });
      if (/^CREATE TABLE/i.test(q) || /^CREATE INDEX/i.test(q) || /^PRAGMA/i.test(q)) return done([]);
      if (/^DELETE FROM/i.test(q)) return done([]);
      if (/^INSERT INTO mas_async_jobs/i.test(q)) {
        const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
        const valueTokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
        const row: Record<string, unknown> = {};
        let argIndex = 0;
        cols.forEach((col, i) => {
          const token = valueTokens[i];
          row[col] = token === "?" ? (args[argIndex++] ?? null) : token.replace(/^'|'$/g, "");
        });
        this.rows.push(row);
        return done([], 1);
      }
      if (/^INSERT INTO/i.test(q)) return done([]);
      if (/^UPDATE mas_async_jobs/i.test(q)) {
        const setPart = q.match(/SET (.+?) WHERE/i)![1];
        const wherePart = q.match(/WHERE (.+)$/i)![1];
        const assignments = setPart.split(",").map((s) => s.trim());
        const conditions = wherePart.split(" AND ").map((s) => s.trim());
        let argIndex = 0;
        const setValues: Record<string, unknown> = {};
        for (const a of assignments) {
          const [col, token] = a.split("=").map((s) => s.trim());
          setValues[col] = token === "?" ? args[argIndex++] : token.replace(/^'|'$/g, "");
        }
        const condValues: Array<{ col: string; value: unknown }> = [];
        for (const c of conditions) {
          const [col, token] = c.split("=").map((s) => s.trim());
          condValues.push({ col, value: token === "?" ? args[argIndex++] : token.replace(/^'|'$/g, "") });
        }
        let written = 0;
        for (const row of this.rows) {
          if (condValues.every(({ col, value }) => row[col] === value)) {
            Object.assign(row, setValues);
            written++;
          }
        }
        return done([], written);
      }
      if (/^SELECT/i.test(q)) {
        const colsPart = q.match(/SELECT (.+?) FROM mas_async_jobs/i)![1].trim();
        let rows = [...this.rows];
        const whereMatch = q.match(/WHERE (.+)$/i);
        if (whereMatch) {
          const conditions = whereMatch[1].split(" AND ").map((s) => s.trim());
          let argIndex = 0;
          for (const c of conditions) {
            const [col, token] = c.split("=").map((s) => s.trim());
            const value = token === "?" ? args[argIndex++] : token.replace(/^'|'$/g, "");
            rows = rows.filter((r) => r[col] === value);
          }
        }
        if (colsPart === "*") return done(rows);
        const cols = colsPart.split(",").map((c) => c.trim());
        return done(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
      }
      throw new Error(`FakeJobSql: unsupported query: ${q.slice(0, 100)}`);
    }
  }

  const jobCtx = (sql: FakeJobSql, audit: any, env: any = { AGENT_DB: new MockD1Database() }) =>
    ({
      // #6503 — the rest-mode nlq.execute path builds the
      // agent-schedule capability over the D1 unified store
      // (fail-closed without AGENT_DB, so the job never reaches
      // the NLQ function); the mcp-direct path does not.
      env,
      agentCtx: { storage: { sql } } as any,
      ensureTables: () => sql,
      sessionKey: () => "sess-1",
      schedule: vi.fn(async () => ({})),
      audit,
      getOrm: () => ({}) as any,
      routeRequest: vi.fn(async () => new Response("ok")),
      nlqSchedulingPort: () => ({ id: "scheduling" }),
      nlqStockScreenPort: () => ({ id: "stockScreen" }),
    }) as any;

  it("default (rest) passes scheduling + stock screen + stores + discovery runners, no social", async () => {
    nlqMock().mockClear();
    const sql = new FakeJobSql();
    const audit = vi.fn();
    const ctx = jobCtx(sql, audit);
    const { jobId } = await submitAsyncJob(ctx, { capability: "nlq.execute", payload: { query: "show me trades", userLogin: "bob" } } as any);
    await executeAsyncJob(ctx, { jobId });
    expect(nlqMock()).toHaveBeenCalledTimes(1);
    const args = nlqMock().mock.calls[0];
    expect(args[4]).toBe("bob");
    expect(args[6].schedulingPort).toEqual({ id: "scheduling" });
    expect(args[6].stockScreenPort).toEqual({ id: "stockScreen" });
    expect(args[6].socialBriefPort).toBeUndefined();
    expect(args[6].scanRunStore).toBeDefined();
    expect(args[6].profileStore).toBeDefined();
    expect(args[6].discoveryRunner).toBeDefined();
    expect(args[6].fitDiscoveryRunner).toBeDefined();
  });
  it("payload mode mcp drops to the MCP-direct shape: full function, NO options", async () => {
    nlqMock().mockClear();
    const sql = new FakeJobSql();
    const audit = vi.fn();
    const ctx = jobCtx(sql, audit);
    const { jobId } = await submitAsyncJob(ctx, { capability: "nlq.execute", payload: { query: "show me trades", userLogin: "bob", mode: "mcp" } } as any);
    await executeAsyncJob(ctx, { jobId });
    const args = nlqMock().mock.calls[0];
    expect(args[4]).toBe("bob");
    expect(args[6]).toBeUndefined();
  });
  it("payload invalid mode fails closed to rest and audits nlq.config_error", async () => {
    nlqMock().mockClear();
    const sql = new FakeJobSql();
    const audit = vi.fn();
    const ctx = jobCtx(sql, audit);
    const { jobId } = await submitAsyncJob(ctx, { capability: "nlq.execute", payload: { query: "show me trades", userLogin: "bob", mode: "bogus" } } as any);
    await executeAsyncJob(ctx, { jobId });
    expect(nlqMock().mock.calls[0][6].schedulingPort).toEqual({ id: "scheduling" });
    expect(audit).toHaveBeenCalledWith("nlq.config_error", "orchestrator", expect.objectContaining({ setting: "NLQ_MODE", resolved: "rest" }));
  });
});
