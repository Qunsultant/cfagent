/**
 * Issue #5423 (#3515 S4) — per-step timeouts in the MAS turn loop.
 *
 * Pins (TDD red→green, load-bearing):
 *  - the timeout value is externalized tenant-scoped config (D1
 *    agentTenantSettings row via the CommercialStore port) — no
 *    hardcoded constant, no env var; unconfigured = named refusal.
 *  - the enforcement mechanism is the vendor primitive: AI SDK
 *    `generateText` `timeout: { stepMs }` (installed ai 7.0.123).
 *    A step that exceeds it aborts with a DOMException named
 *    `TimeoutError` ("Step timeout of <ms>ms exceeded"); the timer
 *    resets every step (per-step, not total).
 *  - the step-count cap (stopWhen: stepCountIs) still binds
 *    alongside the timeout.
 *  - a timeout / refusal is a NAMED, RECORDED outcome: the
 *    structured logger carries it with the 7 mandatory attributes.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import {
  TURN_STEP_TIMEOUT_MAX_MS,
  TURN_STEP_TIMEOUT_MIN_MS,
  TurnStepTimeoutUnconfiguredError,
  parseTurnStepTimeoutMs,
  resolveTurnStepTimeoutMs,
} from "../src/config/turnStepTimeout";
import {
  AgentChatTurnRunner,
  generateTextModelTurn,
  type ModelTurnOptions,
} from "../src/actors/actorTurnRunner";
import { createStructuredLogger } from "../src/observability/structuredLogger";
import type {
  ObservabilityEvent,
  ObservabilitySink,
} from "../src/observability/observabilityPorts";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { tenantSettingsBodySchema } from "../src/api/requestValidation";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import { d1MigrationSql } from "../src/data/schemaComponent/d1Catalogue";
import { resetSharedOutboundLimiters } from "../src/security/outboundRateLimiter";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The production model turn acquires the shared LLM token first;
// reset it per test so the mechanism tests never queue behind
// each other (the outbound_rate_limit_3515.test.ts precedent).
beforeEach(() => {
  resetSharedOutboundLimiters();
});

/** doGenerate that hangs until its abort signal fires, then rejects with the reason. */
function hangingDoGenerate() {
  return async (options: { abortSignal?: AbortSignal }) => {
    await new Promise<never>((_resolve, reject) => {
      const signal = options.abortSignal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const },
    usage: { inputTokens: 1, outputTokens: 1 },
    warnings: [],
  };
}

function toolCallResult() {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call-1",
        toolName: "echo",
        input: "{}",
      },
    ],
    finishReason: { unified: "tool-calls" as const },
    usage: { inputTokens: 1, outputTokens: 1 },
    warnings: [],
  };
}

class RecordingSink implements ObservabilitySink {
  events: ObservabilityEvent[] = [];
  write(event: ObservabilityEvent): void {
    this.events.push(event);
  }
  writeBatch(events: readonly ObservabilityEvent[]): void {
    for (const event of events) this.write(event);
  }
}

function stubHooks(onChatError?: (err: unknown) => void) {
  const errors: unknown[] = [];
  return {
    hooks: {
      getModel: () => ({ modelId: "mock" }),
      getSystemPrompt: () => "sys",
      getTools: () => ({}),
      beforeTurn: async () => undefined,
      onChatResponse: async () => {},
      onChatError: (err: unknown) => {
        errors.push(err);
        onChatError?.(err);
      },
      maxSteps: 5,
    },
    errors,
  };
}

function stubSession() {
  return {
    getMessages: async () => [],
    appendMessages: async () => {},
    deleteMessages: async () => {},
    migrateLegacyRows: async () => {},
    clear: async () => {},
  };
}

describe("turn step timeout config (#5423)", () => {
  it("accepts a positive integer inside the bounds", () => {
    expect(parseTurnStepTimeoutMs(30_000)).toBe(30_000);
    expect(parseTurnStepTimeoutMs("5000")).toBe(5000);
    expect(parseTurnStepTimeoutMs(TURN_STEP_TIMEOUT_MIN_MS)).toBe(TURN_STEP_TIMEOUT_MIN_MS);
    expect(parseTurnStepTimeoutMs(TURN_STEP_TIMEOUT_MAX_MS)).toBe(TURN_STEP_TIMEOUT_MAX_MS);
  });

  it("rejects zero, negative, fractional, over-max, and non-numeric values", () => {
    for (const bad of [0, -1, 1.5, TURN_STEP_TIMEOUT_MAX_MS + 1, "abc", "", null, undefined, {}, NaN]) {
      expect(() => parseTurnStepTimeoutMs(bad)).toThrow();
    }
  });

  it("unconfigured (absent) is a named refusal, not a default", () => {
    expect(() => resolveTurnStepTimeoutMs(null)).toThrowError(TurnStepTimeoutUnconfiguredError);
    expect(() => resolveTurnStepTimeoutMs(undefined)).toThrowError(TurnStepTimeoutUnconfiguredError);
    try {
      resolveTurnStepTimeoutMs(null);
    } catch (err) {
      expect(err).toBeInstanceOf(TurnStepTimeoutUnconfiguredError);
      expect((err as TurnStepTimeoutUnconfiguredError).code).toBe("turn_step_timeout_unconfigured");
      expect((err as TurnStepTimeoutUnconfiguredError).reason).toBe("absent");
    }
    expect(resolveTurnStepTimeoutMs(30_000)).toBe(30_000);
  });

  it("an invalid stored value is a named refusal, never a silent default", () => {
    expect(() => resolveTurnStepTimeoutMs("not-a-number")).toThrowError(
      TurnStepTimeoutUnconfiguredError,
    );
    try {
      resolveTurnStepTimeoutMs("not-a-number");
    } catch (err) {
      expect((err as TurnStepTimeoutUnconfiguredError).reason).toBe("invalid");
    }
  });
});

describe("AI SDK stepMs mechanism through generateTextModelTurn (#5423)", () => {
  it("a step that exceeds stepMs aborts with a named TimeoutError", async () => {
    const model = new MockLanguageModelV4({ doGenerate: hangingDoGenerate() });
    const opts: ModelTurnOptions = {
      model,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stepTimeoutMs: 50,
    };
    const start = Date.now();
    const err = await generateTextModelTurn(opts).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).message).toContain("Step timeout of 50ms exceeded");
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10000);

  it("the timer is per-step: a fast first step does not consume the second step's budget", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options: { abortSignal?: AbortSignal }) => {
        calls += 1;
        if (calls === 1) {
          await sleep(80);
          return toolCallResult();
        }
        return hangingDoGenerate()(options);
      },
    });
    const start = Date.now();
    const err = await generateTextModelTurn({
      model,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {
        echo: tool({
          description: "echo",
          parameters: z.object({}),
          execute: async () => "ok",
        }),
      },
      maxSteps: 5,
      stepTimeoutMs: 100,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("TimeoutError");
    // Step 1 took ~80ms; step 2's own 100ms budget fired: total must
    // exceed 150ms. A TOTAL timeout would have fired at 100ms.
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  }, 10000);

  it("the step-count cap still binds alongside the timeout", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        return toolCallResult();
      },
    });
    const result = await generateTextModelTurn({
      model,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {
        echo: tool({
          description: "echo",
          parameters: z.object({}),
          execute: async () => "ok",
        }),
      },
      maxSteps: 2,
      stepTimeoutMs: 5000,
    });
    expect(calls).toBe(2);
    expect(result.text).toBeDefined();
  }, 10000);

  it("an unconfigured timeout refuses before any model call", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult("should never be called"),
    });
    const err = await generateTextModelTurn({
      model,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      // stepTimeoutMs deliberately absent: the named refusal must fire.
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TurnStepTimeoutUnconfiguredError);
    expect((model as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls.length).toBe(0);
  });
});

describe("turn runner records the timeout as a named outcome (#5423)", () => {
  it("a TimeoutError from the model turn is recorded on the structured log and via onChatError", async () => {
    const sink = new RecordingSink();
    const structuredLog = createStructuredLogger(sink, { component: "actor-turn-runner" });
    const { hooks, errors } = stubHooks();
    const timeoutError = new DOMException("Step timeout of 5000ms exceeded", "TimeoutError");
    const runner = new AgentChatTurnRunner({
      hooks,
      session: stubSession(),
      modelTurn: async () => {
        throw timeoutError;
      },
      resolveStepTimeoutMs: () => 5000,
      structuredLog,
    });
    await expect(runner.runTurn("hi")).rejects.toBe(timeoutError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(timeoutError);
    const timeoutEvents = sink.events.filter((e) => e.operation === "turn.step_timeout");
    expect(timeoutEvents).toHaveLength(1);
    const event = timeoutEvents[0]!;
    expect(event.level).toBe("error");
    expect(event.component).toBe("actor-turn-runner");
    expect(event.fields["timeoutMs"]).toBe(5000);
    expect(typeof event.fields["requestId"]).toBe("string");
    // The 7 mandatory attributes ride on every event.
    expect(typeof event.traceId).toBe("string");
    expect(event.traceId.length).toBeGreaterThan(0);
    expect(typeof event.timestampIso).toBe("string");
    expect(event.tenantId).toBeNull();
  });

  it("an unconfigured timeout is recorded as a named refusal outcome", async () => {
    const sink = new RecordingSink();
    const structuredLog = createStructuredLogger(sink, { component: "actor-turn-runner" });
    const { hooks, errors } = stubHooks();
    const runner = new AgentChatTurnRunner({
      hooks,
      session: stubSession(),
      modelTurn: generateTextModelTurn,
      // No resolver: the model turn must refuse before calling the model.
      structuredLog,
    });
    await expect(runner.runTurn("hi")).rejects.toBeInstanceOf(TurnStepTimeoutUnconfiguredError);
    expect(errors).toHaveLength(1);
    const events = sink.events.filter((e) => e.operation === "turn.step_timeout_unconfigured");
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("error");
  });

  it("a turn inside its timeout completes with no timeout event", async () => {
    const sink = new RecordingSink();
    const structuredLog = createStructuredLogger(sink, { component: "actor-turn-runner" });
    const { hooks } = stubHooks();
    const runner = new AgentChatTurnRunner({
      hooks,
      session: stubSession(),
      modelTurn: async () => ({ text: "hello" }),
      resolveStepTimeoutMs: () => 5000,
      structuredLog,
    });
    const result = await runner.runTurn("hi");
    expect(result.status).toBe("completed");
    expect(sink.events.filter((e) => e.operation.startsWith("turn.step_timeout"))).toHaveLength(0);
  });
});

describe("tenant-scoped timeout store (#5423)", () => {
  it("round-trips through the commercial store port; absent reads null", async () => {
    const store = new InMemoryCommercialAdapter();
    expect(await store.getTenantTurnStepTimeoutMs("primary")).toBeNull();
    const record = await store.setTenantTurnStepTimeoutMs("primary", 30_000);
    expect(record.turnStepTimeoutMs).toBe(30_000);
    expect(await store.getTenantTurnStepTimeoutMs("primary")).toBe(30_000);
    // A sibling tenant is untouched: the value is tenant-scoped.
    expect(await store.getTenantTurnStepTimeoutMs("second")).toBeNull();
  });

  it("the PATCH body schema accepts the timeout field", () => {
    const parsed = tenantSettingsBodySchema.safeParse({ turnStepTimeoutMs: 30_000 });
    expect(parsed.success).toBe(true);
    expect(tenantSettingsBodySchema.safeParse({ turnStepTimeoutMs: "soon" }).success).toBe(false);
  });
});

describe("migration 0078: tenant turn-step timeout column (#5423)", () => {
  it("adds turn_step_timeout_ms to agent_tenant_settings and registers in ALL_MIGRATIONS", () => {
    const sql = d1MigrationSql(78);
    expect(sql).toContain("ALTER TABLE agent_tenant_settings ADD COLUMN turn_step_timeout_ms");
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(78);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
