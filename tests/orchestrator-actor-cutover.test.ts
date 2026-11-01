import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The agents SDK module graph pulls `cloudflare:` imports the node
// loader cannot resolve — mock it with a plain base class, the
// api_chat_route.test.ts idiom. The orchestrator's own methods run
// for real; the turn runner is real too, with only its provider
// boundary stubbed (generateTextModelTurn below) — the lifecycle is
// not stubbed. @cloudflare/ai-chat is mocked because the
// orchestrator's routes graph reaches BrowserAgent/SlackAgent, which
// extend AIChatAgent.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
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
// Issue #1952: the Think engine itself cannot load under Node (its
// module graph needs workerd schemes), so the test stubs Think's
// runTurn at the engine boundary — the same idiom as the old
// generateTextModelTurn stub. Everything above the engine stays
// real: the foundation adapter (ThinkActorTurn) and PortThink's
// one-shot + hook-order translation run for real; only the model
// inference step is stubbed. The stub drives PortThink's hooks
// exactly as the engine would: beforeTurn (consuming the one-shot
// the adapter installed), then onChatResponse (record-only during
// a facet turn, flushed by the adapter after the append).
const thinkStubControl = vi.hoisted(() => ({
  entered: false,
  deferred: null as null | { promise: Promise<void>; resolve: () => void },
  failNext: false,
}));
vi.mock("@cloudflare/think", () => {
  return {
    Think: class StubThink {
      ctx: any;
      env: any;
      lifecycle: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        // The adapter boots this before every turn (idempotent in
        // the real engine); a no-op here keeps the boot call real.
        this.lifecycle = { start: async () => {} };
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
      async listSchedules() {
        return [];
      }
      async cancelSchedule(_id: string) {
        return true;
      }
      // The class's dual-store clear calls super.clearMessages()
      // for the tree session; a no-op here keeps that call real
      // (the port transcript clear is what the tests assert).
      async clearMessages() {}
      // Issue #2566: the durable submission surface. The chat-turn
      // driver now submits through Think's submission queue, so
      // this stub implements it at the same engine boundary as
      // runTurn below: submissions persist in the fake ctx storage,
      // execute FIFO driving PortThink's hooks (beforeTurn ->
      // onChatResponse, onChatError on failure, cancellation
      // honored after beforeTurn), and waitForSubmission drains.
      async getMessages() {
        return (await this.ctx.storage.get("stubThink:session")) ?? [];
      }
      async submitMessages(messages: any[], options?: any) {
        const rows = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        if (options?.idempotencyKey) {
          const existing = Object.values(rows).find((r: any) => r.idempotencyKey === options.idempotencyKey) as any;
          if (existing) return { ...existing, status: existing.status, accepted: false };
        }
        const row: any = {
          submissionId: options?.submissionId ?? crypto.randomUUID(),
          idempotencyKey: options?.idempotencyKey,
          status: "pending",
          messages: Array.isArray(messages) ? messages : [messages],
          metadata: options?.metadata,
          createdAt: Date.now(),
        };
        rows[row.submissionId] = row;
        await this.ctx.storage.put("stubThink:submissions", rows);
        return { submissionId: row.submissionId, idempotencyKey: row.idempotencyKey, status: row.status, metadata: row.metadata, createdAt: row.createdAt, accepted: true };
      }
      async inspectSubmission(submissionId: string) {
        const rows = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        const row = rows[submissionId];
        if (!row) return null;
        return { submissionId: row.submissionId, idempotencyKey: row.idempotencyKey, status: row.status, error: row.error, messageId: row.messageId, metadata: row.metadata, createdAt: row.createdAt, startedAt: row.startedAt, completedAt: row.completedAt };
      }
      async cancelSubmission(submissionId: string) {
        const rows = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        const row = rows[submissionId];
        if (!row) return { outcome: "not_found", submissionId };
        if (["completed", "aborted", "skipped", "error"].includes(row.status)) {
          return { outcome: "already_terminal", submissionId, submission: await this.inspectSubmission(submissionId) };
        }
        if (row.status === "pending") {
          row.status = "aborted";
          row.completedAt = Date.now();
          await this.ctx.storage.put("stubThink:submissions", rows);
          return { outcome: "cancelled", submissionId, previousStatus: "pending" };
        }
        row.cancelRequested = true;
        await this.ctx.storage.put("stubThink:submissions", rows);
        return { outcome: "cancelled", submissionId, previousStatus: "running" };
      }
      async waitForSubmission(submissionId: string) {
        for (;;) {
          const rows = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
          const pending = Object.values(rows)
            .filter((r: any) => r.status === "pending")
            .sort((a: any, b: any) => a.createdAt - b.createdAt) as any[];
          if (pending.length === 0) break;
          await this.driveSubmission(pending[0].submissionId);
          const after = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
          const target = after[submissionId];
          if (target && target.status !== "pending" && target.status !== "running") break;
        }
        return this.inspectSubmission(submissionId);
      }
      async driveSubmission(submissionId: string) {
        const rows = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        const row = rows[submissionId];
        if (!row || row.status !== "pending") return;
        row.status = "running";
        row.startedAt = Date.now();
        await this.ctx.storage.put("stubThink:submissions", rows);
        const session = await this.getMessages();
        for (const msg of row.messages) {
          const at = session.findIndex((m: any) => m.id === msg.id);
          if (at >= 0) session[at] = msg;
          else session.push(msg);
        }
        await this.ctx.storage.put("stubThink:session", session);
        thinkStubControl.entered = true;
        if (thinkStubControl.deferred) await thinkStubControl.deferred.promise;
        const ctx = {
          system: "",
          messages: session.map((m: any) => ({
            role: m.role,
            content: (m.parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join(""),
          })),
          tools: {},
          model: undefined,
          continuation: false,
          body: {},
        };
        await (this as any).beforeTurn(ctx);
        if (thinkStubControl.failNext) {
          thinkStubControl.failNext = false;
          const err = new Error("stub model failure");
          (this as any).onChatError?.(err);
          const fresh = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
          fresh[submissionId].status = "error";
          fresh[submissionId].error = err.message;
          fresh[submissionId].completedAt = Date.now();
          await this.ctx.storage.put("stubThink:submissions", fresh);
          return;
        }
        const fresh = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        if (fresh[submissionId].cancelRequested) {
          fresh[submissionId].status = "aborted";
          fresh[submissionId].completedAt = Date.now();
          await this.ctx.storage.put("stubThink:submissions", fresh);
          return;
        }
        const message = {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "Stub assistant reply." }],
        };
        const sessionAfter = await this.getMessages();
        sessionAfter.push(message);
        await this.ctx.storage.put("stubThink:session", sessionAfter);
        const marked = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        marked[submissionId].messageId = message.id;
        await this.ctx.storage.put("stubThink:submissions", marked);
        await (this as any).onChatResponse({
          message,
          requestId: crypto.randomUUID(),
          continuation: false,
          status: "completed",
        });
        const done = (await this.ctx.storage.get("stubThink:submissions")) ?? {};
        done[submissionId].status = "completed";
        done[submissionId].completedAt = Date.now();
        await this.ctx.storage.put("stubThink:submissions", done);
      }
      async runTurn(_options: any) {
        thinkStubControl.entered = true;
        if (thinkStubControl.deferred) await thinkStubControl.deferred.promise;
        if (thinkStubControl.failNext) {
          thinkStubControl.failNext = false;
          throw new Error("stub model failure");
        }
        const ctx = { system: "", messages: [], tools: {}, model: undefined, continuation: false, body: {} };
        await (this as any).beforeTurn(ctx);
        const message = {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "Stub assistant reply." }],
        };
        await (this as any).onChatResponse({
          message,
          requestId: crypto.randomUUID(),
          continuation: false,
          status: "completed",
        });
        return { status: "completed", message, requestId: crypto.randomUUID(), continuation: false };
      }
    },
  };
});
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      messages: any[];
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.messages = [];
      }
    },
  };
});
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      throw new Error("generateText disabled in cutover tests");
    }),
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { LLMJudge } from "../src/agents/judge";
import {
  buildOrchestratorSystemPrompt,
  resolveMasMaxSteps,
  resolveShadowMaxSteps,
} from "../src/agents/chatPrompt";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import { resolveAiModelName } from "../src/agents/model";
import { EXPECTED_PROMPTS } from "./orchestrator-prompt-fixtures";
import { MockSqlStorage } from "./mock-sql";
import judgeGolden from "./fixtures/judge-golden.json";

/**
 * Issue #686 (Think migration step 4 — CUTOVER), re-pointed by
 * issue #1738 at the Agents SDK actor.
 *
 * The production OrchestratorAgent is a Think-backed actor under its
 * stable identity. This suite carries forward the step-3a/3b evidence
 * pins (prompt byte-identity, clamp, route parity, turn shape, side
 * effects, bounds) re-pointed at the real class, and adds the
 * cutover-specific pins: R1 identity stability, R6 legacy lift,
 * R5 onChatError format. Turns run through the real Think turn
 * facet with the Think engine stubbed (see the mocks above).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// MockSqlStorage returns plain arrays from exec(); the job claim
// gate reads rowsWritten off the cursor (see the 3b suite).
class ClaimAwareSql extends MockSqlStorage {
  exec(query: string, ...args: unknown[]): any {
    const result = super.exec(query, ...args) as any;
    if (/^\s*UPDATE\s+mas_async_jobs\s+SET\s+status = 'running'/i.test(query)) {
      const rows = Array.from(
        super.exec("SELECT job_id, status FROM mas_async_jobs WHERE job_id = ?", args[2])
      ) as Array<{ status?: string }>;
      result.rowsWritten = rows.length > 0 && rows[0].status === "running" ? 1 : 0;
    }
    return result;
  }
}

function makeAgent(env: Record<string, unknown> = { AI: {} }) {
  const sql = new ClaimAwareSql();
  // Issue #1738: the actor session store runs on the DO key-value
  // API (ctx.storage.get/put/delete), not on SQL — the test ctx
  // carries a Map-backed implementation of it.
  const kv = new Map<string, unknown>();
  const ctx = {
    id: { toString: () => "cutover-session-1" },
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
  };
  const agent = new OrchestratorAgent(ctx as never, env as never) as any;
  return { agent, sql };
}

function readMessages(sql: MockSqlStorage) {
  return Array.from(sql.exec("SELECT role, content, agent FROM mas_messages")) as Array<{
    role: string;
    content: string;
    agent: string;
  }>;
}

function readEvents(sql: MockSqlStorage) {
  return (
    Array.from(sql.exec("SELECT type, agent, payload FROM mas_events")) as Array<{
      type: string;
      agent: string;
      payload: string;
    }>
  ).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
}

describe("#686 R1 — identity stability under the cutover", () => {
  it("the production class extends PortThink; the shadow file is gone", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("extends PortThink");
    expect(orch).toContain('from "../actors/thinkAdapter"');
    expect(orch).toContain('from "agents"');
    expect(orch).not.toContain("@cloudflare/ai-chat");
    // No direct Think import: the class reaches Think only through
    // PortThink in the foundation adapter (the agent-conformance
    // pin enforces the same from the other side).
    expect(orch).not.toContain("@cloudflare/think");
    expect(fs.existsSync(path.join(ROOT, "src/agents/orchestrator-think.ts"))).toBe(false);
  });

  it("server export and wrangler binding/migrations carry the #2523 rename", () => {
    expect(read("src/server.ts")).toContain(
      'export { OrchestratorAgent } from "./agents/orchestrator"'
    );
    expect(read("src/server.ts")).not.toContain(
      "OrchestratorAgent as SearchAgent"
    );
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toContain('{ "name": "SEARCH_AGENT", "class_name": "OrchestratorAgent" }');
    expect(wrangler).toContain('{ "tag": "v1", "new_sqlite_classes": ["SearchAgent"] }');
    // Scoped to the cutover's own facts (#714): later migrations for
    // OTHER classes are legitimate and must not trip this pin — the
    // invariant is that SearchAgent's v1 migration stays the sole
    // migration creating it.
    const searchAgentMigrations = wrangler.match(/"new_sqlite_classes": \[[^\]]*"SearchAgent"[^\]]*\]/g) ?? [];
    expect(searchAgentMigrations).toEqual(['"new_sqlite_classes": ["SearchAgent"]']);
  });

  it("the routes ctx bag exposes Actor session accessors, not AIChatAgent ones", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("getMessages: () => this.getPortMessages()");
    expect(orch).not.toContain("this.messages");
    const routes = read("src/agents/routes/mcpChatNlq.ts");
    expect(routes).not.toContain("setMessages");
    expect(routes).not.toContain("persistMessages");
  });
});

describe("#686 carried-forward 3a pins — prompt builder byte-identity + clamp", () => {
  it("plain route, no contexts", () => {
    expect(
      buildOrchestratorSystemPrompt({
        route: { agent: "search", confidence: 0.92, reason: "test route" },
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    ).toBe(EXPECTED_PROMPTS.plain);
  });

  it("grounded + auto-research fixtures still match the pre-extraction template", () => {
    expect(
      buildOrchestratorSystemPrompt({
        route: { agent: "trading", confidence: 1, reason: "Direct execution" },
        memoryContext: '\nActive Persistent Memory (SQLite Session Facts):\n- risk: "conservative"',
        vectorContext: "\nRelevant past outcomes (vector memory, most similar first):\n- prior run summary",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    ).toBe(EXPECTED_PROMPTS.grounded);
    expect(
      buildOrchestratorSystemPrompt({
        route: {
          agent: "trading",
          confidence: 1,
          reason: "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
        },
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: 'AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:\n{"query":"scan","jobId":"job-1","status":"queued"}',
        isAutoOptionsResearchRequest: true,
      })
    ).toBe(EXPECTED_PROMPTS.autoResearch);
  });

  it("R8: the sanitized clamp is now the production resolver for the class", () => {
    expect(makeAgent({ AI: {} }).agent.maxSteps).toBe(6);
    expect(makeAgent({ AI: {}, MAS_MAX_STEPS: "99" }).agent.maxSteps).toBe(10);
    // The deliberate delta: non-numeric no longer propagates NaN.
    expect(Number.isNaN(resolveMasMaxSteps({ MAS_MAX_STEPS: "abc" } as never))).toBe(true);
    expect(makeAgent({ AI: {}, MAS_MAX_STEPS: "abc" }).agent.maxSteps).toBe(resolveShadowMaxSteps({ MAS_MAX_STEPS: "abc" } as never));
    expect(makeAgent({ AI: {}, MAS_MAX_STEPS: "abc" }).agent.maxSteps).toBe(6);
  });
});

describe("#686 Actor surface on the production class", () => {
  it("model: constructed arm, same id as today's resolution", () => {
    const { agent } = makeAgent();
    expect((agent.getModel() as { modelId: string }).modelId).toBe(
      resolveAiModelName({ AI: {} } as never)
    );
  });

  it("tools: name set equals the live factory's set", () => {
    const { agent } = makeAgent();
    const classNames = Object.keys(agent.getTools()).sort();
    const factoryNames = Object.keys(
      createAgentMcpTools({
        env: { AI: {} } as never,
        orm: {} as never,
        sessionId: "cutover-session-1",
        requestId: "cutover-test",
        audit: () => {},
      })
    ).sort();
    expect(classNames).toEqual(factoryNames);
  });

  it("system prompt fallback comes from the shared builder; memory block registered", async () => {
    const { agent } = makeAgent();
    expect(agent.getSystemPrompt()).toContain("You are the master orchestrator");
    const blocks = await agent.configureContext();
    expect(blocks.map((b: any) => b.label)).toContain("session-memory");
  });
});

const GOLDEN = (
  judgeGolden as {
    entries: Array<{
      id: string;
      text: string;
      expectedIntent: string;
      expectedConfidence: number;
      expectedNeedsConfirmation: boolean;
      recentMessages?: Array<{ role: string; content: string }>;
    }>;
  }
).entries;

describe("#686 R2/R3/R4 — the production turn, through runAgenticChatTurn", () => {
  it("route parity across the golden corpus, now on the real class", async () => {
    const failures: string[] = [];
    for (const entry of GOLDEN) {
      const recent = (entry.recentMessages ?? []) as Array<{ role?: string; content: string }>;
      const live = await new LLMJudge({} as never).route(entry.text, recent);
      const { agent } = makeAgent();
      const { route } = await agent.runAgenticChatTurn({
        userText: entry.text,
        recentTurns: recent,
        userLogin: "cutover-tester",
        isAutoOptionsResearchRequest: false,
      });
      if (
        route.agent !== live.agent ||
        route.confidence !== live.confidence ||
        route.reason !== live.reason ||
        route.needsConfirmation !== live.needsConfirmation
      ) {
        failures.push(`${entry.id}: class route != live judge route`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("turn result keeps the adapter contract {result:{text}, route}", async () => {
    const { agent } = makeAgent();
    const { result, route } = await agent.runAgenticChatTurn({
      userText: "hello there",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(await result.text).toBe("Stub assistant reply.");
    expect(Object.keys(route).sort()).toEqual(["agent", "confidence", "needsConfirmation", "reason"]);
  });

  it("side effects land exactly once: user + assistant rows, route.decided + response.evaluated", async () => {
    const { agent, sql } = makeAgent();
    const { route } = await agent.runAgenticChatTurn({
      userText: "remember that my risk tolerance is conservative",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(readMessages(sql)).toEqual([
      {
        role: "user",
        content: "remember that my risk tolerance is conservative",
        agent: "orchestrator",
      },
      { role: "assistant", content: "Stub assistant reply.", agent: route.agent },
    ]);
    const events = readEvents(sql);
    const decided = events.find((e) => e.type === "route.decided");
    expect(decided?.payload).toEqual({
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });
    const evaluated = events.find((e) => e.type === "response.evaluated");
    expect(evaluated?.payload).toEqual({
      score: 75,
      grounded: true,
      safe: true,
      issues: ["Automated evaluation skipped due to judge timeout or rate limit"],
    });
  });

  it("re-send of the history tail: no duplicate session user message, no duplicate user record", async () => {
    const { agent, sql } = makeAgent();
    const opts = {
      userText: "same question",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: false,
    };
    await agent.runAgenticChatTurn(opts);
    await agent.runAgenticChatTurn(opts);
    const session = await agent.getPortMessages();
    expect(session.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(session.filter((m: any) => m.role === "assistant")).toHaveLength(2);
    expect(readMessages(sql).filter((m) => m.role === "user")).toHaveLength(1);
    expect(readMessages(sql).filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("auto-research: synthetic route, pre-dispatch, suppression in the applied TurnConfig", async () => {
    const { agent, sql } = makeAgent();
    // The facet applies what the domain hook returns but stores
    // nothing on the agent; capture the applied TurnConfig by
    // wrapping the hook on the instance (the config object itself
    // is untouched). Issue #1952: the domain hook is portBeforeTurn
    // — PortThink owns the beforeTurn name for its one-shot protocol.
    const origBeforeTurn = agent.portBeforeTurn.bind(agent);
    agent.portBeforeTurn = async (ctx: any) => {
      agent.__turnConfig = await origBeforeTurn(ctx);
      return agent.__turnConfig;
    };
    const { route } = await agent.runAgenticChatTurn({
      userText: "scan for oversold large caps",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: true,
      sourceTab: "E*TRADE · Auto Options Research",
    });
    expect(route).toEqual({
      agent: "trading",
      confidence: 1,
      reason:
        "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
      needsConfirmation: false,
    });
    const jobs = Array.from(sql.exec("SELECT capability, status FROM mas_async_jobs")) as Array<{
      capability: string;
      status: string;
    }>;
    expect(jobs).toEqual([{ capability: "nlq.execute", status: "queued" }]);
    expect(agent.__turnConfig.activeTools).toEqual([]);
    expect(agent.__turnConfig.maxSteps).toBe(6);
    const marker = "AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:\n";
    const at = agent.__turnConfig.instructions.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const jobLine = agent.__turnConfig.instructions.slice(at + marker.length).split("\n")[0];
    expect(agent.__turnConfig.instructions).toBe(
      buildOrchestratorSystemPrompt({
        route,
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: `${marker}${jobLine}`,
        isAutoOptionsResearchRequest: true,
      })
    );
  });
});

describe("#686 R5 — onChatError carries the live stream-error format", () => {
  it("formats [code] title: message + remediation steps", () => {
    const { agent } = makeAgent();
    // Issue #1952: the domain hook is portOnChatError — PortThink
    // owns the onChatError name for its fire-and-forget protocol.
    const out = agent.portOnChatError(new Error("provider exploded"));
    expect(typeof out).toBe("string");
    expect(out as string).toMatch(/^\[[A-Z_]+\] /);
    expect(out as string).toContain("Remediation:");
  });
});

describe("#1952 — the Think turn path on the production class", () => {
  it("aborted mid-flight turn lands no message and no response side effects", async () => {
    const { agent, sql } = makeAgent();
    // Park the stub engine inside runTurn, then run the
    // memory-reset sequence (the route's abort + stash reset +
    // transcript clear) before releasing it. Reset `entered` first:
    // earlier tests leave it true, and a stale true would let the
    // poll below exit before THIS turn reaches the gate (the abort
    // would then land before the epoch capture and gate nothing).
    thinkStubControl.entered = false;
    let release!: () => void;
    thinkStubControl.deferred = {
      promise: new Promise<void>((r) => {
        release = r;
      }),
      resolve: () => release(),
    };
    try {
      const turnPromise = agent.runAgenticChatTurn({
        userText: "hello there",
        recentTurns: [],
        userLogin: "cutover-tester",
        isAutoOptionsResearchRequest: false,
      });
      // Capture settlement so a turn that errors before the gate
      // cannot leave an unhandled rejection behind.
      let settled = false;
      turnPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      // Wait until the stub engine is parked at the gate: by then
      // the facet's beforeTurn has run (route decided, user row
      // written, stash set) and the turn is in flight.
      for (let i = 0; i < 200 && !thinkStubControl.entered && !settled; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(thinkStubControl.entered).toBe(true);
      agent.abortAllRequests("Session reset requested by user");
      agent.resetTurnState();
      await agent.clearMessages();
      thinkStubControl.deferred.resolve();
      const { result, route } = await turnPromise;
      // The retired runner's aborted shape: empty text, route kept.
      expect(await result.text).toBe("");
      expect(Object.keys(route).sort()).toEqual(["agent", "confidence", "needsConfirmation", "reason"]);
      // No stale assistant message in the cleared transcript, and
      // no assistant record: the gated onChatResponse never fired.
      expect(await agent.getPortMessages()).toEqual([]);
      expect(readMessages(sql).filter((m) => m.role === "assistant")).toEqual([]);
      const events = readEvents(sql);
      expect(events.filter((e) => e.type === "route.decided")).toHaveLength(1);
      expect(events.filter((e) => e.type === "response.evaluated")).toEqual([]);
    } finally {
      // Release a still-parked stub so no turn dangles past the test.
      thinkStubControl.deferred?.resolve();
      thinkStubControl.deferred = null;
      thinkStubControl.entered = false;
    }
  });

  it("model failure reports through onChatError exactly once, then rethrows", async () => {
    const { agent, sql } = makeAgent();
    thinkStubControl.failNext = true;
    try {
      await expect(
        agent.runAgenticChatTurn({
          userText: "hello there",
          recentTurns: [],
          userLogin: "cutover-tester",
          isAutoOptionsResearchRequest: false,
        })
      ).rejects.toThrow("stub model failure");
    } finally {
      thinkStubControl.failNext = false;
    }
    // The aspect event the error hook logs fires exactly once: the
    // facet calls the hook on the throw path (the stub engine throws
    // before its own hook, so the facet's call is the only one).
    const events = readEvents(sql);
    expect(events.filter((e) => e.type === "chatstream.uistreamerror.error")).toHaveLength(1);
  });

  it("direct Think turn delegates to the port hooks (no one-shot installed)", async () => {
    const { agent, sql } = makeAgent();
    // A direct turn reads its user text from the port session, the
    // way the facet path seeds it before driving the turn.
    await agent.addPortMessages([
      { id: "direct-1", role: "user", parts: [{ type: "text", text: "hello there" }] } as any,
    ]);
    // PortThink.beforeTurn with no one-shot installed delegates to
    // the port hooks — this is the Think-signature name, not the
    // domain hook, so it must stay callable on the class.
    const config = await agent.beforeTurn({
      system: "",
      messages: [{ role: "user", content: "hello there" }],
      tools: {},
      model: undefined,
      continuation: false,
      body: {},
    });
    expect(config).toBeDefined();
    expect(typeof (config as any).instructions).toBe("string");
    expect((config as any).maxSteps).toBe(6);
    const events = readEvents(sql);
    expect(events.filter((e) => e.type === "route.decided")).toHaveLength(1);
    expect(readMessages(sql)).toEqual([
      { role: "user", content: "hello there", agent: "orchestrator" },
    ]);
  });
});

describe("#686 R6 — legacy session transform-migration (residual lift)", () => {
  it("imports a residual cf_ai_chat_agent_messages table by id and drops it on a clean lift", async () => {
    const { agent, sql } = makeAgent();
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at TEXT NOT NULL)"
    );
    const m1 = { id: "legacy-1", role: "user", parts: [{ type: "text", text: "old question" }] };
    const m2 = { id: "legacy-2", role: "assistant", parts: [{ type: "text", text: "old answer" }] };
    sql.exec(
      "INSERT INTO cf_ai_chat_agent_messages (id, message, created_at) VALUES (?, ?, ?)",
      "legacy-1",
      JSON.stringify(m1),
      "2026-01-01T00:00:00.000Z"
    );
    sql.exec(
      "INSERT INTO cf_ai_chat_agent_messages (id, message, created_at) VALUES (?, ?, ?)",
      "legacy-2",
      JSON.stringify(m2),
      "2026-01-01T00:01:00.000Z"
    );

    await agent.liftLegacyChatMessages();

    const messages = await agent.getPortMessages();
    expect(messages.map((m: any) => m.id)).toEqual(["legacy-1", "legacy-2"]);
    const stillThere = Array.from(
      sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'")
    );
    expect(stillThere).toEqual([]);
  });

  it("is a no-op when no legacy table exists", async () => {
    const { agent } = makeAgent();
    await agent.liftLegacyChatMessages();
    expect(await agent.getPortMessages()).toEqual([]);
  });
});
