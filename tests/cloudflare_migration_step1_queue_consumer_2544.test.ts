import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/api_chat_auth.test.ts).
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
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
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import type { Env } from "../src/types";
import {
  consumeCfBatch,
  type ProviderQueueBatch,
} from "../src/messaging/cfQueueMessagingAdapter";
import { createMessagingPorts } from "../src/messaging/createMessagingPorts";
import {
  SCREENER_EVENTS_CONSUMER_CONFIG,
  SCREENER_EVENTS_DELIVERY_CONSUMER_CONFIG,
  createScreenerEventsWorkHandler,
  extractScreenerEventsWork,
} from "../src/messaging/screenerEventsConsumer";
import type {
  MessageEnvelope,
  QueueConsumerConfig,
} from "../src/messaging/messagingPorts";

// Same string-aware stripper as tests/kv_bindings_removed.test.ts:
// wrangler.jsonc comments must not eat `//` inside string values.
function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "env-1",
    source: "test",
    type: "options_analysis",
    time: "2026-10-31T12:00:00.000Z",
    data: { payload: { userLogin: "owner-2544", thesis: "bullish" } },
    ...overrides,
  };
}

interface FakeMsg {
  body: unknown;
  acked: boolean;
  retried: boolean;
  ack: () => void;
  retry: () => void;
}

function mkMsg(body: unknown): FakeMsg {
  const msg: FakeMsg = {
    body,
    acked: false,
    retried: false,
    ack() {
      msg.acked = true;
    },
    retry() {
      msg.retried = true;
    },
  };
  return msg;
}

interface FetchCall {
  url: string;
  login: string | null;
  body: string;
}

function makeEnv(fetchCalls: FetchCall[], fetchImpl?: (req: Request) => Promise<unknown>) {
  return {
    SCREENER_EVENTS: { send: async () => {} },
    SEARCH_AGENT: {
      idFromName: (_name: string) => "stub-id",
      get: (_id: string) => ({
        fetch: async (req: Request) => {
          if (fetchImpl) return fetchImpl(req);
          fetchCalls.push({
            url: req.url,
            login: req.headers.get("x-user-login"),
            body: await req.text(),
          });
          return new Response("ok");
        },
      }),
    },
  } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// worker.queue's batch type is the platform MessageBatch; the fake
// messages below carry only the body/ack/retry surface the handler
// reads, so the call goes through `any` (same as other worker tests
// that stub the platform batch).
function runQueue(env: Env, messages: FakeMsg[]) {
  return (worker as any).queue(
    { queue: "screener-events", messages },
    env
  );
}

describe("step 1 (b): DLQ config present for both queues, pinned to the port contract", () => {
  it("wrangler.jsonc consumers match the QueueConsumerConfig constants exactly", () => {
    const cfg = JSON.parse(
      stripJsonc(readFileSync("wrangler.jsonc", "utf8"))
    ) as Record<string, any>;
    const consumers = cfg.queues?.consumers as Array<Record<string, unknown>>;
    expect(Array.isArray(consumers)).toBe(true);
    const byQueue = new Map(consumers.map((c) => [c.queue, c]));
    const toConfig = (c: Record<string, unknown>): QueueConsumerConfig => ({
      maxBatchSize: c.max_batch_size as number,
      ...(c.max_batch_timeout !== undefined
        ? { maxBatchTimeoutSeconds: c.max_batch_timeout as number }
        : {}),
      maxRetries: c.max_retries as number,
      ...(c.max_concurrency !== undefined
        ? { maxConcurrency: c.max_concurrency as number }
        : {}),
      ...(c.dead_letter_queue !== undefined
        ? { deadLetterQueue: c.dead_letter_queue as string }
        : {}),
    });
    expect(toConfig(byQueue.get("screener-events")!)).toEqual(
      SCREENER_EVENTS_CONSUMER_CONFIG
    );
    expect(toConfig(byQueue.get("screener-events-delivery")!)).toEqual(
      SCREENER_EVENTS_DELIVERY_CONSUMER_CONFIG
    );
    // Both consumers have a DLQ; both DLQ queues have producer bindings.
    expect(SCREENER_EVENTS_CONSUMER_CONFIG.deadLetterQueue).toBe("screener-events-dlq");
    expect(SCREENER_EVENTS_DELIVERY_CONSUMER_CONFIG.deadLetterQueue).toBe(
      "screener-events-delivery-dlq"
    );
    const producers = cfg.queues?.producers as Array<Record<string, unknown>>;
    const producerQueues = new Set(producers.map((p) => p.queue));
    expect(producerQueues.has("screener-events-dlq")).toBe(true);
    expect(producerQueues.has("screener-events-delivery-dlq")).toBe(true);
  });
});

describe("step 1 (a): screener-events consumer routes via the QueuePort", () => {
  it("processed → ack, retry → retry, duplicate envelope → handler once, both acked", async () => {
    const ports = createMessagingPorts({
      SCREENER_EVENTS: { send: async () => {} },
    })!;
    const calls: string[] = [];
    const handler = createScreenerEventsWorkHandler({
      dispatchOptionsAnalysis: async (payload) => {
        calls.push((payload as { marker?: string }).marker ?? "?");
        if ((payload as { marker?: string }).marker === "boom") {
          throw new Error("trigger down");
        }
        return "dispatched";
      },
    });
    const batch = {
      queue: "screener-events",
      messages: [
        mkMsg(envelope({ id: "w-ok", data: { payload: { marker: "ok" } } })),
        mkMsg(envelope({ id: "w-boom", data: { payload: { marker: "boom" } } })),
        mkMsg(envelope({ id: "w-ok", data: { payload: { marker: "ok" } } })),
        mkMsg(envelope({ id: "w-drop", type: "something.else", data: {} })),
      ],
    } as unknown as ProviderQueueBatch;
    await consumeCfBatch(batch, ports.consumer, handler);
    expect(calls).toEqual(["ok", "boom"]);
    const [ok, boom, dup, drop] = batch.messages as unknown as FakeMsg[];
    expect(ok.acked).toBe(true);
    expect(boom.retried).toBe(true);
    expect(boom.acked).toBe(false);
    expect(dup.acked).toBe(true); // duplicate: handler not re-invoked
    expect(drop.acked).toBe(true); // unknown type: dropped, not retried
  });

  it("work extraction reads run/unit ids from envelope extensions", () => {
    const work = extractScreenerEventsWork(
      envelope({ jobid: "run-9", shardid: "unit-3" })
    );
    expect(work?.runId).toBe("run-9");
    expect(work?.unitId).toBe("unit-3");
    expect(extractScreenerEventsWork(envelope({ type: "screener.completed", data: {} }))).toBeNull();
  });
});

describe("step 1 (c)+(d): worker.queue() screener-events branch", () => {
  it("revived envelope work dispatches to the trigger under the payload owner and acks", async () => {
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const msg = mkMsg(
      envelope({ id: "branch-env-1", data: { payload: { userLogin: "owner-2544" } } })
    );
    await runQueue(env, [msg]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://agent.internal/schedules/trigger-options-analysis"
    );
    expect(fetchCalls[0].login).toBe("owner-2544");
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
  });

  it("duplicate envelope work dispatches once; both messages acked", async () => {
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const first = mkMsg(
      envelope({ id: "branch-dup-1", data: { payload: { userLogin: "owner-2544" } } })
    );
    const second = mkMsg(
      envelope({ id: "branch-dup-1", data: { payload: { userLogin: "owner-2544" } } })
    );
    await runQueue(env, [first, second]);
    expect(fetchCalls).toHaveLength(1);
    expect(first.acked).toBe(true);
    expect(second.acked).toBe(true);
  });

  it("trigger failure retries (→ DLQ after max_retries by platform config), never acks", async () => {
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls, async () => {
      throw new Error("trigger down");
    });
    const msg = mkMsg(
      envelope({ id: "branch-fail-1", data: { payload: { userLogin: "owner-2544" } } })
    );
    await runQueue(env, [msg]);
    expect(msg.retried).toBe(true);
    expect(msg.acked).toBe(false);
  });

  it("denied dispatch (shared-orchestrator owner) is dropped + logged, never retried, never fetched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const msg = mkMsg(
      envelope({
        id: "branch-denied-1",
        data: { payload: { userLogin: "default_trader" } },
      })
    );
    await runQueue(env, [msg]);
    expect(fetchCalls).toHaveLength(0);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Dropping options_analysis"))).toBe(true);
  });

  it("no identity retries (never a fabricated identity)", async () => {
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const msg = mkMsg(
      envelope({ id: "branch-noid-1", data: { payload: {} } })
    );
    await runQueue(env, [msg]);
    expect(fetchCalls).toHaveLength(0);
    expect(msg.retried).toBe(true);
    expect(msg.acked).toBe(false);
  });

  it("deprecated legacy taskType wrapper still dispatches and acks", async () => {
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const msg = mkMsg({
      taskType: "options_analysis",
      payload: { userLogin: "owner-2544" },
    });
    await runQueue(env, [msg]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].login).toBe("owner-2544");
    expect(msg.acked).toBe(true);
  });

  it("undecodable message is acked + logged, never retried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const msg = mkMsg({ nope: true });
    await runQueue(env, [msg]);
    expect(fetchCalls).toHaveLength(0);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("undecodable"))).toBe(true);
  });

  it("unknown envelope type is dropped + acked, never dispatched", async () => {
    const fetchCalls: FetchCall[] = [];
    const env = makeEnv(fetchCalls);
    const msg = mkMsg(
      envelope({ id: "branch-unknown-1", type: "screener.completed", data: {} })
    );
    await runQueue(env, [msg]);
    expect(fetchCalls).toHaveLength(0);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
  });
});
