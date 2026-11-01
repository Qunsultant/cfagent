/**
 * #1768 (parent #1717): ONE runtime config switch for the unified
 * API/MCP ingress layer — API_INGRESS_MODE ("legacy" | "unified").
 *
 * NEVER EITHER/OR, ALWAYS CONFIGURABLE: both paths stay in the code.
 * "legacy" is the current public-route behavior (uncapped WS upgrades,
 * per-consumer webhook header spellings); "unified" enables the WS
 * burst cap in src/api/ingress.ts. No endpoint is removed, no code
 * path is deleted, and no switch value widens access.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (surface legacy).
 * First non-blank level wins; an unrecognized winning value FAILS
 * CLOSED to the surface legacy, logged via console.warn, with NO
 * fall-through.
 *
 * SECURITY GUARD (mandatory): this switch is admin/platform-controlled
 * ONLY. The Worker wiring passes the env level alone — never a request
 * header, query parameter, or body field. A caller must never be able
 * to select "legacy" for their own request and dodge the burst cap:
 * the run/session/user levels exist for server-side callers that hold
 * verified context (the quote-mode pattern), not for request input.
 * The defect fixes in this slice (IP-keyed throttle buckets,
 * identity-header stripping on unauthenticated forwarders) are NOT
 * switched: they remove attacker-controlled input from trust
 * boundaries and do not change any legitimate outcome.
 *
 * Production value: an owner action. This slice never sets it.
 */

export type ApiIngressMode = "legacy" | "unified";

export const API_INGRESS_MODE_VALUES: readonly ApiIngressMode[] = ["legacy", "unified"];

export interface ApiIngressLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedApiIngressMode {
  mode: ApiIngressMode;
  invalid: boolean;
  raw?: string;
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeSwitchValue(raw: unknown): ApiIngressMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if ((API_INGRESS_MODE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as ApiIngressMode;
  }
  return "invalid";
}

/**
 * Builds the level set from server-side values + env. Callers MUST NOT
 * pass request-derived values here (see the SECURITY GUARD above);
 * src/server.ts passes env only.
 */
export function levelsForApiIngressMode(
  serverRun: unknown,
  serverSession: unknown,
  serverUser: unknown,
  envValue: unknown,
): ApiIngressLevels {
  return { run: serverRun, session: serverSession, user: serverUser, env: envValue };
}

export function resolveApiIngressMode(
  levels: ApiIngressLevels,
  legacy: ApiIngressMode = "legacy",
): ResolvedApiIngressMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      console.warn(
        `[api.config_error] API_INGRESS_MODE unrecognized value at ${level}; failing closed to surface legacy`,
      );
      return { mode: legacy, invalid: true, raw: typeof value === "string" ? value : undefined, level };
    }
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}
