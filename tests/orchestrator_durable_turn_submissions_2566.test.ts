import { describe, it, expect, vi, beforeEach } from "vitest";

// Issue #2566 (programme #2494): durable turn behavior via the SDK's
// submitMessages. The Think engine cannot load under Node (its module
// graph needs workerd schemes), so — the orchestrator-actor-cutover
// idiom — this suite stubs Think at the engine boundary. Unlike the
// cutover stub (facet runTurn only), this stub implements Think's
// DURABLE SUBMISSION surface faithfully at that boundary:
//   - submitMessages persists a submission row (in the fake ctx
//     storage, so it survives an "instance restart" = a second agent
//     object over the same storage) and dedupes by idempotency key;
//   - execution is FIFO, one submission at a time, driving the
//     class's PortThink hooks exactly as the engine's queue drain
//     would (beforeTurn -> onChatResponse, onChatError on failure);
//   - waitForSubmission is the drain trigger here (in production the
//     Lifecycle alarm + Queue capability drain without a waiter —
//     the class behavior under test does not depend on which);
//   - cancelSubmission on a running submission is signalled and the
//     drain honors it after beforeTurn, before any completion hook.
// Everything above the engine stays real: the production
// OrchestratorAgent, its portBeforeTurn/portOnChatResponse, the
// Judge, the port session store, and the mas_* records.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

const thinkStubControl = vi.hoisted(() => ({
  entered: false,
  deferred: null as null | { promise: Promise<void>; resolve: () => void },
  failNext: false,
}));

vi.mock("@cloudflare/think", () => {
  const SESSION_KEY = "stubThink:session";
  const SUBMISSIONS_KEY = "stubThink:submissions";

  type SubmissionRow = {
    submissionId: string;
    idempotencyKey?: string;
    status: "pending" | "running" | "completed" | "aborted" | "skipped" | "error";
    messages: any[];
    metadata?: Record<string, unknown>;
    messageId?: string;
    error?: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    cancelRequested?: boolean;
  };

  const inspection = (row: SubmissionRow) => ({
    submissionId: row.submissionId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    error: row.error,
    messageId: row.messageId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  });

  return {
    Think: class StubThink {
      ctx: any;
      env: any;
      lifecycle: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.lifecycle = { start: async () => {} };
      }
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

      // --- Think session (tree store), KV-backed so it persists
      // across stub instances sharing one ctx (the restart shape).
      async getMessages(): Promise<any[]> {
        return ((await this.ctx.storage.get(SESSION_KEY)) as any[]) ?? [];
      }
      async clearMessages(): Promise<void> {
        await this.ctx.storage.put(SESSION_KEY, []);
      }

      // --- Durable submissions (the #2566 surface).
      private async loadRows(): Promise<Record<string, SubmissionRow>> {
        return ((await this.ctx.storage.get(SUBMISSIONS_KEY)) as Record<string, SubmissionRow>) ?? {};
      }
      private async saveRows(rows: Record<string, SubmissionRow>): Promise<void> {
        await this.ctx.storage.put(SUBMISSIONS_KEY, rows);
      }

      async submitMessages(messages: any[], options?: any) {
        const rows = await this.loadRows();
        if (options?.idempotencyKey) {
          const existing = Object.values(rows).find((r) => r.idempotencyKey === options.idempotencyKey);
          if (existing) return { ...inspection(existing), accepted: false };
        }
        const row: SubmissionRow = {
          submissionId: options?.submissionId ?? crypto.randomUUID(),
          idempotencyKey: options?.idempotencyKey,
          status: "pending",
          messages: Array.isArray(messages) ? messages : [messages],
          metadata: options?.metadata,
          createdAt: Date.now(),
        };
        rows[row.submissionId] = row;
        await this.saveRows(rows);
        return { ...inspection(row), accepted: true };
      }

      async inspectSubmission(submissionId: string) {
        const rows = await this.loadRows();
        const row = rows[submissionId];
        return row ? inspection(row) : null;
      }

      async cancelSubmission(submissionId: string, _reason?: unknown) {
        const rows = await this.loadRows();
        const row = rows[submissionId];
        if (!row) return { outcome: "not_found", submissionId };
        if (["completed", "aborted", "skipped", "error"].includes(row.status)) {
          return { outcome: "already_terminal", submissionId, submission: inspection(row) };
        }
        if (row.status === "pending") {
          row.status = "aborted";
          row.completedAt = Date.now();
          await this.saveRows(rows);
          return { outcome: "cancelled", submissionId, previousStatus: "pending" };
        }
        row.cancelRequested = true;
        await this.saveRows(rows);
        return { outcome: "cancelled", submissionId, previousStatus: "running" };
      }

      /** The queue drain: run pending submissions FIFO until the
       *  waited-for one is terminal. Mirrors the engine's alarm loop
       *  (one item at a time, in submission order). */
      private async driveQueue(uptoId: string): Promise<void> {
        for (;;) {
          const rows = await this.loadRows();
          const pending = Object.values(rows)
            .filter((r) => r.status === "pending")
            .sort((a, b) => a.createdAt - b.createdAt);
          if (pending.length === 0) return;
          await this.driveOne(pending[0].submissionId);
          const after = await this.loadRows();
          const target = after[uptoId];
          if (target && target.status !== "pending" && target.status !== "running") return;
        }
      }

      private async driveOne(submissionId: string): Promise<void> {
        const rows = await this.loadRows();
        const row = rows[submissionId];
        if (!row || row.status !== "pending") return;
        row.status = "running";
        row.startedAt = Date.now();
        await this.saveRows(rows);
        // The engine applies the submitted messages to its session
        // when the submission's turn starts (upsert by id).
        const session = await this.getMessages();
        for (const msg of row.messages) {
          const at = session.findIndex((m: any) => m.id === msg.id);
          if (at >= 0) session[at] = msg;
          else session.push(msg);
        }
        await this.ctx.storage.put(SESSION_KEY, session);

        thinkStubControl.entered = true;
        if (thinkStubControl.deferred) await thinkStubControl.deferred.promise;

        const turnCtx = {
          system: "",
          messages: session.map((m: any) => ({
            role: m.role,
            content: (m.parts ?? [])
              .filter((p: any) => p?.type === "text")
              .map((p: any) => p.text)
              .join(""),
          })),
          tools: {},
          model: undefined,
          continuation: false,
          body: {},
        };
        await (this as any).beforeTurn(turnCtx);

        if (thinkStubControl.failNext) {
          thinkStubControl.failNext = false;
          const err = new Error("stub model failure");
          // The engine fires its error hook for a failed turn
          // (unawaited in the real engine; the hook is synchronous
          // by PortThink's design, so calling it here is faithful).
          (this as any).onChatError?.(err);
          const fresh = await this.loadRows();
          fresh[submissionId].status = "error";
          fresh[submissionId].error = err.message;
          fresh[submissionId].completedAt = Date.now();
          await this.saveRows(fresh);
          return;
        }

        const fresh = await this.loadRows();
        if (fresh[submissionId].cancelRequested) {
          // Aborted mid-turn: the completion hook never fires and no
          // assistant message lands (the engine's abort contract).
          fresh[submissionId].status = "aborted";
          fresh[submissionId].completedAt = Date.now();
          await this.saveRows(fresh);
          return;
        }

        const message = {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "Stub assistant reply." }],
        };
        const sessionAfter = await this.getMessages();
        sessionAfter.push(message);
        await this.ctx.storage.put(SESSION_KEY, sessionAfter);
        const marked = await this.loadRows();
        marked[submissionId].messageId = message.id;
        await this.saveRows(marked);
        await (this as any).onChatResponse({
          message,
          requestId: crypto.randomUUID(),
          continuation: false,
          status: "completed",
        });
        const done = await this.loadRows();
        done[submissionId].status = "completed";
        done[submissionId].completedAt = Date.now();
        await this.saveRows(done);
      }

      async waitForSubmission(submissionId: string, _options?: any) {
        await this.driveQueue(submissionId);
        return this.inspectSubmission(submissionId);
      }

      async runTurn(_input: unknown): Promise<never> {
        throw new Error(
          "Think stub: runTurn() is not implemented in the #2566 suite — " +
            "the durable-turn driver must submit, not drive the facet"
        );
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
      throw new Error("generateText disabled in #2566 tests");
    }),
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

const SESSION_KEY = "durable-turn-session-1";

function makeCtx() {
  const sql = new MockSqlStorage();
  const kv = new Map<string, unknown>();
  const ctx = {
    id: { toString: () => SESSION_KEY },
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
  return { ctx, sql, kv };
}

function makeAgent(ctx: unknown) {
  return new OrchestratorAgent(ctx as never, { AI: {} } as never) as any;
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

const TURN = {
  userText: "hello there",
  recentTurns: [],
  userLogin: "durable-tester",
  isAutoOptionsResearchRequest: false,
};

describe("#2566 — chat turn submission through Think's durable submission queue", () => {
  beforeEach(() => {
    thinkStubControl.entered = false;
    thinkStubControl.deferred = null;
    thinkStubControl.failNext = false;
  });

  it("completes a submitted turn and keeps the {result, route} contract with exactly-once side effects", async () => {
    const { ctx, sql } = makeCtx();
    const agent = makeAgent(ctx);
    const { result, route } = await agent.runAgenticChatTurn({ ...TURN });
    expect(await result.text).toBe("Stub assistant reply.");
    expect(Object.keys(route).sort()).toEqual(["agent", "confidence", "needsConfirmation", "reason"]);

    const session = await agent.getPortMessages();
    expect(session.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(readMessages(sql).map((m) => m.role)).toEqual(["user", "assistant"]);
    const events = readEvents(sql);
    expect(events.filter((e) => e.type === "route.decided")).toHaveLength(1);
    expect(events.filter((e) => e.type === "response.evaluated")).toHaveLength(1);
  });

  it("survives an instance restart: a fresh instance completes the persisted pending turn", async () => {
    const { ctx, sql } = makeCtx();
    const first = makeAgent(ctx);
    const handle = await first.submitChatTurn({ ...TURN });
    // Nothing has executed yet: the submission is a durable row, the
    // user message is in the canonical transcript, no turn ran.
    const pending = await first.inspectSubmission(handle.submissionId);
    expect(pending?.status).toBe("pending");
    expect(readMessages(sql)).toEqual([]);
    expect((await first.getPortMessages()).map((m: any) => m.role)).toEqual(["user"]);

    // "Restart": a brand-new agent instance over the same storage.
    const second = makeAgent(ctx);
    const { result, route } = await second.awaitChatTurnSubmission(handle);
    expect(await result.text).toBe("Stub assistant reply.");
    expect(Object.keys(route).sort()).toEqual(["agent", "confidence", "needsConfirmation", "reason"]);
    expect((await second.getPortMessages()).map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(readMessages(sql).map((m) => m.role)).toEqual(["user", "assistant"]);
    const done = await second.inspectSubmission(handle.submissionId);
    expect(done?.status).toBe("completed");
  });

  it("duplicate submission under one idempotency key executes exactly one turn", async () => {
    const { ctx, sql } = makeCtx();
    const agent = makeAgent(ctx);
    const opts = { ...TURN, submissionKey: "chat-turn:dup-key-1" };
    const first = await agent.runAgenticChatTurn(opts);
    const second = await agent.runAgenticChatTurn(opts);
    expect(await first.result.text).toBe("Stub assistant reply.");
    expect(await second.result.text).toBe("Stub assistant reply.");
    expect(second.route).toEqual(first.route);
    const session = await agent.getPortMessages();
    expect(session.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(session.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(readMessages(sql).filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(readEvents(sql).filter((e) => e.type === "route.decided")).toHaveLength(1);
  });

  it("stamps the turn with the submitting user's login, not the session fallback", async () => {
    const { ctx } = makeCtx();
    const agent = makeAgent(ctx);
    let loginDuringTurn: unknown;
    const origBeforeTurn = agent.portBeforeTurn.bind(agent);
    agent.portBeforeTurn = async (turnCtx: any) => {
      const config = await origBeforeTurn(turnCtx);
      loginDuringTurn = (agent as any).pendingTurn?.userLogin;
      return config;
    };
    await agent.runAgenticChatTurn({ ...TURN, userLogin: "durable-tester" });
    expect(loginDuringTurn).toBe("durable-tester");
    expect(loginDuringTurn).not.toBe(SESSION_KEY);
  });

  it("re-send of the history tail runs a fresh turn without duplicating the user message or record", async () => {
    const { ctx, sql } = makeCtx();
    const agent = makeAgent(ctx);
    await agent.runAgenticChatTurn({ ...TURN });
    await agent.runAgenticChatTurn({ ...TURN });
    const session = await agent.getPortMessages();
    expect(session.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(session.filter((m: any) => m.role === "assistant")).toHaveLength(2);
    expect(readMessages(sql).filter((m) => m.role === "user")).toHaveLength(1);
    expect(readMessages(sql).filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("a terminally failed turn rethrows the engine error and fires the error aspect exactly once", async () => {
    const { ctx, sql } = makeCtx();
    const agent = makeAgent(ctx);
    thinkStubControl.failNext = true;
    await expect(agent.runAgenticChatTurn({ ...TURN })).rejects.toThrow("stub model failure");
    const events = readEvents(sql);
    expect(events.filter((e) => e.type === "chatstream.uistreamerror.error")).toHaveLength(1);
    expect(readMessages(sql).filter((m) => m.role === "assistant")).toEqual([]);
  });

  it("memory reset mid-turn: the cancelled submission lands the aborted shape and no stale side effects", async () => {
    const { ctx, sql } = makeCtx();
    const agent = makeAgent(ctx);
    thinkStubControl.entered = false;
    let release!: () => void;
    thinkStubControl.deferred = {
      promise: new Promise<void>((r) => {
        release = r;
      }),
      resolve: () => release(),
    };
    try {
      const turnPromise = agent.runAgenticChatTurn({ ...TURN });
      let settled = false;
      turnPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      for (let i = 0; i < 200 && !thinkStubControl.entered && !settled; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(thinkStubControl.entered).toBe(true);
      agent.abortAllRequests("Session reset requested by user");
      agent.resetTurnState();
      await agent.clearMessages();
      thinkStubControl.deferred.resolve();
      const { result, route } = await turnPromise;
      expect(await result.text).toBe("");
      expect(Object.keys(route).sort()).toEqual(["agent", "confidence", "needsConfirmation", "reason"]);
      expect(await agent.getPortMessages()).toEqual([]);
      expect(readMessages(sql).filter((m) => m.role === "assistant")).toEqual([]);
      const events = readEvents(sql);
      expect(events.filter((e) => e.type === "route.decided")).toHaveLength(1);
      expect(events.filter((e) => e.type === "response.evaluated")).toEqual([]);
    } finally {
      thinkStubControl.deferred?.resolve();
      thinkStubControl.deferred = null;
      thinkStubControl.entered = false;
    }
  });
});
