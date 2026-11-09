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

import {
  registerAgentConfigEntry,
  resolveAgentConfig,
  type AgentConfigResolution,
} from "../services/agentConfigResolver";
import type { CopilotRegistrationId } from "../services/copilotChannels";

/** The two states of the turn's NLQ tool. */
export type ChatNlqMode = "on" | "off";

/** The switch's Worker env var name. */
export const CHAT_NLQ_MODE_SWITCH = "CHAT_NLQ_MODE" as const;

/**
 * Issue #3741 — the switch's STORED layer (the tenant layer of
 * the one resolver): mas_settings keys, most granular first —
 * `chat_nlq_mode:<registration>`, then `chat_nlq_mode:<class>`,
 * then the bare tenant key. Written through the resolver's
 * write door; read at resolve time, so a stored flip is live
 * on the next turn.
 */
export const CHAT_NLQ_MODE_SETTING_KEY = "chat_nlq_mode" as const;

export function chatNlqModeSettingKey(scope: string): string {
  return `${CHAT_NLQ_MODE_SETTING_KEY}:${scope}`;
}

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
  /**
   * Which level won, or "builtin" when every level was blank.
   * (#3741: "stored" — the tenant stored layer — and "pin" —
   * an operator pin freezing the choice — join the original
   * levels; the original levels' meanings are unchanged.)
   */
  level: "run" | "session" | "user" | "stored" | "env" | "pin" | "builtin";
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
 * Issue #3741 — the chat/NLQ choice is an entry of the ONE
 * resolver (src/services/agentConfigResolver.ts), resolved per
 * agent class and per copilot registration. The layer chain
 * composes the #2488 chain with the resolver's stored layer:
 *
 *   run > session > user   — the run-granularity carriers
 *                            (this module's original levels,
 *                            semantics unchanged: first
 *                            non-blank wins, an invalid winner
 *                            fails closed, never falls through)
 *   > stored               — the tenant stored layer
 *                            (`chat_nlq_mode:<registration>`,
 *                            then `:<class>`, then the bare
 *                            key), most granular first
 *   > env                  — CHAT_NLQ_MODE, the deployment
 *                            default (an invalid value fails
 *                            closed, as before)
 *   > built-in "off"       — the code default.
 *
 * With no carriers and no stored layer in play — every
 * production context today — the chain reduces to exactly the
 * pre-#3741 resolution: env, then built-in off.
 */
registerAgentConfigEntry<ChatNlqMode>({
  id: "chatNlqMode",
  layers: ["carriers", "stored", "env"],
  carrierKeys: ["run", "session", "user"],
  parseCarrier: (raw) => {
    const normalized = normalizeModeValue(raw);
    if (normalized === null) return { kind: "absent" };
    if (normalized === "invalid") {
      return { kind: "invalid", raw: typeof raw === "string" ? raw : undefined };
    }
    return {
      kind: "decision",
      value: normalized,
      raw: typeof raw === "string" ? raw : undefined,
    };
  },
  carrierInvalid: "fail-closed",
  storedKeys: (identity) => {
    const keys: string[] = [];
    if (identity.registrationId) keys.push(chatNlqModeSettingKey(identity.registrationId));
    if (identity.className) keys.push(chatNlqModeSettingKey(identity.className));
    keys.push(CHAT_NLQ_MODE_SETTING_KEY);
    return [...new Set(keys)];
  },
  parseStored: (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return { parse: { kind: "absent" }, issues: [] };
    const normalized = normalizeModeValue(raw);
    if (normalized === null || normalized === "invalid") {
      return {
        parse: { kind: "absent" },
        issues: [
          `chat NLQ mode setting: malformed value "${raw.trim()}" (expected "on" or "off")`,
        ],
      };
    }
    return { parse: { kind: "decision", value: normalized }, issues: [] };
  },
  envVar: CHAT_NLQ_MODE_SWITCH,
  parseEnv: (raw) => {
    const normalized = normalizeModeValue(raw);
    if (normalized === null) return { parse: { kind: "absent" }, issues: [] };
    if (normalized === "invalid") {
      return {
        parse: { kind: "invalid", raw: typeof raw === "string" ? raw : undefined },
        issues: [],
      };
    }
    return {
      parse: {
        kind: "decision",
        value: normalized,
        raw: typeof raw === "string" ? raw : undefined,
      },
      issues: [],
    };
  },
  envInvalid: "fail-closed",
  failClosedValue: () => "off",
  codeDefault: () => "off",
  formatValue: (value) => value,
  parseWriteValue: (raw) => {
    const normalized = normalizeModeValue(raw);
    return normalized === "on" || normalized === "off" ? normalized : undefined;
  },
  valueDomain: '"on" or "off"',
  writeStoredKey: (identity) =>
    identity.registrationId
      ? chatNlqModeSettingKey(identity.registrationId)
      : identity.className
        ? chatNlqModeSettingKey(identity.className)
        : CHAT_NLQ_MODE_SETTING_KEY,
});

/** Map the one resolver's result onto this switch's public shape. */
function toResolvedChatNlqMode(resolved: AgentConfigResolution): ResolvedChatNlqMode {
  return {
    mode: resolved.value as ChatNlqMode,
    invalid: resolved.invalid ?? false,
    raw: resolved.raw,
    level: resolved.source === "default" ? "builtin" : resolved.source,
  };
}

/**
 * Resolves the switch in run > session > user > stored > env >
 * builtin order (#3741: the stored layer joins between the
 * carriers and the env). First non-blank carrier wins; an
 * invalid winner fails closed to "off" with invalid=true (no
 * fall-through to a lower level).
 */
export function resolveChatNlqMode(levels: ChatNlqModeScopeLevels): ResolvedChatNlqMode {
  return toResolvedChatNlqMode(
    resolveAgentConfig("chatNlqMode", {}, {
      carriers: { run: levels.run, session: levels.session, user: levels.user },
      env: { [CHAT_NLQ_MODE_SWITCH]: levels.env },
    }),
  );
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
 *
 * #3741: the context may also carry the turn's agent identity
 * (class + copilot registration) and the hosting instance's
 * settings reader — when it does, the choice resolves per
 * agent through the one resolver, stored layer included; when
 * it does not, the resolution is the pre-#3741 chain exactly.
 */
export function resolveChatNlqTurnMode(context: {
  env?: unknown;
  scopedChatNlqModes?: ChatNlqScopedModes;
  /** The turn's agent class (the per-class granularity scope). */
  className?: string;
  /** The turn's copilot registration, when the turn is a copilot turn. */
  registrationId?: CopilotRegistrationId;
  /** The hosting instance's settings reader (the stored layer). */
  readSettingRaw?: (key: string) => string | null;
}): ResolvedChatNlqMode {
  return toResolvedChatNlqMode(
    resolveAgentConfig(
      "chatNlqMode",
      { className: context.className, registrationId: context.registrationId },
      {
        carriers: {
          session: context.scopedChatNlqModes?.session,
          user: context.scopedChatNlqModes?.user,
        },
        env: (context.env ?? undefined) as Record<string, unknown> | undefined,
        readSettingRaw: context.readSettingRaw,
      },
    ),
  );
}
