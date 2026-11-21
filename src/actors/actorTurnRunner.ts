/**
 * Issue #1738 — the Agent-native chat turn runner.
 *
 * Replaces Think's runTurn for chat actors with the same observable
 * lifecycle, driven by the actor's own hooks:
 *
 *   transcript -> apply input delta (upsert-by-id) -> beforeTurn
 *   -> model turn (AI SDK generateText) -> append assistant message
 *   -> onChatResponse (or onChatError + rethrow on model failure)
 *
 * What is preserved, deliberately:
 *  - beforeTurn/onChatResponse/onChatError are the class's own
 *    methods, called in the same order with the same shapes. The
 *    judge routing, session hygiene, user/assistant mas_messages
 *    records, audit events, and VectorMemory recall inside those
 *    hooks are untouched.
 *  - The model turn uses the same model (getModel), the same tools
 *    (getTools), the same instructions (beforeTurn's return, falling
 *    back to getSystemPrompt), and the same step bound (beforeTurn's
 *    maxSteps, falling back to the class maxSteps). activeTools
 *    limits the toolset by filtering, which is exactly the limit
 *    semantic (an empty list means no tools).
 *  - Input forms mirror Think's runTurn: a string appends one user
 *    message; a list appends by upsert; a factory receives the
 *    current transcript and returns the new list (upsert applies
 *    only the delta, so a re-sent history tail is a no-op); an
 *    object with configOverride skips beforeTurn.
 *  - Model messages are a text-only mapping of the transcript
 *    (role + joined text parts), matching how the codebase already
 *    consumes history (deriveTurn's recentTurns). Tool parts stay
 *    in the transcript store at full fidelity; they are not replayed
 *    to the model.
 *
 * What is disclosed as changed (ADR 0005):
 *  - No streaming to WebSocket clients: the HTTP path awaits the
 *    final text, which is identical. Think's WS chat transport goes
 *    away with the base change (no in-repo client uses it).
 *  - No durable turn sealing on eviction (Think's chatRecovery).
 *    The in-flight stash is in-memory and re-derived on wake.
 *  - Model failures rethrow after onChatError, so the route's
 *    degraded-fallback handling sees them exactly as before.
 */
import { generateText, stepCountIs } from "ai";
import { getSharedOutboundLimiter } from "../security/outboundRateLimiter";
import { TurnStepTimeoutUnconfiguredError } from "../config/turnStepTimeout";
import { ConsoleObservabilitySink } from "../observability/observabilityPorts";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import type {
  ActorSessionPort,
  ActorTurnHooks,
  ActorTurnPort,
  ChatResponseResult,
  ModelChatMessage,
  TurnConfig,
  TurnInput,
  UiChatMessage,
} from "./actorPorts";

/** The model-turn boundary, injectable so tests stub the provider. */
export interface ModelTurnOptions {
  model: unknown;
  system: string;
  messages: ModelChatMessage[];
  tools: import("ai").ToolSet;
  maxSteps?: number;
  /**
   * Per-step timeout in milliseconds (#5423, #3515 S4). REQUIRED at
   * runtime: the production model turn refuses (named refusal) when
   * it is absent — a turn never runs unbounded. The runner resolves
   * it from the tenant's configured value before the model turn.
   */
  stepTimeoutMs?: number;
  /** Tenant the timeout was resolved for (names the refusal). */
  tenantId?: string;
}

export type ModelTurnFn = (opts: ModelTurnOptions) => Promise<{ text: string }>;

/**
 * True when an error is the AI SDK's per-step timeout abort: the SDK
 * aborts the step's controller with a DOMException named
 * `TimeoutError` ("Step timeout of <ms>ms exceeded", ai 7.0.123
 * `setAbortTimeout`). The name alone is not enough — a total or
 * chunk timeout would share it — so the "Step timeout" message
 * prefix is part of the classification.
 */
export function isTurnStepTimeoutError(err: unknown): err is DOMException {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "TimeoutError" &&
    typeof (err as { message?: unknown }).message === "string" &&
    (err as { message: string }).message.startsWith("Step timeout")
  );
}

/**
 * Production model turn: AI SDK generateText (the same tool loop
 * streamText runs). AI SDK 7 has no maxSteps option: the bound is
 * expressed as stopWhen: stepCountIs(maxSteps), which is exactly
 * the step bound Think enforced.
 *
 * Per-step timeout (#5423): the vendor primitive, `timeout:
 * { stepMs }` (ai 7.0.123 `TimeoutConfiguration`). The SDK arms a
 * fresh timer per step and aborts the step with a named
 * TimeoutError; the step-count cap stays enforced alongside via
 * stopWhen. No hand-rolled timer, no AbortSignal.timeout wrapper:
 * the SDK owns the timer. The refusal check runs BEFORE the
 * outbound-limiter acquire so an unconfigured turn fails fast
 * without consuming a shared token.
 */
export const generateTextModelTurn: ModelTurnFn = async (opts) => {
  if (opts.stepTimeoutMs === undefined) {
    throw new TurnStepTimeoutUnconfiguredError(opts.tenantId ?? "primary", "absent");
  }
  // Issue #3515 S1: the direct actor-turn path had no outbound limiter
  // (the gateway port's opt-in limiter only covers turns routed through
  // the port). One shared LLM token per turn, bounded wait, else a typed
  // OutboundRateLimitError via onChatError upstream.
  await getSharedOutboundLimiter("llm").acquire();
  const { text } = await generateText({
    model: opts.model as never,
    system: opts.system,
    messages: opts.messages as never,
    tools: opts.tools,
    stopWhen: opts.maxSteps !== undefined ? stepCountIs(opts.maxSteps) : undefined,
    timeout: { stepMs: opts.stepTimeoutMs },
  });
  return { text };
};

/** Text-only transcript -> model-message mapping. */
export function toModelMessages(transcript: UiChatMessage[]): ModelChatMessage[] {
  return transcript.map((m) => ({
    role: m.role,
    content: (m.parts ?? [])
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(""),
  }));
}

function pickTools(
  tools: import("ai").ToolSet,
  activeTools: string[] | undefined
): import("ai").ToolSet {
  if (activeTools === undefined) return tools;
  const keep = new Set(activeTools);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => keep.has(name)));
}

export interface TurnRunnerDeps {
  hooks: ActorTurnHooks;
  session: ActorSessionPort;
  modelTurn: ModelTurnFn;
  /**
   * Abort gate, evaluated before the assistant message is appended
   * and before onChatResponse fires. The orchestrator wires it to
   * its reset epoch so a memory-reset aborts an in-flight turn's
   * side effects instead of letting them land after the clear.
   * Absent means never abort.
   */
  isAborted?: () => boolean;
  /**
   * Per-step timeout resolver (#5423): returns the tenant's
   * configured timeout in milliseconds for this turn (read
   * through the tenant-settings port by the factory caller).
   * Resolved once per turn, before the model turn, so a
   * mid-turn settings change never moves the goalposts. Absent
   * means the model turn refuses (named refusal) when it is
   * the production `generateTextModelTurn`; stub model turns
   * in tests ignore the value.
   */
  resolveStepTimeoutMs?: () => number | Promise<number>;
  /**
   * Tenant the timeout was resolved for (names the refusal and
   * scopes the timeout events). Absent reads as the deployment
   * default tenant in the refusal text.
   */
  tenantId?: string;
  /**
   * Structured logger for the turn's timeout outcomes (#5423).
   * Absent means the explicit `ConsoleObservabilitySink`
   * fallback (the batch-10 clientLogger precedent): timeout
   * events land in the console as structured JSON. Never build
   * the sink from an empty env here — the #5587 rule forbids
   * new empty-env sinks. A caller with an env in scope injects
   * an env-constructed sink's logger instead, and the events
   * reach the AE dataset.
   */
  structuredLog?: StructuredLogger;
}

export class AgentChatTurnRunner implements ActorTurnPort {
  private readonly log: StructuredLogger;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.log =
      deps.structuredLog ??
      createStructuredLogger(new ConsoleObservabilitySink(), {
        component: "actor-turn-runner",
      });
  }

  async runTurn(input: TurnInput): Promise<ChatResponseResult> {
    const { hooks, session, modelTurn } = this.deps;
    const requestId = crypto.randomUUID();
    const current = await session.getMessages();

    let configOverride: TurnConfig | undefined;
    if (typeof input === "string" && input) {
      await session.appendMessages([
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: input }],
        },
      ]);
    } else if (typeof input === "function") {
      const next = await input(current);
      await session.appendMessages(next ?? []);
    } else if (Array.isArray(input)) {
      await session.appendMessages(input);
    } else if (input && typeof input === "object" && "configOverride" in input) {
      configOverride = (input as { configOverride: TurnConfig }).configOverride;
    }

    const stored = await session.getMessages();
    const modelMessages = toModelMessages(stored);
    const config =
      configOverride ??
      ((await hooks.beforeTurn({
        system: hooks.getSystemPrompt(),
        messages: modelMessages,
        tools: hooks.getTools(),
        model: hooks.getModel(),
        continuation: false,
        body: { turnId: requestId, trigger: "user_message" },
      })) as TurnConfig | void | undefined) ??
      undefined;

    const instructions = config?.instructions ?? hooks.getSystemPrompt();
    const maxSteps = config?.maxSteps ?? hooks.maxSteps;
    const tools = pickTools(hooks.getTools(), config?.activeTools);

    let text: string;
    let stepTimeoutMs: number | undefined;
    try {
      stepTimeoutMs = await this.deps.resolveStepTimeoutMs?.();
      ({ text } = await modelTurn({
        model: config?.model ?? hooks.getModel(),
        system: instructions,
        messages: config?.messages ?? modelMessages,
        tools: config?.tools ? pickTools(config.tools, config?.activeTools) : tools,
        maxSteps,
        stepTimeoutMs,
        tenantId: this.deps.tenantId,
      }));
    } catch (err) {
      // #5423: a timeout / refusal is a NAMED, RECORDED outcome,
      // not a silent stall. The event carries the 7 mandatory
      // attributes via the structured logger (tenant/actor/agent
      // read null here — the runner has no identity in scope, and
      // the logger never fabricates scope).
      if (isTurnStepTimeoutError(err)) {
        this.log.error("turn.step_timeout", {
          timeoutMs: stepTimeoutMs ?? null,
          requestId,
          error: err.message,
          errorName: err.name,
        });
      } else if (err instanceof TurnStepTimeoutUnconfiguredError) {
        this.log.error("turn.step_timeout_unconfigured", {
          reason: err.reason,
          requestId,
          error: err.message,
          errorName: err.name,
        });
      }
      if (hooks.onChatError) await hooks.onChatError(err);
      throw err;
    }

    if (this.deps.isAborted?.()) {
      return { status: "error", error: "aborted", requestId, continuation: false };
    }
    const message: UiChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }],
      metadata: {},
    };
    await session.appendMessages([message]);
    const result: ChatResponseResult = {
      status: "completed",
      message,
      requestId,
      continuation: false,
    };
    await hooks.onChatResponse(result);
    return result;
  }
}
