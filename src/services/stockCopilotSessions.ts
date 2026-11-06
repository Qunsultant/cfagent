/**
 * Issue #3398 — the Stock Copilot's trading sessions: the session
 * model and its externalized, user-decided configuration.
 *
 * Owner directive (2026-11-06, amended onto #3398 and sharpened the
 * same morning): 24-hour trading is a MUST, sessions are
 * EXTERNALIZED like every other copilot setting, and what happens
 * in each session is the USER's decision — the system does not
 * unilaterally decide. The four sessions:
 *
 *   pre_market   04:00–09:30 ET, Mon–Fri
 *   regular      09:30–16:00 ET, Mon–Fri
 *   after_hours  16:00–20:00 ET, Mon–Fri
 *   exto         20:00–04:00 ET, Sunday–Thursday nights (Alpaca's
 *                overnight session: it opens Sunday 20:00 and the
 *                last session of the week ends Friday 04:00 — there
 *                is no Friday-night or weekend session)
 *
 * Which sessions the cycle may trade in is a per-user setting read
 * with the platform's AOP idiom (the #2482 settings discipline):
 * the login's stored setting (mas_settings key
 * `stock_copilot:sessions`) wins; the deployment env
 * (STOCK_COPILOT_SESSIONS) is the default when the user has stored
 * nothing; with neither, the enabled set is REGULAR ONLY — today's
 * behavior, unchanged until the user chooses otherwise. An explicit
 * stored "none" is a decision (no sessions), never a parse failure.
 *
 * Session order policy (deterministic, one home): the regular
 * session takes market orders exactly as the copilot always has;
 * every other session is LIMIT-ONLY (the extended-hours and
 * overnight venue rule), priced at the cycle's own reference price,
 * and requires the platform to carry session terms on the wire —
 * a platform that cannot is refused by name
 * (stock_copilot_session_wire_unsupported) rather than sent a
 * regular-session order in disguise.
 *
 * Approximation honesty, same as the legacy regular-hours gate: no
 * exchange holiday calendar is consulted (none exists in the
 * platform); on a holiday the venue simply leaves orders unfilled
 * and the cycle's tracked state stays consistent because positions
 * are recorded only on accepted submissions.
 */

import { round2 } from "./cvarOptimizer";

/** The four trading sessions, in canonical (display + storage) order. */
export const COPILOT_SESSIONS = [
  "pre_market",
  "regular",
  "after_hours",
  "exto",
] as const;

export type CopilotSessionId = (typeof COPILOT_SESSIONS)[number];

/** The truthful default: regular hours only, matching the copilot's
 *  behavior before sessions were externalized. */
export const DEFAULT_COPILOT_SESSIONS: readonly CopilotSessionId[] = ["regular"];

/** The per-login settings key (the #2482 mas_settings store). */
export const COPILOT_SESSION_SETTING_KEY = "stock_copilot:sessions";

/** Named state when the cycle fires outside the user's enabled
 *  sessions: a visible state on the copilot surfaces, not a skip. */
export const STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS =
  "stock_copilot_outside_enabled_sessions";

/** Named refusal when an order belongs to a session whose terms the
 *  trading platform cannot yet carry on the wire (extended-hours /
 *  overnight eligibility): the order is refused, never silently
 *  re-shaped into a regular-session order. */
export const STOCK_COPILOT_SESSION_WIRE_UNSUPPORTED =
  "stock_copilot_session_wire_unsupported";

export function isCopilotSessionId(value: unknown): value is CopilotSessionId {
  return (
    typeof value === "string" &&
    (COPILOT_SESSIONS as readonly string[]).includes(value)
  );
}

/**
 * Parse a stored/env session list (comma-separated, case-insensitive).
 * Returns the enabled set in canonical order, or null when the raw
 * value carries no usable decision (absent, empty, or all-unknown) —
 * the caller then falls through to the next source. The exact token
 * "none" parses to the empty set: an explicit user decision that no
 * session is enabled, distinct from "no decision recorded".
 */
export function parseCopilotSessionList(
  raw: string | null | undefined,
): CopilotSessionId[] | null {
  if (typeof raw !== "string") return null;
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0] === "none") return [];
  const found = new Set<CopilotSessionId>();
  for (const token of tokens) {
    if (isCopilotSessionId(token)) found.add(token);
  }
  if (found.size === 0) return null;
  return COPILOT_SESSIONS.filter((s) => found.has(s));
}

/** Serialize an enabled set for the settings store (canonical order;
 *  the empty set is the explicit "none" decision). */
export function serializeCopilotSessionList(
  sessions: readonly CopilotSessionId[],
): string {
  if (sessions.length === 0) return "none";
  const found = new Set(sessions);
  return COPILOT_SESSIONS.filter((s) => found.has(s)).join(",");
}

export interface CopilotSessionReaders {
  /** The instance's settings reader (the #2482 store). */
  readSettingRaw?: ((key: string) => string | null) | undefined;
  /** Deployment env carrying the optional STOCK_COPILOT_SESSIONS default. */
  env?: { STOCK_COPILOT_SESSIONS?: string } | null;
}

/**
 * Resolve the user's enabled sessions: stored per-login setting
 * first, deployment env second, regular-only default last. This
 * function adds no store of its own — it reads the stores that
 * already exist, exactly as the mode selection does (#3451).
 */
export function resolveCopilotSessions(
  readers: CopilotSessionReaders,
): CopilotSessionId[] {
  const stored =
    typeof readers.readSettingRaw === "function"
      ? parseCopilotSessionList(readers.readSettingRaw(COPILOT_SESSION_SETTING_KEY))
      : null;
  if (stored !== null) return stored;
  const fromEnv = parseCopilotSessionList(readers.env?.STOCK_COPILOT_SESSIONS);
  if (fromEnv !== null) return fromEnv;
  return [...DEFAULT_COPILOT_SESSIONS];
}

/** Weekday + minutes-into-day in America/New_York (the Intl-parts
 *  discipline of the legacy regular-hours gate). */
function etWeekdayMinutes(now: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

const PRE_MARKET_START = 4 * 60;
const REGULAR_START = 9 * 60 + 30;
const AFTER_HOURS_START = 16 * 60;
const OVERNIGHT_START = 20 * 60;

/**
 * The session a moment falls in, or null when no session is open
 * (weekend daytime, Friday night, Sunday before 20:00). The
 * overnight session spans midnight: its evening half belongs to
 * Sunday–Thursday, its morning half (00:00–04:00) to the session
 * that opened the previous evening, so early hours count Monday–
 * Friday and never Saturday.
 */
export function copilotSessionAt(now: Date): CopilotSessionId | null {
  const { weekday, minutes } = etWeekdayMinutes(now);
  const weekdaySessionDay =
    weekday === "Mon" ||
    weekday === "Tue" ||
    weekday === "Wed" ||
    weekday === "Thu" ||
    weekday === "Fri";
  if (minutes >= OVERNIGHT_START) {
    // Evening half of the overnight session: Sun–Thu nights only.
    return weekday === "Sun" || (weekdaySessionDay && weekday !== "Fri")
      ? "exto"
      : null;
  }
  if (minutes < PRE_MARKET_START) {
    // Morning tail of last night's overnight session (opened
    // Sun–Thu evening ⇒ tail lands Mon–Fri morning).
    return weekdaySessionDay ? "exto" : null;
  }
  if (!weekdaySessionDay) return null;
  if (minutes < REGULAR_START) return "pre_market";
  if (minutes < AFTER_HOURS_START) return "regular";
  return "after_hours";
}

/** The order shape a session accepts. `requiresSessionTerms` marks
 *  the shapes that only reach the venue correctly when the order
 *  carries extended-hours / overnight terms on the wire. */
export type CopilotSessionOrderShape =
  | { orderType: "MARKET"; requiresSessionTerms: false }
  | { orderType: "LIMIT"; limitPrice: number; requiresSessionTerms: true };

/**
 * Shape an order for its session at the cycle's reference price
 * (the latest close the decision was made on — the same price the
 * entry sizing and exit plan already use). Regular hours keep the
 * copilot's market orders; every other session is limit-only.
 */
export function shapeCopilotSessionOrder(
  session: CopilotSessionId,
  referencePrice: number,
): CopilotSessionOrderShape {
  if (session === "regular") {
    return { orderType: "MARKET", requiresSessionTerms: false };
  }
  return {
    orderType: "LIMIT",
    limitPrice: round2(referencePrice),
    requiresSessionTerms: true,
  };
}
