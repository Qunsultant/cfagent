/**
 * Issue #2869 slice 1 (under #2764) — queue transport for the
 * analysis-done stage message. Pins the transport, not the
 * whole migration: the other stages' in-process execution is
 * slices 2/3, still open on #2869, and is not claimed here.
 */
import { describe, expect, it, vi } from "vitest";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/cloudflare_migration_step1_queue_consumer_2544.test.ts).
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: unknown) => cls };
});
import {
  buildAnalysisDoneMessage,
  executeAnalysisDoneQueueMessage,
  isAnalysisDoneStageMessage,
  publishAnalysisDone,
} from "../src/workflows/stageQueueTransport";
import { stageMessage } from "../src/workflows/stageMessage";
import { consumeAnalysisDoneMessage } from "../src/workflows/stageReportProduction";
import { consumeAnalysisDone } from "../src/workflows/stageReportConsumer";
import worker from "../src/server";

function claimsStore() {
  const seen = new Set<string>();
  return {
    has: (key: string) => seen.has(key),
    add: (key: string) => {
      seen.add(key);
    },
    delete: (key: string) => {
      seen.delete(key);
    },
  };
}

function persistedAnalysis() {
  return { allStocks: [{ symbol: "AAPL" }], opportunities: [] as unknown[] };
}

describe("buildAnalysisDoneMessage", () => {
  it("references the persisted analysis key and keys idempotency by runId + stage", () => {
    const message = buildAnalysisDoneMessage({ timestamp: "2026-11-03T00:00:00.000Z", userLogin: "alice" });
    expect(message.runId).toBe("screener:2026-11-03T00:00:00.000Z");
    expect(message.stageId).toBe("analysis-done");
    expect(message.artifactKeys).toEqual(["screener:analysis:2026-11-03T00:00:00.000Z"]);
    expect(message.idempotencyKey).toBe("screener:2026-11-03T00:00:00.000Z::analysis-done");
    expect(message.userLogin).toBe("alice");
    expect(isAnalysisDoneStageMessage(message)).toBe(true);
  });

  it("refuses a default identity, like the stage contract", () => {
    expect(() => buildAnalysisDoneMessage({ timestamp: "t", userLogin: "default" })).toThrow(/userLogin/);
  });
});

describe("isAnalysisDoneStageMessage", () => {
  it("rejects envelopes, other stages, and malformed bodies", () => {
    expect(isAnalysisDoneStageMessage(null)).toBe(false);
    expect(isAnalysisDoneStageMessage({ type: "options_analysis" })).toBe(false);
    expect(
      isAnalysisDoneStageMessage(
        stageMessage({ runId: "run-1", stageId: "enrich", artifactKeys: ["a"], userLogin: "alice" }),
      ),
    ).toBe(false);
    const message = buildAnalysisDoneMessage({ timestamp: "t", userLogin: "alice" });
    expect(isAnalysisDoneStageMessage({ ...message, artifactKeys: [] })).toBe(false);
    expect(isAnalysisDoneStageMessage({ ...message, userLogin: "default" })).toBe(false);
  });
});

describe("publishAnalysisDone", () => {
  it("sends the stage message to the queue binding", async () => {
    const sent: unknown[] = [];
    const result = await publishAnalysisDone({
      queue: { send: async (body) => { sent.push(body); } },
      timestamp: "t1",
      userLogin: "alice",
    });
    expect(result.published).toBe(true);
    expect(sent).toHaveLength(1);
    expect(isAnalysisDoneStageMessage(sent[0])).toBe(true);
  });

  it("never throws: missing binding and send failure are reported, not propagated", async () => {
    const noQueue = await publishAnalysisDone({ queue: null, timestamp: "t1", userLogin: "alice" });
    expect(noQueue.published).toBe(false);
    const failing = await publishAnalysisDone({
      queue: { send: async () => { throw new Error("queue down"); } },
      timestamp: "t1",
      userLogin: "alice",
    });
    expect(failing.published).toBe(false);
    expect((failing as { reason: string }).reason).toMatch(/queue down/);
    const badLogin = await publishAnalysisDone({
      queue: { send: async () => {} },
      timestamp: "t1",
      userLogin: "default",
    });
    expect(badLogin.published).toBe(false);
  });
});

describe("executeAnalysisDoneQueueMessage", () => {
  // The executor takes its consume function injected (production:
  // the stageReportProduction helper, the Factor 6 pin's only
  // production caller). Tests inject the real consumer with
  // fake deps, so ack/retry mapping is tested against the
  // real consume outcomes.
  function realConsume(deps: {
    claims: ReturnType<typeof claimsStore>;
    readPersisted: (key: string) => Promise<unknown>;
    generate: (input: { result: Record<string, unknown> }) => Promise<unknown>;
    deadLetter?: (info: { message: never; reason: string }) => Promise<void> | void;
  }) {
    return async (input: { message: never; attempt: number; maxAttempts: number }) =>
      consumeAnalysisDone({
        message: input.message,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        claims: deps.claims,
        readPersisted: deps.readPersisted as never,
        generate: deps.generate as never,
        deadLetter: deps.deadLetter,
      });
  }

  it("generates from persisted data, then suppresses the redelivery", async () => {
    const message = buildAnalysisDoneMessage({ timestamp: "t2", userLogin: "alice" });
    const claims = claimsStore();
    const store = new Map<string, unknown>([[message.artifactKeys[0], persistedAnalysis()]]);
    const generate = vi.fn(async ({ result }: { result: { allStocks: unknown[] } }) => {
      (result as Record<string, unknown>).pdfKey = "pdf-1";
      return { pdfKey: "pdf-1" };
    });
    const consume = realConsume({
      claims,
      readPersisted: async (key) => store.get(key),
      generate: generate as never,
    });
    const first = await executeAnalysisDoneQueueMessage({ message, consume });
    expect(first).toEqual({ action: "ack", status: "generated" });
    expect(generate).toHaveBeenCalledTimes(1);
    const second = await executeAnalysisDoneQueueMessage({ message, consume });
    expect(second).toEqual({ action: "ack", status: "duplicate-suppressed" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("dead-letters poison and over-budget messages with ack, never retry", async () => {
    const deadLetter = vi.fn();
    const poison = await executeAnalysisDoneQueueMessage({
      message: { stageId: "enrich" } as never,
      consume: realConsume({
        claims: claimsStore(),
        readPersisted: async () => null,
        generate: async () => ({}),
        deadLetter,
      }),
      deadLetter,
    });
    expect(poison.action).toBe("ack");
    expect(poison.status).toBe("dead-lettered");
    expect(deadLetter).toHaveBeenCalledTimes(1);
    const message = buildAnalysisDoneMessage({ timestamp: "t3", userLogin: "alice" });
    const overBudget = await executeAnalysisDoneQueueMessage({
      message,
      attempt: 99,
      maxAttempts: 3,
      consume: realConsume({
        claims: claimsStore(),
        readPersisted: async () => persistedAnalysis(),
        generate: async () => ({}),
        deadLetter,
      }),
      deadLetter,
    });
    expect(overBudget).toEqual(expect.objectContaining({ action: "ack", status: "dead-lettered" }));
  });

  it("throws on a missing persisted analysis so the platform retries to the DLQ", async () => {
    const message = buildAnalysisDoneMessage({ timestamp: "t4", userLogin: "alice" });
    await expect(
      executeAnalysisDoneQueueMessage({
        message,
        consume: realConsume({
          claims: claimsStore(),
          readPersisted: async () => null,
          generate: async () => ({}),
        }),
      }),
    ).rejects.toThrow(/missing or has no full set/);
  });
});

describe("worker.queue() screener-events branch (slice 1 glue)", () => {
  function queueEnv(consume: (message: unknown, attempt?: number) => Promise<{ status: string; reason?: string }>) {
    const calls: Array<{ message: unknown; attempt?: number }> = [];
    const env = {
      SCREENER_EVENTS: { send: async () => {} },
      ORCHESTRATOR_AGENT: {
        idFromName: () => "stub-id",
        get: () => ({ fetch: async () => new Response("ok") }),
      },
      SCREENER_AGENT: {
        idFromName: (name: string) => name,
        get: () => ({
          consumeQueuedAnalysisDone: async (message: unknown, attempt?: number) => {
            calls.push({ message, attempt });
            return consume(message, attempt);
          },
        }),
      },
    };
    return { env: env as never, calls };
  }

  function fakeMsg(body: unknown) {
    const msg: { body: unknown; acked: boolean; retried: boolean; ack: () => void; retry: () => void } = {
      body,
      acked: false,
      retried: false,
      ack() { msg.acked = true; },
      retry() { msg.retried = true; },
    };
    return msg;
  }

  it("routes an analysis-done message to the owning ScreenerAgent DO and acks on generated", async () => {
    const { env, calls } = queueEnv(async () => ({ status: "generated" }));
    const message = buildAnalysisDoneMessage({ timestamp: "tq", userLogin: "alice" });
    const msg = fakeMsg(message);
    await (worker as never as { queue: (batch: unknown, env: unknown) => Promise<void> }).queue(
      { queue: "screener-events", messages: [msg] },
      env,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toEqual(message);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
  });

  it("retries when the agent consume throws (missing persisted analysis path)", async () => {
    const { env, calls } = queueEnv(async () => { throw new Error("persisted analysis missing"); });
    const message = buildAnalysisDoneMessage({ timestamp: "tq2", userLogin: "alice" });
    const msg = fakeMsg(message);
    await (worker as never as { queue: (batch: unknown, env: unknown) => Promise<void> }).queue(
      { queue: "screener-events", messages: [msg] },
      env,
    );
    expect(calls).toHaveLength(1);
    expect(msg.retried).toBe(true);
    expect(msg.acked).toBe(false);
  });
});

describe("consumeAnalysisDoneMessage (shared in-process + queue helper)", () => {
  it("generates via the PDF leg and re-uses a passed claims store across calls", async () => {
    const message = buildAnalysisDoneMessage({ timestamp: "t5", userLogin: "alice" });
    const backing = new Map<string, unknown>([[message.artifactKeys[0], persistedAnalysis()]]);
    const storage = {
      get: async (key: string) => backing.get(key),
      put: async (key: string, value: unknown) => { backing.set(key, value); },
    };
    const claims = claimsStore();
    const generate = vi.fn(async ({ result }: { result: Record<string, unknown> }) => {
      result.pdfKey = "pdf-5";
      return { pdfKey: "pdf-5" };
    });
    const first = await consumeAnalysisDoneMessage({
      env: {},
      storage: storage as never,
      claims,
      message,
      userLogin: "alice",
      generate: generate as never,
    });
    expect(first.status).toBe("generated");
    const second = await consumeAnalysisDoneMessage({
      env: {},
      storage: storage as never,
      claims,
      message,
      userLogin: "alice",
      generate: generate as never,
    });
    expect(second.status).toBe("duplicate-suppressed");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
