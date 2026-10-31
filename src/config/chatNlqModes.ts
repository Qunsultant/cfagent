/**
 * Issue #2488 — ONE runtime config switch for the NLQ tool's
 * presence in the CHAT TURN, in the PAYMENTS_FLOW_MODE (#1711) /
 * NLQ_MODE (#1722) pattern.
 *
 * Owner direction (2026-10-30): "just build the entire solution
 * without NLQ. keep NLQ in the turn but don't use it... turn it
 * off with a flag. don't touch NLQ... put it behind a flag."
 *
 * Switch (Worker env var, non-secret, owner-set; this slice sets
 * NO production value — the built-in default IS the directed
 * state):
 *   CHAT_NLQ_MODE
 * Values: "on" | "off" (case-insensitive, surrounding whitespace
 * ignored). Built-in default: "off" — the chat turn's tool set
 * does not offer `execute_nlq` to the model.
 *
 * What the switch governs (the turn's usable tool set ONLY):
 * - "off": the turn cannot call `execute_nlq`. The mechanism
 *   moved with the consumption path: #2488 enforced it in the
 *   turn's tool-assembly layer (createAgentMcpTools did not
 *   adapt the command); since #2496 the catalog reaches the turn
 *   by SDK discovery through Think's auto-merge, so the gate
 *   restricts the merged set at the Think layer —
 *   chatNlqTurnGate (src/agents/orchestrator/meshMcpClient.ts),
 *   applied by portBeforeTurn through TurnConfig.activeTools,
 *   excludes the discovered `tool_openaimp_execute_nlq`. The
 *   command stays registered in McpToolFactory — the /mcp
 *   surface, the facade, and every non-turn caller keep the
 *   #1722 contract verbatim; NLQ execution itself (the async
 *   `nlq.execute` capability, A2A, the REST routes, the channels,
 *   the chat error fallback) is untouched and does not read this
 *   switch.
 * - "on": `execute_nlq` is in the turn's usable set like every
 *   other discovered catalog tool (no activeTools restriction).
 *
 * Resolution order (the #1722 discipline): run > session >
 * user > global env > built-in ("off"). Carriers: run = a
 * per-call value (no run-level carrier exists for the turn;
 * the level is part of the resolver contract for parity
 * with the sibling switches); session / user = the optional
 * `scopedChatNlqModes` carrier (McpToolContext.scopedChatNlqModes
 * declares it for execution contexts; the turn gate's context
 * owner may supply it the same way); global env = the Worker
 * env var CHAT_NLQ_MODE. A blank/unset level falls through to the next
 * level. The FIRST non-blank level wins; if that value is
 * unrecognized, the resolution FAILS CLOSED to "off"
 * (invalid=true, level = the winning level) and does NOT fall
 * through to a lower level that might say "on". Callers must
 * log + audit `chat_nlq.config_error` on invalid.
 *
 * Boundary, stated honestly (mirrors the #1722 note): no
 * persisted settings store is introduced here. Session/user
 * carriers are honored in resolution order and unit-pinned,
 * but in production today only the global env level is
 * settable; no production context owner populates the scoped
 * carrier yet.
 */

/** The two states of the turn's NLQ tool. */
export type ChatNlqMode = "on" | "off";

/** The switch's Worker env var name. */
export const CHAT_NLQ_MODE_SWITCH = "CHAT_NLQ_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function chatNlqConfigErrorEvent(): string {
  return "chat_nlq.config_error";
}

/** One level of the resolution order. Blank/unset falls through. */
export interface ChatNlqModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for the switch, as carried by an execution context. */
export interface ChatNlqScopedModes {
  session?: unknown;
  user?: unknown;
}

export interface ResolvedChatNlqMode {
  mode: ChatNlqMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeModeValue(raw: unknown): ChatNlqMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "on") return "on";
  if (normalized === "off") return "off";
  return "invalid";
}

/**
 * Resolves the switch in run > session > user > env > builtin
 * order. First non-blank level wins; an invalid winner fails
 * closed to "off" with invalid=true (no fall-through to a
 * lower level).
 */
export function resolveChatNlqMode(levels: ChatNlqModeScopeLevels): ResolvedChatNlqMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeModeValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: "off",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: "off", invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set from the scoped carrier + env. */
export function levelsForChatNlq(
  scoped: ChatNlqScopedModes | undefined,
  envValue: unknown,
): ChatNlqModeScopeLevels {
  return { session: scoped?.session, user: scoped?.user, env: envValue };
}

/**
 * The turn resolution: the scoped carrier plus the env var out
 * of the context's env. The one call site is chatNlqTurnGate
 * (src/agents/orchestrator/meshMcpClient.ts), applied by
 * OrchestratorAgent.portBeforeTurn; before #2496 it was
 * createAgentMcpTools (src/agents/mcpAdapter.ts).
 */
export function resolveChatNlqTurnMode(context: {
  env?: unknown;
  scopedChatNlqModes?: ChatNlqScopedModes;
}): ResolvedChatNlqMode {
  const envValue =
    context.env && typeof context.env === "object"
      ? (context.env as Record<string, unknown>)[CHAT_NLQ_MODE_SWITCH]
      : undefined;
  return resolveChatNlqMode(levelsForChatNlq(context.scopedChatNlqModes, envValue));
}
