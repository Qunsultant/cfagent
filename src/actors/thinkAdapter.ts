/**
 * Issue #1935 (O3 spike) — the Think-backed adapter for the actor port.
 *
 * Shape (a): Think behind the existing actor port. Think extends
 * Agent, so three of the four facets are IDENTICAL to the cf adapter
 * and are reused verbatim (state = ctx.storage passthrough, schedule
 * = SDK scheduler delegation, session = flat ActorSessionStore).
 * Only the turn facet is Think-specific, and only it is new code.
 *
 * Turn design (mirrors AgentChatTurnRunner's observable lifecycle):
 *   port session input delta -> port beforeTurn -> Think runTurn
 *   (one-shot override) -> append assistant message -> port
 *   onChatResponse (or port onChatError + rethrow on model failure)
 *
 * Two protocol points a Think subclass behind the port MUST honor
 * (both live on PortThink, so a migrating agent class gets them by
 * extending PortThink instead of raw Think):
 *  1. One-shot override: the adapter calls the port's beforeTurn
 *     itself (exactly once, like the runner) and installs the result
 *     as a one-shot that PortThink.beforeTurn returns WITHOUT
 *     re-delegating. A configOverride input installs its override
 *     directly and skips the port's beforeTurn entirely. Direct
 *     Think turns (WS chat, submitMessages) that bypass the adapter
 *     have no one-shot installed, so PortThink.beforeTurn delegates
 *     to the port hooks then — still exactly once per turn.
 *  2. Hook order: Think's pipeline fires onChatResponse INSIDE
 *     runTurn, before the adapter can append the assistant message
 *     to the port session. PortThink.onChatResponse therefore only
 *     RECORDS during adapter-driven turns; the adapter flushes the
 *     port's onChatResponse itself AFTER the append, restoring the
 *     runner's append -> onChatResponse order. Direct turns (no
 *     adapter in flight) delegate straight to the port hooks.
 *
 * Known Think constraints this adapter works around (all verified
 * against @cloudflare/think 0.19.0 source, not assumed):
 *  - Think calls onChatError WITHOUT awaiting it, so a port
 *    onChatError that returns a Promise cannot control Think's
 *    error text (it still fires exactly once; only the text falls
 *    back to the raw error message). Port onChatError hooks behind
 *    Think must be synchronous to control the text.
 *  - Think's wait path returns { status: "error" } instead of
 *    throwing on model failure (or throws, depending on stage);
 *    the adapter translates BOTH into the port contract
 *    (onChatError exactly once, then rethrow).
 *  - Think's runTurn requires an input (or continuation: true),
 *    and its inference loop refuses a turn with zero messages
 *    ("No messages to send to the model"). A configOverride turn
 *    therefore passes the port session's stored history as a plain
 *    list: non-empty history runs the model turn with the override;
 *    empty history takes Think's "skipped" path (empty list input
 *    returns status "skipped", not an error), which the adapter
 *    maps to completed-with-no-message. Either way history is
 *    upserted by id, never duplicated (proven by the spike proof).
 *    The earlier identity-factory shape is WRONG for this case: a
 *    factory returning an empty history bypasses the empty-list
 *    guard and hits the "No messages" error.
 *
 * Lifecycle precondition (proven by the spike proof, issue #1935):
 * a Think turn touches Think's session, which onStart/startThink
 * configures — but native RPC bypasses the lifecycle startup that
 * fetch/alarm/WebSocket entry points run automatically. The turn
 * therefore boots the lifecycle explicitly (lifecycle.start(),
 * idempotent) before any port mutation. Without it, a turn on a
 * fresh RPC-only instance throws "reading 'appendMessage'" with
 * this.session undefined, forever — no amount of waiting helps,
 * because nothing ever triggers startup. This is an adapter
 * precondition, not a port change: the port contract is unchanged.
 *
 * Dual stores, stated plainly: the port session (flat, upsert-by-id)
 * and Think's tree session (branching, compaction, FTS) are SEPARATE
 * stores inside the same DO. A turn writes to both (Think's pipeline
 * to its session, the adapter to the port session). Tree operations
 * (branch/fork/compact) have NO port equivalent — the port exposes
 * the flat transcript only. Exposing tree sessions through the port
 * would be a port change (new session operations), not an adapter
 * detail; this spike does not make it.
 */
import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext as ThinkChatErrorContext,
  ChatResponseResult as ThinkChatResponseResult,
  TurnConfig as ThinkTurnConfig,
  TurnContext as ThinkTurnContext,
  TurnInputMessages as ThinkTurnInputMessages,
} from "@cloudflare/think";
// Issue #2566: the durable-submission types, re-exported here so
// consumers (src/agents/orchestrator/durableTurnSubmission.ts)
// reach Think's surface through the foundation adapter only — the
// agent-conformance pin forbids direct "@cloudflare/think" imports
// outside the adapter files.
export type {
  SubmitMessagesResult,
  ThinkSubmissionInspection,
} from "@cloudflare/think";
// Issue #2693: the code-declared scheduled-task types, re-exported
// here so the observe-only declaration module
// (src/agents/orchestrator/scheduledTasksObserve.ts) and the
// OrchestratorAgent getScheduledTasks override reach Think's
// surface through the foundation adapter only.
export type {
  ThinkScheduledTaskContext,
  ThinkScheduledTasks,
} from "@cloudflare/think";
// Issue #2705: the Agent Skills source type, re-exported here so
// the OrchestratorAgent skills-hook override and its extracted
// module (src/agents/orchestrator/skillPacks.ts) reach Think's
// surface through the foundation adapter only. (The runtime
// skills factory itself is the agents package's skills module —
// the module Think imports and re-exports as its skills
// namespace — and is imported there, not here: this adapter
// re-exports the TYPE so the class signature stays behind the
// port, and PortThink itself neither overrides nor blocks the
// hook.)
export type { SkillSource } from "@cloudflare/think";
import type { UIMessage } from "ai";
import {
  createCfActorSchedule,
  createCfActorSession,
  createCfActorState,
} from "./cfAgentsAdapter";
import { createActorPorts } from "./createActorPorts";
import { toModelMessages } from "./actorTurnRunner";
import type {
  ActorPort,
  ActorSessionPort,
  ActorTurnHooks,
  ActorTurnPort,
  ChatResponseResult,
  TurnConfig,
  TurnInput,
  UiChatMessage,
} from "./actorPorts";
import {
  portMessagesToThink,
  portTurnConfigToThink,
  thinkChatResponseToPort,
  thinkTurnContextToPort,
  thinkTurnResultToPort,
} from "./thinkPortMapping";

/**
 * Think base for port-backed agents. A migrating agent class extends
 * PortThink (not raw Think) and exposes its port hooks object; the
 * class's domain methods keep the port's beforeTurn/onChatResponse/
 * onChatError signatures, and PortThink translates Think's hook
 * calls into them. This avoids a signature clash: the class never
 * defines a Think-signature beforeTurn, so Think's pipeline always
 * dispatches to PortThink's translation below.
 */
export class PortThink extends Think<any> {
  /** Port hooks object (the class's domain hooks, port signatures). */
  portHooks?: ActorTurnHooks;
  /** One-shot TurnConfig installed by the adapter for the next turn. */
  private portTurnOverride?: { installed: boolean; config: ThinkTurnConfig | void };
  /** True while an adapter-driven turn is inside think.runTurn. */
  adapterTurnActive = false;
  /** True once the port's onChatError has fired for the active turn. */
  adapterTurnErrorReported = false;
  /** Last Think onChatResponse result, recorded during adapter turns. */
  lastThinkResponse?: ThinkChatResponseResult;

  setPortTurnOverride(config: ThinkTurnConfig | void): void {
    this.portTurnOverride = { installed: true, config };
  }

  beginAdapterTurn(): void {
    this.adapterTurnActive = true;
    this.adapterTurnErrorReported = false;
    this.lastThinkResponse = undefined;
  }

  endAdapterTurn(): void {
    this.adapterTurnActive = false;
  }

  override async beforeTurn(ctx: ThinkTurnContext): Promise<ThinkTurnConfig | void> {
    const override = this.portTurnOverride;
    this.portTurnOverride = undefined;
    if (override?.installed) return override.config;
    if (!this.portHooks) return undefined;
    const portConfig = await this.portHooks.beforeTurn(thinkTurnContextToPort(ctx));
    return portTurnConfigToThink(portConfig);
  }

  override async onChatResponse(result: ThinkChatResponseResult): Promise<void> {
    if (this.adapterTurnActive) {
      // Record-only: the adapter flushes the port's onChatResponse
      // itself after appending, restoring runner order.
      this.lastThinkResponse = result;
      return;
    }
    if (this.portHooks) {
      await this.portHooks.onChatResponse(
        thinkChatResponseToPort(result, crypto.randomUUID())
      );
    }
  }

  override onChatError(error: unknown, _ctx?: ThinkChatErrorContext): unknown {
    // Think does NOT await this hook: the return value is used
    // synchronously as the error text. A port hook returning a
    // Promise still fires exactly once, but its text is unusable
    // here, so fall back to the raw error message in that case.
    if (this.adapterTurnActive) this.adapterTurnErrorReported = true;
    if (!this.portHooks?.onChatError) return error;
    const out = this.portHooks.onChatError(error);
    if (typeof out === "string") return out;
    if (out && typeof (out as Promise<string>).then === "function") {
      (out as Promise<string>).catch(() => {});
      return error instanceof Error ? error.message : String(error);
    }
    return error;
  }
}

/** The Think turn facet: port session delta + port hooks + Think runTurn. */
export interface ThinkActorTurnDeps {
  think: PortThink;
  hooks: ActorTurnHooks;
  session: ActorSessionPort;
}

export class ThinkActorTurn implements ActorTurnPort {
  constructor(private readonly deps: ThinkActorTurnDeps) {}

  async runTurn(input: TurnInput): Promise<ChatResponseResult> {
    const { think, hooks, session } = this.deps;
    const requestId = crypto.randomUUID();
    // Lifecycle boot (REQUIRED for RPC-invoked turns, first, so a
    // boot failure leaves no partial port state): native RPC
    // bypasses fetch, and only fetch/alarm/WebSocket entry points
    // run the Agent lifecycle — which configures Think's session
    // in onStart/startThink. The SDK says so itself (agents
    // Lifecycle.start: "RPC methods may call it explicitly
    // because native RPC bypasses fetch"). lifecycle.start() is
    // idempotent (_ensureInitialized returns early once started)
    // and is what the SDK scheduler's capability-scoped ready()
    // funnels into — which is why the spike proof's warm cases
    // passed (their schedule case booted the instance) while a
    // turn-only fresh instance threw "reading 'appendMessage'"
    // with this.session undefined. NOTE: lifecycle.ready() does
    // NOT exist on the Agent's lifecycle object — ready() lives
    // only on the per-capability services object the Scheduler
    // holds, and a guarded ready?.() call silently no-ops (the
    // spike proof caught exactly this). The boot call is start().
    // Guarded: a Think-like object without a lifecycle still runs
    // (its session is the caller's responsibility then).
    await (
      think as unknown as { lifecycle?: { start?: () => Promise<unknown> } }
    ).lifecycle?.start?.();
    const current = await session.getMessages();

    let configOverride: TurnConfig | undefined;
    // Think input mirroring the port input; the factory case calls
    // the port factory ONCE (like the runner) and hands Think the
    // full resulting list — safe only if Think upserts by id on
    // save (the spike proof asserts this; see thinkAdapter header).
    let thinkInput: ThinkTurnInputMessages;
    if (typeof input === "string" && input) {
      const msg: UiChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: input }],
      };
      await session.appendMessages([msg]);
      thinkInput = input;
    } else if (typeof input === "function") {
      const next = await input(current);
      await session.appendMessages(next ?? []);
      thinkInput = portMessagesToThink(next ?? []) as unknown as UIMessage[];
    } else if (Array.isArray(input)) {
      await session.appendMessages(input);
      thinkInput = portMessagesToThink(input) as unknown as UIMessage[];
    } else if (input && typeof input === "object" && "configOverride" in input) {
      configOverride = (input as { configOverride: TurnConfig }).configOverride;
      // Deferred: the Think input is the stored port history (set
      // below, after `stored` is read). A plain list, not an
      // identity factory — see the header note on the empty-list
      // "skipped" path vs the factory "No messages" error.
      thinkInput = [];
    } else {
      thinkInput = [];
    }

    const stored = await session.getMessages();
    if (configOverride !== undefined) {
      thinkInput = portMessagesToThink(stored) as unknown as UIMessage[];
    }
    const config =
      configOverride ??
      ((await hooks.beforeTurn({
        system: hooks.getSystemPrompt(),
        messages: toModelMessages(stored),
        tools: hooks.getTools(),
        model: hooks.getModel(),
        continuation: false,
        body: { turnId: requestId, trigger: "user_message" },
      })) as TurnConfig | void | undefined) ??
      undefined;
    think.setPortTurnOverride(portTurnConfigToThink(config));

    think.beginAdapterTurn();
    let result;
    try {
      result = await think.runTurn({ input: thinkInput, mode: "wait" });
    } catch (err) {
      think.endAdapterTurn();
      if (!think.adapterTurnErrorReported && hooks.onChatError) await hooks.onChatError(err);
      throw err;
    }
    think.endAdapterTurn();

    const portResult = thinkTurnResultToPort(result, requestId);
    if (portResult.status === "error") {
      if (!think.adapterTurnErrorReported && hooks.onChatError) {
        await hooks.onChatError(new Error(portResult.error ?? "think turn failed"));
      }
      throw new Error(portResult.error ?? "think turn failed");
    }
    if (portResult.message) await session.appendMessages([portResult.message]);
    await hooks.onChatResponse(portResult);
    return portResult;
  }
}

/** Think inherits Agent's storage/scheduler, so these facets ARE the cf ones. */
export const createThinkActorState = createCfActorState;
export const createThinkActorSchedule = createCfActorSchedule;
export const createThinkActorSession = createCfActorSession;

export function createThinkActorTurn(
  think: PortThink,
  hooks: ActorTurnHooks,
  session: ActorSessionPort
): ActorTurnPort {
  return new ThinkActorTurn({ think, hooks, session });
}

/** Think-backed port via the factory's "think" variant (turn injected). */
export function createThinkActorPort(deps: {
  think: PortThink;
  hooks: ActorTurnHooks;
  storage: Parameters<typeof createCfActorState>[0];
  scheduler?: Parameters<typeof createCfActorSchedule>[0];
}): ActorPort {
  return createActorPorts("think", {
    hooks: deps.hooks,
    storage: deps.storage,
    scheduler:
      deps.scheduler ??
      (deps.think as unknown as Parameters<typeof createCfActorSchedule>[0]),
    thinkTurn: (session) => createThinkActorTurn(deps.think, deps.hooks, session),
  });
}
