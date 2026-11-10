/**
 * Issue #2530 — ONE runtime config switch for the screener
 * workflow's non-deterministic mode, in the CHAT_NLQ_MODE
 * (#2488) / NLQ_MODE (#1722) pattern.
 *
 * Owner direction (2026-10-31): screener workflows exist as
 * BOTH deterministic and non-deterministic. The settled §8
 * doctrine confines non-determinism to a closed list and
 * rules that prompt output crosses into execution only as a
 * validated proposal — so the non-deterministic mode is an
 * interpretation step at the head of the parent workflow run
 * (design option (a), recorded on #2530): a prompt proposes
 * screen criteria as a DATA artifact, a deterministic
 * validator gates it, and the existing deterministic
 * pipeline executes it. Execution and replay stay
 * deterministic in both modes.
 *
 * Switch (Worker env var, non-secret, owner-set; this slice
 * sets NO production value — the built-in default IS the
 * shipped state):
 *   SCREENER_ND_MODE
 * Values: "on" | "off" (case-insensitive, surrounding
 * whitespace ignored). Built-in default: "off" — no seam may
 * start a non-deterministic screen run, and a workflow
 * command carrying the mode is refused at the workflow
 * boundary.
 *
 * What the switch governs (the AVAILABILITY of the ND mode,
 * never a run's mode by itself — a run's mode is the explicit
 * per-command `screenMode` selection, validated by
 * assertWorkflowJobCommand):
 * - "off": seams refuse ND requests before any start;
 *   tryStartScreenerWorkflow throws for an ND command instead
 *   of taking its null-fallback (no silent downgrade to a
 *   synchronous deterministic screen); the parent flow
 *   refuses an ND command whose deps report the gate closed.
 * - "on": ND runs are admissible; each still requires an
 *   explicit screenMode + screenIntent on its command, a
 *   journaled interpretation step, deterministic validation,
 *   and the mas_events audit record before any shard runs.
 *
 * Fail-closed: an unrecognized value resolves to "off" with
 * invalid=true — it never enables the mode. Callers must log
 * + audit `screener_nd.config_error` on invalid.
 *
 * The production flag flip (setting SCREENER_ND_MODE=on) is
 * an owner action gated on CISO review of the
 * prompt-injection surface (#2530 acceptance item 4); it is
 * NOT part of the slice that introduces this switch.
 */

import {
  registerAgentConfigEntry,
  resolveAgentConfig,
  type AgentConfigResolution,
} from "../services/agentConfigResolver";

/** The switch's Worker env var name. */
export const SCREENER_ND_MODE_SWITCH = "SCREENER_ND_MODE" as const;

/**
 * The agent class the ND gate governs (the screener workflow's
 * owning class) — the class scope the one resolver keys this
 * choice by (#3741).
 */
export const SCREENER_ND_AGENT_CLASS = "ScreenerAgent" as const;

/**
 * Issue #3741 — the gate's STORED layer (the tenant layer of
 * the one resolver): mas_settings keys, most granular first —
 * `screener_nd_mode:<class>`, then the bare tenant key. Hosts
 * that supply a settings reader resolve through it; the
 * env-only hosts (the workflow seams) are unchanged.
 */
export const SCREENER_ND_MODE_SETTING_KEY = "screener_nd_mode" as const;

export function screenerNdModeSettingKey(className: string): string {
  return `${SCREENER_ND_MODE_SETTING_KEY}:${className}`;
}

/** The gate's two states, as the one resolver's value domain. */
export type ScreenerNdMode = "on" | "off";

function normalizeScreenerNdValue(raw: unknown): ScreenerNdMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "on") return "on";
  if (normalized === "off") return "off";
  return "invalid";
}

/**
 * Issue #3741 — the screener mode choice is an entry of the
 * ONE resolver (src/services/agentConfigResolver.ts), resolved
 * per agent class: stored (`screener_nd_mode:<class>`, then
 * the bare key) > env (SCREENER_ND_MODE, the deployment
 * default) > built-in "off". The env layer keeps this switch's
 * fail-closed posture exactly: an unrecognized value resolves
 * to "off" with invalid=true — it never enables the mode. The
 * per-run selection (the command's explicit screenMode) and
 * the replay rules are not this gate's and are untouched.
 */
registerAgentConfigEntry<ScreenerNdMode>({
  id: "screenerNdMode",
  layers: ["stored", "env"],
  storedKeys: (identity) => {
    const keys: string[] = [];
    if (identity.className) keys.push(screenerNdModeSettingKey(identity.className));
    keys.push(SCREENER_ND_MODE_SETTING_KEY);
    return [...new Set(keys)];
  },
  parseStored: (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return { parse: { kind: "absent" }, issues: [] };
    const normalized = normalizeScreenerNdValue(raw);
    if (normalized === null || normalized === "invalid") {
      return {
        parse: { kind: "absent" },
        issues: [
          `screener ND mode setting: malformed value "${raw.trim()}" (expected "on" or "off")`,
        ],
      };
    }
    return { parse: { kind: "decision", value: normalized }, issues: [] };
  },
  envVar: SCREENER_ND_MODE_SWITCH,
  parseEnv: (raw) => {
    const normalized = normalizeScreenerNdValue(raw);
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
    const normalized = normalizeScreenerNdValue(raw);
    return normalized === "on" || normalized === "off" ? normalized : undefined;
  },
  valueDomain: '"on" or "off"',
  writeStoredKey: (identity) =>
    identity.className
      ? screenerNdModeSettingKey(identity.className)
      : SCREENER_ND_MODE_SETTING_KEY,
});

/** Audit event emitted when a switch value fails closed. */
export function screenerNdConfigErrorEvent(): string {
  return "screener_nd.config_error";
}

export interface ResolvedScreenerNdGate {
  /** True only when the env value explicitly enables the ND mode. */
  enabled: boolean;
  /** True only when a non-blank value was unrecognized (failed closed). */
  invalid: boolean;
  /** The raw env value, when it was a string (preserved for audit). */
  raw?: string;
}

/** Map the one resolver's result onto this gate's public shape. */
function toResolvedScreenerNdGate(resolved: AgentConfigResolution): ResolvedScreenerNdGate {
  return {
    enabled: resolved.value === "on",
    invalid: resolved.invalid ?? false,
    raw: resolved.raw,
  };
}

/**
 * Resolves the gate from one env value. Blank/unset → off
 * (the built-in default); "on" → enabled; "off" → off; any
 * other non-blank value → off with invalid=true.
 * (#3741: delegated to the one resolver — the `screenerNdMode`
 * entry above, env layer only; this shape is unchanged.)
 */
export function resolveScreenerNdGate(envValue: unknown): ResolvedScreenerNdGate {
  return toResolvedScreenerNdGate(
    resolveAgentConfig(
      "screenerNdMode",
      { className: SCREENER_ND_AGENT_CLASS },
      { env: { [SCREENER_ND_MODE_SWITCH]: envValue } },
    ),
  );
}

/** Resolves the gate from an env object (the Worker env, or any record carrying the var). */
export function resolveScreenerNdGateFromEnv(env: unknown): ResolvedScreenerNdGate {
  const value =
    env && typeof env === "object"
      ? (env as Record<string, unknown>)[SCREENER_ND_MODE_SWITCH]
      : undefined;
  return resolveScreenerNdGate(value);
}

/**
 * Issue #3741 — the gate's FULL resolution through the one
 * resolver, for hosts that can supply the stored layer (a
 * settings reader) and want the named source: stored > env >
 * built-in off, per agent class. The env-only seams keep using
 * resolveScreenerNdGateFromEnv, whose behavior is unchanged.
 */
export function resolveScreenerNdGateResolved(deps: {
  env?: unknown;
  readSettingRaw?: (key: string) => string | null;
  className?: string;
}): AgentConfigResolution {
  return resolveAgentConfig(
    "screenerNdMode",
    { className: deps.className ?? SCREENER_ND_AGENT_CLASS },
    {
      env: (deps.env ?? undefined) as Record<string, unknown> | undefined,
      readSettingRaw: deps.readSettingRaw,
    },
  );
}

/** The gate's public shape plus the one resolver's named source. */
export interface ResolvedScreenerNdGateForHost extends ResolvedScreenerNdGate {
  /** The layer that decided: "stored" | "env" | "default" | "pin". */
  source: AgentConfigResolution["source"];
}

/**
 * Issue #3922 — the gate resolution for a production host: the
 * full layered entry when the host supplies a settings reader
 * (stored > env > built-in off, source named), and exactly the
 * env-only resolution when it does not — the resolver skips the
 * stored layer without a reader, so a reader that finds no
 * stored value resolves byte-identically to
 * resolveScreenerNdGateFromEnv. Hosts wire their per-login
 * reader through this one helper so every seam reads the gate
 * the same way.
 */
export function resolveScreenerNdGateForHost(deps: {
  env?: unknown;
  readSettingRaw?: (key: string) => string | null;
  className?: string;
}): ResolvedScreenerNdGateForHost {
  const resolved = resolveScreenerNdGateResolved(deps);
  return { ...toResolvedScreenerNdGate(resolved), source: resolved.source };
}
