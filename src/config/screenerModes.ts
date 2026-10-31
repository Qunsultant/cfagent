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

/** The switch's Worker env var name. */
export const SCREENER_ND_MODE_SWITCH = "SCREENER_ND_MODE" as const;

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

/**
 * Resolves the gate from one env value. Blank/unset → off
 * (the built-in default); "on" → enabled; "off" → off; any
 * other non-blank value → off with invalid=true.
 */
export function resolveScreenerNdGate(envValue: unknown): ResolvedScreenerNdGate {
  if (envValue === undefined || envValue === null) {
    return { enabled: false, invalid: false, raw: undefined };
  }
  if (typeof envValue !== "string") {
    return { enabled: false, invalid: true, raw: undefined };
  }
  const normalized = envValue.trim().toLowerCase();
  if (!normalized) return { enabled: false, invalid: false, raw: undefined };
  if (normalized === "on") return { enabled: true, invalid: false, raw: envValue };
  if (normalized === "off") return { enabled: false, invalid: false, raw: envValue };
  return { enabled: false, invalid: true, raw: envValue };
}

/** Resolves the gate from an env object (the Worker env, or any record carrying the var). */
export function resolveScreenerNdGateFromEnv(env: unknown): ResolvedScreenerNdGate {
  const value =
    env && typeof env === "object"
      ? (env as Record<string, unknown>)[SCREENER_ND_MODE_SWITCH]
      : undefined;
  return resolveScreenerNdGate(value);
}
