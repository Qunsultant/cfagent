// @vitest-environment node
/**
 * Issue #4249 ([3122] flag-gate both agentic-scheduling channels):
 * two flags (schedule_chat default ON, schedule_nlq default OFF) gate
 * the ENTRY POINTS, not the operations; one of them is always on
 * (both-off is refused with a coded outcome); a request on a disabled
 * entry point returns FEATURE_DISABLED, never a silent failure and
 * never an unguarded execution. Chat is the FIRST option wherever the
 * channels are presented or ordered.
 *
 * Red-first pins: this file must fail before the implementation lands
 * (the module, the flags, and the gates do not exist yet) and pass
 * after it. Non-schedule chat and non-schedule NLQ are pinned
 * unaffected: the flags gate only the scheduling entry points.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  ALL_FEATURE_FLAGS,
  DEFAULT_SCHEDULE_CHAT_FLAG_VALUE,
  DEFAULT_SCHEDULE_NLQ_FLAG_VALUE,
} from "../src/features/featureFlagPorts";
import { InMemoryFeatureFlagAdapter } from "../src/features/inMemoryFeatureFlagAdapter";
import { EnvFeatureFlagAdapter } from "../src/features/envFeatureFlagAdapter";
import { CfFlagshipAdapter, type FlagshipBindingLike } from "../src/features/cfFlagshipAdapter";
import {
  SCHEDULE_CHANNELS,
  SCHEDULE_CHANNEL_FLAGS,
  SCHEDULE_CHAT_FLAG,
  SCHEDULE_NLQ_FLAG,
  authorizeScheduleChannel,
  resolveScheduleChannelState,
  validateScheduleChannelState,
} from "../src/features/scheduleChannelFlags";
import {
  dispatchOrchestratorA2A,
  orchestratorA2AOutcome,
} from "../src/agents/orchestrator/a2aDispatch";
import {
  executeNLQQueryAsync,
  type NLQPlan,
  type NLQSchedulingPort,
} from "../src/agents/nlq";
import type { AgentScheduleItem, Env } from "../src/types";

const ENV = {} as never;

describe("schedule channel flags are registered with chat ON / NLQ OFF by default (#4249)", () => {
  it("registers schedule_chat and schedule_nlq in ALL_FEATURE_FLAGS", () => {
    expect(ALL_FEATURE_FLAGS).toContain("schedule_chat");
    expect(ALL_FEATURE_FLAGS).toContain("schedule_nlq");
  });

  it("documents the defaults in one home: chat ON, NLQ OFF", () => {
    expect(DEFAULT_SCHEDULE_CHAT_FLAG_VALUE).toBe(true);
    expect(DEFAULT_SCHEDULE_NLQ_FLAG_VALUE).toBe(false);
  });

  it("chat comes first wherever the channels are ordered (chat-first rule)", () => {
    expect([...SCHEDULE_CHANNELS]).toEqual(["chat", "nlq"]);
    expect(SCHEDULE_CHANNEL_FLAGS.chat).toBe("schedule_chat");
    expect(SCHEDULE_CHANNEL_FLAGS.nlq).toBe("schedule_nlq");
    expect(SCHEDULE_CHAT_FLAG).toBe("schedule_chat");
    expect(SCHEDULE_NLQ_FLAG).toBe("schedule_nlq");
  });

  it("bare InMemory adapter: chat ON, NLQ OFF", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("InMemory adapter: explicit overrides win both ways", async () => {
    const port = new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: true });
    expect(await port.isEnabled("schedule_chat")).toBe(false);
    expect(await port.isEnabled("schedule_nlq")).toBe(true);
    port.setFlag("schedule_chat", true);
    port.setFlag("schedule_nlq", false);
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("bare Env adapter: chat ON, NLQ OFF", async () => {
    const port = new EnvFeatureFlagAdapter({});
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("configured Env adapter: the channel defaults hold even when other flags are set", async () => {
    // A configured env defaults other flags OFF — the channel
    // defaults are explicit, so chat stays ON and NLQ stays OFF.
    const port = new EnvFeatureFlagAdapter({ FEATURE_SCREENER: "1" });
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("Env adapter: explicit disable of chat / enable of NLQ wins", async () => {
    const off = new EnvFeatureFlagAdapter({ FEATURE_SCHEDULE_CHAT: "0" });
    expect(await off.isEnabled("schedule_chat")).toBe(false);
    const on = new EnvFeatureFlagAdapter({
      FEATURE_FLAGS: JSON.stringify({ schedule_nlq: true }),
    });
    expect(await on.isEnabled("schedule_nlq")).toBe(true);
    const bulkOff = new EnvFeatureFlagAdapter({
      FEATURE_FLAGS: JSON.stringify({ schedule_chat: false }),
    });
    expect(await bulkOff.isEnabled("schedule_chat")).toBe(false);
  });

  it("Flagship adapter: missing dashboard flags resolve to chat ON / NLQ OFF", async () => {
    const getBooleanValue = vi
      .fn()
      .mockImplementation((_flag: string, defaultVal: boolean) => Promise.resolve(defaultVal));
    const port = new CfFlagshipAdapter({ getBooleanValue } as unknown as FlagshipBindingLike);
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
    expect(getBooleanValue).toHaveBeenCalledWith("schedule_chat", true, undefined);
    expect(getBooleanValue).toHaveBeenCalledWith("schedule_nlq", false, undefined);
  });

  it("Flagship adapter: an explicit dashboard value wins; a provider error fails closed", async () => {
    const explicit = new CfFlagshipAdapter({
      getBooleanValue: vi.fn().mockResolvedValue(false),
    } as unknown as FlagshipBindingLike);
    expect(await explicit.isEnabled("schedule_chat")).toBe(false);
    const broken = new CfFlagshipAdapter({
      getBooleanValue: vi.fn().mockRejectedValue(new Error("Flagship down")),
    } as unknown as FlagshipBindingLike);
    expect(await broken.isEnabled("schedule_chat")).toBe(false);
    expect(await broken.isEnabled("schedule_nlq")).toBe(false);
  });
});

describe("one-on invariant + channel authorization (#4249)", () => {
  it("default state is chat ON / NLQ OFF", async () => {
    const state = await resolveScheduleChannelState(new InMemoryFeatureFlagAdapter());
    expect(state).toEqual({ chatEnabled: true, nlqEnabled: false });
  });

  it("chat is allowed and NLQ is refused FEATURE_DISABLED by default", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const chat = await authorizeScheduleChannel(port, "chat");
    expect(chat.allowed).toBe(true);
    const nlq = await authorizeScheduleChannel(port, "nlq");
    expect(nlq.allowed).toBe(false);
    if (!nlq.allowed) {
      expect(nlq.code).toBe("FEATURE_DISABLED");
      expect(nlq.flag).toBe("schedule_nlq");
      expect(nlq.message).toContain("FEATURE_DISABLED");
    }
  });

  it("NLQ on + chat off: NLQ allowed, chat refused FEATURE_DISABLED", async () => {
    const port = new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: true });
    const nlq = await authorizeScheduleChannel(port, "nlq");
    expect(nlq.allowed).toBe(true);
    const chat = await authorizeScheduleChannel(port, "chat");
    expect(chat.allowed).toBe(false);
    if (!chat.allowed) {
      expect(chat.code).toBe("FEATURE_DISABLED");
      expect(chat.flag).toBe("schedule_chat");
    }
  });

  it("both on: both allowed", async () => {
    const port = new InMemoryFeatureFlagAdapter({ schedule_chat: true, schedule_nlq: true });
    expect((await authorizeScheduleChannel(port, "chat")).allowed).toBe(true);
    expect((await authorizeScheduleChannel(port, "nlq")).allowed).toBe(true);
  });

  it("both off is an invalid state: refused with SCHEDULE_CHANNELS_BOTH_OFF, never silent", async () => {
    const state = { chatEnabled: false, nlqEnabled: false };
    const verdict = validateScheduleChannelState(state);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("SCHEDULE_CHANNELS_BOTH_OFF");
      expect(verdict.message).toMatch(/at least one/i);
    }
    const port = new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: false });
    for (const channel of ["chat", "nlq"] as const) {
      const auth = await authorizeScheduleChannel(port, channel);
      expect(auth.allowed).toBe(false);
      if (!auth.allowed) {
        expect(auth.code).toBe("SCHEDULE_CHANNELS_BOTH_OFF");
      }
    }
    expect(validateScheduleChannelState({ chatEnabled: true, nlqEnabled: false }).ok).toBe(true);
    expect(validateScheduleChannelState({ chatEnabled: false, nlqEnabled: true }).ok).toBe(true);
    expect(validateScheduleChannelState({ chatEnabled: true, nlqEnabled: true }).ok).toBe(true);
  });
});

describe("chat entry point: schedule.* A2A ops are gated on schedule_chat (#4249)", () => {
  const principal = { login: "OpenAIMP", agentId: "a2a-4249-test" };

  function makeScheduleDeps(flagPort: InMemoryFeatureFlagAdapter) {
    const requests: Array<Record<string, unknown>> = [];
    const deps: Record<string, unknown> = {
      sessionId: "sess-a2a-4249",
      sql: { exec: (_q: string, ..._a: unknown[]) => [] as unknown[] },
      audit: () => {},
      flagPort,
      agentScheduleExecute: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { ok: true, scheduleId: "sdk-1", schedule: { id: "sdk-1", callback: request.callback } };
      },
      schedulePrincipal: principal,
    };
    return { deps, requests };
  }

  it("chat flag OFF: schedule.create refuses FEATURE_DISABLED and never calls the capability", async () => {
    const { deps, requests } = makeScheduleDeps(
      new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: true }),
    );
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.create", callback: "autonomousMarketScreen", timing: { type: "interval", intervalSeconds: 3600 } },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("feature_disabled");
    expect(data.error).toContain("FEATURE_DISABLED");
    expect(data.error).toContain("schedule_chat");
    expect(data.feature).toBe("schedule_chat");
    expect(requests).toHaveLength(0);
    expect(orchestratorA2AOutcome(data).text).toContain("FEATURE_DISABLED");
  });

  it("both channels OFF: schedule.create refuses with the both-off code, not a per-channel code", async () => {
    const { deps, requests } = makeScheduleDeps(
      new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: false }),
    );
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.list" },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("feature_disabled");
    expect(data.error).toContain("SCHEDULE_CHANNELS_BOTH_OFF");
    expect(requests).toHaveLength(0);
  });

  it("chat flag ON (default): schedule.create still delegates to the capability", async () => {
    const { deps, requests } = makeScheduleDeps(new InMemoryFeatureFlagAdapter());
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.create", callback: "autonomousMarketScreen", timing: { type: "interval", intervalSeconds: 3600 } },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("non-schedule chat is unaffected by the chat flag: memory.recall still routes with chat OFF", async () => {
    const { deps } = makeScheduleDeps(
      new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: true }),
    );
    (deps as Record<string, unknown>).masFactory = () => ({
      searchKnowledge: { execute: async () => ({}) },
      draftPayment: { execute: async () => ({}) },
      createTaskDraft: { execute: async () => ({}) },
      confirmDraft: { execute: async () => ({}) },
      rememberFact: { execute: async () => ({}) },
      recallFacts: { execute: async () => ({ count: 1, facts: [] }) },
    });
    const data = await dispatchOrchestratorA2A(ENV, { operation: "memory.recall", filter: "tone" }, deps as never);
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("memory.recall");
  });

  it("nlq.execute is NOT wholesale-gated: it still routes with the NLQ channel OFF (only its schedule intents are gated)", async () => {
    const nlqCalls: string[] = [];
    const { deps } = makeScheduleDeps(new InMemoryFeatureFlagAdapter());
    (deps as Record<string, unknown>).nlqExecute = async (query: string) => {
      nlqCalls.push(query);
      return { status: "success", summary: "fake nlq result", rows: [], count: 0 };
    };
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "nlq.execute", query: "screen stocks with PE below 15" },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(nlqCalls).toEqual(["screen stocks with PE below 15"]);
  });
});

describe("NLQ entry point: NLQ schedule intents are gated on schedule_nlq (#4249)", () => {
  class FakeSchedulingPort implements NLQSchedulingPort {
    calls: Array<{ method: string; args: unknown[] }> = [];
    items: AgentScheduleItem[] = [];
    async schedule(when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }): Promise<AgentScheduleItem> {
      this.calls.push({ method: "schedule", args: [when, callback, payload, options] });
      const item: AgentScheduleItem = { id: "fake-port-id-1", callback, payload, type: "delayed", time: Math.floor(Date.now() / 1000) + 900 };
      this.items.push(item);
      return item;
    }
    async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
      this.calls.push({ method: "scheduleEvery", args: [intervalSeconds, callback, payload] });
      const item: AgentScheduleItem = { id: "fake-port-id-1", callback, payload, type: "interval", intervalSeconds, time: Math.floor(Date.now() / 1000) + intervalSeconds };
      this.items.push(item);
      return item;
    }
    async cancelSchedule(id: string): Promise<boolean> {
      this.calls.push({ method: "cancelSchedule", args: [id] });
      return true;
    }
    async listSchedules(): Promise<AgentScheduleItem[]> {
      this.calls.push({ method: "listSchedules", args: [] });
      return [...this.items];
    }
  }

  function makeOrmEnv() {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("nlq-4249-user");
    const env = { APP_ENV: "TEST" } as Env;
    return { orm, env };
  }

  function schedulePlan(): NLQPlan {
    return {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "delayed",
        delayInSeconds: 900,
        callback: "sendScheduledReminder",
        description: "remind me",
      },
    } as unknown as NLQPlan;
  }

  it("NLQ flag OFF (default): a scheduling plan refuses FEATURE_DISABLED and arms nothing", async () => {
    const { orm, env } = makeOrmEnv();
    const port = new FakeSchedulingPort();
    const result = await executeNLQQueryAsync(orm, "nlq-4249-user", schedulePlan(), env, "nlq-4249-user", undefined, {
      schedulingPort: port,
      flagPort: new InMemoryFeatureFlagAdapter(),
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("FEATURE_DISABLED");
    expect(result.summary).toContain("schedule_nlq");
    expect(result.summary).toMatch(/nothing was created/i);
    expect(port.calls).toHaveLength(0);
  });

  it("both channels OFF: an NLQ scheduling plan refuses with the both-off code", async () => {
    const { orm, env } = makeOrmEnv();
    const port = new FakeSchedulingPort();
    const result = await executeNLQQueryAsync(orm, "nlq-4249-user", schedulePlan(), env, "nlq-4249-user", undefined, {
      schedulingPort: port,
      flagPort: new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: false }),
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("SCHEDULE_CHANNELS_BOTH_OFF");
    expect(port.calls).toHaveLength(0);
  });

  it("NLQ flag ON: the scheduling plan executes through the port", async () => {
    const { orm, env } = makeOrmEnv();
    const port = new FakeSchedulingPort();
    const result = await executeNLQQueryAsync(orm, "nlq-4249-user", schedulePlan(), env, "nlq-4249-user", undefined, {
      schedulingPort: port,
      flagPort: new InMemoryFeatureFlagAdapter({ schedule_nlq: true }),
    });
    expect(result.status).toBe("scheduled");
    expect(port.calls).toHaveLength(1);
  });

  it("non-schedule NLQ is unaffected by the NLQ flag: conversation history still answers with NLQ OFF", async () => {
    const { orm, env } = makeOrmEnv();
    const result = await executeNLQQueryAsync(
      orm,
      "nlq-4249-user",
      { domain: "conversation", terms: "hello", limit: 10 } as unknown as NLQPlan,
      env,
      "nlq-4249-user",
      undefined,
      { flagPort: new InMemoryFeatureFlagAdapter() },
    );
    expect(result.domain).toBe("conversation");
    expect(result.summary ?? "").not.toContain("FEATURE_DISABLED");
  });
});
