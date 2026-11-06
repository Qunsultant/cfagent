/**
 * Issue #1738 — the AgentActorDO port.
 *
 * The single actor contract every agent DO speaks, behind which the
 * Cloudflare Agents SDK runtime (cfAgentsAdapter) and the in-memory
 * test runtime (inMemoryActorAdapter) are interchangeable. Domain code
 * never imports a provider SDK directly: it programs against these
 * interfaces, and the adapter binds them to a runtime.
 *
 * Facets (each independently implementable, following the *Ports.ts
 * style of #1739 messaging and #1737 workflows):
 *  - ActorStatePort: durable KV + DO SQLite, the actor's own storage.
 *  - ActorSchedulePort: schedule-by-method-name (Agents SDK stable
 *    surface: schedule/scheduleEvery/listSchedules/cancelSchedule).
 *  - ActorSessionPort: the chat transcript (UIMessage shape), the
 *    replacement for Think's session store. Upsert-by-id append
 *    preserves Think's saveMessages semantics.
 *  - ActorTurnPort: the chat turn (beforeTurn -> runTurn ->
 *    onChatResponse/onChatError) for chat actors. Non-chat actors
 *    (Research, Trading) do not drive turns; they expose the model /
 *    tool identity facet only (getModel/getSystemPrompt/getTools).
 *
 * Envelope/job participation is NOT redefined here: actors emit and
 * handle CloudEvents v1.0 through #1739's messaging port and consume
 * stage-typed job commands through #1737's WorkflowPort, carrying the
 * same jobid/parentjobid/shardid/stage extensions. No second event or
 * job model exists.
 *
 * Pattern rules (AgentActorDO, documented in ADR 0005):
 *  - Naming: `*Agent` classes in src/agents/, one class per DO.
 *  - Binding: wrangler.jsonc `<NAME>_AGENT` durable_objects entries
 *    with their existing new_sqlite_classes migration tags. A base
 *    change alone needs no new migration: class names and storage
 *    schemas are unchanged.
 *  - State ownership: this.ctx.storage (+ .sql) only. No shared
 *    mutable client state; everything user/session/run-scoped.
 *  - Hibernation/restart: actor state survives; the in-flight turn
 *    stash (pendingTurn) is in-memory and re-derived on wake. There
 *    is no durable turn-sealing step (Think's chatRecovery had one;
 *    the Agent runtime does not — disclosed in ADR 0005).
 */
import type { ToolSet } from "ai";

/** One chat transcript message, UIMessage-shaped (parts carry text and tool parts). */
export interface UiChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/** A legacy chat row (pre-actor transcript storage): a whole UIMessage as JSON. */
export interface LegacyChatRow {
  id: string;
  message: string;
  created_at: string;
}

/**
 * Legacy-row transform (mechanical envelope mapping, moved into
 * production code from the old #658 test harness): id/role/parts/
 * metadata carried through, createdAt taken from the row.
 */
export function legacyRowToSessionMessage(row: LegacyChatRow): UiChatMessage {
  const msg = JSON.parse(row.message) as {
    id?: string;
    role: "user" | "assistant" | "system";
    parts?: UiChatMessage["parts"];
    metadata?: Record<string, unknown>;
  };
  const out: UiChatMessage = {
    id: msg.id ?? row.id,
    role: msg.role,
    parts: msg.parts ?? [],
    createdAt: row.created_at,
  };
  if (msg.metadata !== undefined) out.metadata = msg.metadata;
  return out;
}

/** Model-facing message (text-only mapping; tool parts stay in the transcript, not the model input). */
export interface ModelChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Turn context handed to a chat actor's beforeTurn hook. */
export interface TurnContext {
  system: string;
  messages: ModelChatMessage[];
  tools: ToolSet;
  model: unknown;
  continuation: boolean;
  body?: Record<string, unknown>;
}

/**
 * Turn configuration returned by beforeTurn. Only the fields a
 * current beforeTurn produces are honored by the runner:
 * instructions, maxSteps, activeTools. messages/tools/model pass
 * through for forward compatibility.
 */
export interface TurnConfig {
  model?: unknown;
  instructions?: string;
  system?: string;
  messages?: ModelChatMessage[];
  tools?: ToolSet;
  activeTools?: string[];
  maxSteps?: number;
}

/**
 * A verified webhook delivery handed to an actor's onWebhook hook
 * (issue #3474). The Think port verifies the HMAC-SHA256 signature
 * over `rawBody` BEFORE parsing, so `payload` is only ever the
 * parsed form of a body that passed verification. `source` is the
 * reserved-path segment the delivery arrived on
 * (`.../webhooks/<source>`).
 */
export interface ActorWebhookEvent {
  /** Reserved-path source segment (the segment after `/webhooks/`). */
  source: string;
  /** The verified, parsed JSON body. */
  payload: unknown;
  /** The raw body text exactly as received — what the signature covered. */
  rawBody: string;
  /** The delivery's headers (provider event-type headers live here). */
  headers: Headers;
  /** The URL the webhook was delivered to. */
  url: URL;
}

/** Turn result handed to onChatResponse. */
export interface ChatResponseResult {
  status: "completed" | "error";
  message?: UiChatMessage;
  requestId?: string;
  continuation?: boolean;
  error?: string;
}

/** Turn input forms, mirroring Think's runTurn: string, list, factory, or config override. */
export type TurnInput =
  | string
  | UiChatMessage[]
  | ((current: UiChatMessage[]) => UiChatMessage[] | Promise<UiChatMessage[]>)
  | { configOverride: TurnConfig };

/** Durable KV + DO SQLite, the actor's own storage. */
export interface ActorStatePort {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  sql(sql: string, ...params: unknown[]): Iterable<unknown>;
}

/** Schedule-by-method-name (the SDK dispatches callbacks by method name). */
export interface ActorSchedulePort {
  schedule<T = unknown>(
    when: number | Date | string,
    callback: string,
    payload?: T,
    options?: unknown
  ): Promise<unknown>;
  scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: string,
    payload?: T
  ): Promise<unknown>;
  listSchedules(): Promise<unknown[]>;
  cancelSchedule(id: string): Promise<boolean>;
  getScheduleById?(id: string): Promise<unknown | undefined>;
}

/** Chat transcript store (replaces Think's session store). */
export interface ActorSessionPort {
  getMessages(): Promise<UiChatMessage[]>;
  /** Upsert-by-id append (Think saveMessages semantics: only the delta lands). */
  appendMessages(messages: UiChatMessage[]): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  /** One-time legacy-row lift into the transcript store. */
  migrateLegacyRows(rows: LegacyChatRow[]): Promise<void>;
  clear(): Promise<void>;
}

/** The hooks a chat actor implements; the turn runner drives them. */
export interface ActorTurnHooks {
  getModel(): unknown;
  getSystemPrompt(): string;
  getTools(): ToolSet;
  beforeTurn(ctx: TurnContext): Promise<TurnConfig | void>;
  onChatResponse(result: ChatResponseResult): Promise<void>;
  onChatError?(error: unknown): string | Promise<string>;
  /**
   * Webhook deliveries (issue #3474): the Think port verifies and
   * dispatches them to this hook. Absent hook = the port refuses
   * safely, so an actor is never driven by a webhook it did not opt
   * into. The hook is invoked exactly like the other port hooks
   * (a method call on this object), so the fleet's closure idiom
   * applies: a hook defined in the actor's constructor closes over
   * the actor and may end in `this.setState(...)`, reaching the
   * base Agent's state broadcast untouched. Returning a Response
   * answers with it; returning void answers 200 "OK" (the Agents
   * docs idiom).
   */
  onWebhook?(event: ActorWebhookEvent): Promise<Response | void> | Response | void;
  maxSteps?: number;
}

/** The chat turn: beforeTurn -> model turn -> onChatResponse/onChatError. */
export interface ActorTurnPort {
  runTurn(input: TurnInput): Promise<ChatResponseResult>;
}

/** The full actor port: state + schedule + session + turn. */
export interface ActorPort {
  state: ActorStatePort;
  schedule: ActorSchedulePort;
  session: ActorSessionPort;
  turn: ActorTurnPort;
}

export type ActorErrorCode = "invalid_input" | "unavailable" | "turn_failed";

export class ActorError extends Error {
  code: ActorErrorCode;
  constructor(code: ActorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
