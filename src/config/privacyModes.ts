/**
 * #1765 (parent #1717, F-41): the ONE privacy/DSAR mode switch,
 * PRIVACY_DSAR_MODE — "standard" | "strict", case-insensitive,
 * blank/unset -> "standard", unrecognized -> "standard"
 * FAIL-CLOSED with a privacy.config_error audit.
 *
 * Resolution order (program rule): run > session > user >
 * global env > built-in (standard). The FIRST non-blank level
 * wins; an unrecognized value at the winning level fails
 * closed and does NOT fall through to a lower level.
 * Callers must log + audit privacy.config_error on invalid.
 *
 * What the modes change (NEVER-EITHER/OR: both paths stay):
 *  - standard: today's behavior — ADMT decision paths run,
 *    retention uses the registry's stated bounds, export and
 *    erasure are available on request.
 *  - strict: the privacy-maximal variant — ADMT routes to the
 *    deterministic static path unless the subject explicitly
 *    opted in, and the export payload includes the full
 *    preference + notice record. No endpoint is removed and
 *    no enforcement gate is weakened in either mode.
 *
 * SECURITY GUARD: the mode is execution-owner-set only.
 * Carriers are populated by the execution-context owner,
 * never by the request caller: a request-supplied mode
 * (body/query) is ignored, because a subject flipping their
 * own execution to a weaker mode would be a caller disabling
 * their own enforcement. Session/user carriers are honored
 * only when populated by the execution-context owner. This
 * slice sets NO production value — unset = standard.
 *
 * Pure module: no Cloudflare imports, no I/O, no network.
 * Follows the paymentsFlowModes.ts (#1735) resolver shape.
 */

export type PrivacyDsarMode = "standard" | "strict";

export interface PrivacyDsarModeValues {
  mode?: unknown;
}

export interface PrivacyDsarScopedModes {
  session?: PrivacyDsarModeValues;
  user?: PrivacyDsarModeValues;
}

export interface PrivacyDsarModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedPrivacyDsarModeScoped {
  mode: PrivacyDsarMode;
  invalid: boolean;
  raw?: string;
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const PRIVACY_DSAR_MODE_SWITCH = "PRIVACY_DSAR_MODE" as const;

export function privacyDsarConfigErrorEvent(): string {
  return "privacy.config_error";
}

function normalizePrivacyModeValue(raw: unknown): PrivacyDsarMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "standard" || normalized === "strict") return normalized;
  return "invalid";
}

export function resolvePrivacyModeScoped(
  levels: PrivacyDsarModeScopeLevels,
): ResolvedPrivacyDsarModeScoped {
  const ordered: Array<{ level: ResolvedPrivacyDsarModeScoped["level"]; value: unknown }> = [
    { level: "run", value: levels.run },
    { level: "session", value: levels.session },
    { level: "user", value: levels.user },
    { level: "env", value: levels.env },
  ];
  for (const { level, value } of ordered) {
    const normalized = normalizePrivacyModeValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: "standard",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, level };
  }
  return { mode: "standard", invalid: false, level: "builtin" };
}
