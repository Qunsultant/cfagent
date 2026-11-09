/**
 * Issue #3888 — externalized trading limits: one configuration surface
 * for the money budget, the live-order ceiling, ladder rung caps, the
 * daily counters and the cancel-all cap.
 *
 * Why this module exists: the numbers that stop a runaway ladder used
 * to live as literals inside `src/services/bracketLadder.ts` and as
 * prose inside the copilot prompt. A user could not change them, and
 * the copilot could not cite them — it paraphrased whatever the prompt
 * said. Every engine now reads ONE snapshot produced here, and every
 * refusal carries the limit, its value, current usage and the requested
 * amount, so an answer about a limit is traceable to the configuration
 * that produced it (#3889).
 *
 * Resolution order (highest first), per key:
 *   1. per-ticker override — setting `trading:limits:<SYMBOL>` (JSON)
 *   2. per-scope setting    — setting `trading:limits` (JSON)
 *   3. deployment env       — `TRADING_LIMIT_<KEY_IN_SNAKE_CASE>`
 *   4. unset
 *
 * Unset is a REFUSAL, never "unlimited". An engine that cannot find a
 * limit refuses the operation with `limit_not_configured` and names the
 * setting and env var to set. An invalid value (negative, NaN, blank)
 * resolves as unset for the same reason: a typo must not read as "no
 * limit".
 *
 * The only value with a documented default is the session window, whose
 * default is the regular session (09:30–16:00 ET) — a bounded window,
 * not an absence of one. Provenance says `default` for it so a caller
 * can tell a configured window from the market's own hours.
 */

import type { Env } from "../types";

export type TradingLimitKey =
  | "maxNotionalPerTicker"
  | "maxOpenOrdersPerTicker"
  | "maxOpenOrdersTotal"
  | "maxRungsPerLadder"
  | "maxDailyOrders"
  | "maxDailyNotional"
  | "cancelMaxCount";

/** The vocabulary, in one place: schema, validator, route and tool read it. */
export const TRADING_LIMIT_KEYS: readonly TradingLimitKey[] = [
  "maxNotionalPerTicker",
  "maxOpenOrdersPerTicker",
  "maxOpenOrdersTotal",
  "maxRungsPerLadder",
  "maxDailyOrders",
  "maxDailyNotional",
  "cancelMaxCount",
];

/** Keys whose values are dollars; every other key is a count. */
export const TRADING_LIMIT_MONEY_KEYS: readonly TradingLimitKey[] = [
  "maxNotionalPerTicker",
  "maxDailyNotional",
];

export type TradingLimitSource = "ticker-override" | "setting" | "env" | "unset";

export interface TradingLimitField {
  key: TradingLimitKey;
  /** The effective value, or null when nothing configured it. */
  value: number | null;
  source: TradingLimitSource;
  /** Where the winning value was read from — a setting key or an env var. */
  readFrom: string | null;
}

export type TradingLimitRead = (key: string) => string | null;

export interface TradingSessionWindow {
  /** Minutes after midnight, ET. 570 = 09:30. */
  startMinuteEt: number;
  /** Minutes after midnight, ET. 960 = 16:00. */
  endMinuteEt: number;
  /** Whether rungs may be placed outside the window when the caller asks. */
  extendedHours: boolean;
  source: TradingLimitSource | "default";
  readFrom: string | null;
}

export interface TradingLimitsSnapshot {
  /** The ticker the snapshot was resolved for, when it was resolved for one. */
  symbol: string | null;
  limits: Record<TradingLimitKey, TradingLimitField>;
  sessionWindow: TradingSessionWindow;
  /** ISO instant of the read, so a caller can say how fresh its answer is. */
  readAt: string;
}

/** The global setting: a JSON object keyed by {@link TradingLimitKey}. */
export const TRADING_LIMITS_SETTING_KEY = "trading:limits";
/** The per-ticker override namespace: `trading:limits:<SYMBOL>`. */
export const TRADING_LIMITS_TICKER_SETTING_PREFIX = "trading:limits:";
/** The session window setting: JSON `{ startMinuteEt, endMinuteEt, extendedHours }`. */
export const TRADING_SESSION_WINDOW_SETTING_KEY = "trading:sessionWindow";
export const TRADING_LIMIT_ENV_PREFIX = "TRADING_LIMIT_";

const REGULAR_SESSION: TradingSessionWindow = {
  startMinuteEt: 9 * 60 + 30,
  endMinuteEt: 16 * 60,
  extendedHours: false,
  source: "default",
  readFrom: null,
};

/** `maxOpenOrdersPerTicker` → `TRADING_LIMIT_MAX_OPEN_ORDERS_PER_TICKER`. */
export function tradingLimitEnvVar(key: TradingLimitKey): string {
  return (
    TRADING_LIMIT_ENV_PREFIX +
    key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
  );
}

/** The per-ticker override setting key for a symbol. */
export function tradingLimitTickerSettingKey(symbol: string): string {
  return `${TRADING_LIMITS_TICKER_SETTING_PREFIX}${String(symbol).trim().toUpperCase()}`;
}

export function isTradingLimitKey(value: unknown): value is TradingLimitKey {
  return typeof value === "string" && (TRADING_LIMIT_KEYS as readonly string[]).includes(value);
}

/**
 * Parse one configured limit. Blank, non-numeric and negative values are
 * NOT limits: they resolve as unset so the operation refuses rather than
 * running unbounded. Zero is a real, deliberate limit ("none allowed").
 */
export function parseTradingLimitValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function readJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function envValue(env: Partial<Env> | undefined, key: TradingLimitKey): string | null {
  if (!env) return null;
  const raw = (env as Record<string, unknown>)[tradingLimitEnvVar(key)];
  return raw === undefined || raw === null ? null : String(raw);
}

function resolveSessionWindow(
  readSetting: TradingLimitRead | undefined,
  env: Partial<Env> | undefined,
): TradingSessionWindow {
  const stored = readJsonObject(
    typeof readSetting === "function" ? readSetting(TRADING_SESSION_WINDOW_SETTING_KEY) : null,
  );
  const startEnv = env?.TRADING_SESSION_START;
  const endEnv = env?.TRADING_SESSION_END;
  const extendedEnv = env?.TRADING_SESSION_EXTENDED_HOURS;

  const start =
    parseClockMinute(stored?.startMinuteEt ?? stored?.start ?? startEnv) ?? REGULAR_SESSION.startMinuteEt;
  const end =
    parseClockMinute(stored?.endMinuteEt ?? stored?.end ?? endEnv) ?? REGULAR_SESSION.endMinuteEt;
  const extended =
    parseBoolean(stored?.extendedHours ?? extendedEnv) ?? REGULAR_SESSION.extendedHours;

  const configured = Boolean(stored) || startEnv !== undefined || endEnv !== undefined || extendedEnv !== undefined;
  return {
    startMinuteEt: start,
    endMinuteEt: end,
    extendedHours: extended,
    source: configured ? (stored ? "setting" : "env") : "default",
    readFrom: configured ? (stored ? TRADING_SESSION_WINDOW_SETTING_KEY : "TRADING_SESSION_START/END") : null,
  };
}

/** Accepts 570, "570", "09:30" or "9:30" and resolves to minutes after midnight ET. */
export function parseClockMinute(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) return null;
  return value;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

/**
 * Resolve the effective snapshot. Pure apart from the injected reader, so
 * every surface — route, tool, engine, copilot — resolves identically.
 */
export function resolveTradingLimits(input: {
  symbol?: string | null;
  env?: Partial<Env>;
  readSetting?: TradingLimitRead;
}): TradingLimitsSnapshot {
  const symbol = input.symbol ? String(input.symbol).trim().toUpperCase() : null;
  const tickerKey = symbol ? tradingLimitTickerSettingKey(symbol) : null;
  const tickerOverrides = tickerKey ? readJsonObject(input.readSetting?.(tickerKey)) : null;
  const scoped = readJsonObject(input.readSetting?.(TRADING_LIMITS_SETTING_KEY));

  const limits = {} as Record<TradingLimitKey, TradingLimitField>;
  for (const key of TRADING_LIMIT_KEYS) {
    const fromTicker = parseTradingLimitValue(tickerOverrides?.[key]);
    if (fromTicker !== null) {
      limits[key] = { key, value: fromTicker, source: "ticker-override", readFrom: tickerKey };
      continue;
    }
    const fromSetting = parseTradingLimitValue(scoped?.[key]);
    if (fromSetting !== null) {
      limits[key] = { key, value: fromSetting, source: "setting", readFrom: TRADING_LIMITS_SETTING_KEY };
      continue;
    }
    const fromEnv = parseTradingLimitValue(envValue(input.env, key));
    if (fromEnv !== null) {
      limits[key] = { key, value: fromEnv, source: "env", readFrom: tradingLimitEnvVar(key) };
      continue;
    }
    limits[key] = { key, value: null, source: "unset", readFrom: null };
  }

  return {
    symbol,
    limits,
    sessionWindow: resolveSessionWindow(input.readSetting, input.env),
    readAt: new Date().toISOString(),
  };
}

export type TradingLimitRefusalCode = "limit_exceeded" | "limit_not_configured";

/**
 * One validator verdict. `allowed: true` carries nothing else; a refusal
 * carries the limit, its configured value, the usage the caller reported
 * and the amount requested, so the refusal is explainable rather than a
 * sentence someone has to trust.
 */
export interface TradingLimitVerdict {
  allowed: boolean;
  code?: TradingLimitRefusalCode;
  limit?: TradingLimitKey;
  limitValue?: number | null;
  used?: number | null;
  requested?: number;
  message?: string;
}

export interface TradingLimitRequest {
  key: TradingLimitKey;
  /** The amount this operation wants (orders, rungs, dollars). */
  requested: number;
  /** What is already consumed in the same scope. Omitted means 0. */
  used?: number | null;
}

/** Evaluate one requirement against the snapshot. */
export function evaluateTradingLimit(
  snapshot: TradingLimitsSnapshot,
  request: TradingLimitRequest,
): TradingLimitVerdict {
  const field = snapshot.limits[request.key];
  const requested = Number(request.requested);
  if (!Number.isFinite(requested) || requested < 0) {
    return {
      allowed: false,
      code: "limit_not_configured",
      limit: request.key,
      limitValue: field?.value ?? null,
      used: request.used ?? null,
      requested,
      message: `${request.key} cannot be evaluated: the requested amount (${request.requested}) is not a usable number.`,
    };
  }

  if (!field || field.value === null) {
    return {
      allowed: false,
      code: "limit_not_configured",
      limit: request.key,
      limitValue: null,
      used: request.used ?? null,
      requested,
      message:
        `${request.key} is not configured, so the operation was refused rather than run unbounded. ` +
        `Set it in ${TRADING_LIMITS_SETTING_KEY} (or ${tradingLimitEnvVar(request.key)}` +
        `${snapshot.symbol ? `, or ${tradingLimitTickerSettingKey(snapshot.symbol)} for ${snapshot.symbol}` : ""}).`,
    };
  }

  const used = Number.isFinite(Number(request.used)) ? Number(request.used) : 0;
  if (used + requested > field.value) {
    return {
      allowed: false,
      code: "limit_exceeded",
      limit: request.key,
      limitValue: field.value,
      used,
      requested,
      message:
        `${request.key} is ${formatTradingLimitAmount(request.key, field.value)}; ` +
        `${formatTradingLimitAmount(request.key, used)} is already used and this request needs ` +
        `${formatTradingLimitAmount(request.key, requested)} more. ` +
        `Source: ${field.source}${field.readFrom ? ` (${field.readFrom})` : ""}.`,
    };
  }

  return { allowed: true };
}

/** Evaluate a batch; the first refusal wins (the caller reports one reason at a time). */
export function evaluateTradingLimits(
  snapshot: TradingLimitsSnapshot,
  requests: readonly TradingLimitRequest[],
): TradingLimitVerdict {
  for (const request of requests) {
    const verdict = evaluateTradingLimit(snapshot, request);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

export function isTradingLimitMoneyKey(key: TradingLimitKey): boolean {
  return TRADING_LIMIT_MONEY_KEYS.includes(key);
}

/** `$5,000` for money keys, `6` for counts. */
export function formatTradingLimitAmount(key: TradingLimitKey, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "not configured";
  const numeric = Number(value);
  if (!isTradingLimitMoneyKey(key)) return String(numeric);
  return `$${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * The one-line refusal shape a caller quotes back to a user, e.g.
 * `budget_exhausted (maxNotionalPerTicker @ $5,000; used $4,980; requested $1,200)`.
 * #3889 depends on this exact shape, so it lives with the validator.
 */
export function describeTradingLimitRefusal(
  verdict: TradingLimitVerdict,
  refusalCode?: string,
): string {
  const code = refusalCode ?? verdict.code ?? "limit_exceeded";
  if (!verdict.limit) return code;
  const limit = verdict.limit;
  const value =
    verdict.limitValue === null || verdict.limitValue === undefined
      ? "not configured"
      : formatTradingLimitAmount(limit, verdict.limitValue);
  const used =
    verdict.used === null || verdict.used === undefined
      ? "unknown"
      : formatTradingLimitAmount(limit, verdict.used);
  const requested =
    verdict.requested === undefined || !Number.isFinite(Number(verdict.requested))
      ? "unknown"
      : formatTradingLimitAmount(limit, verdict.requested);
  if (verdict.code === "limit_not_configured") {
    return `${code} (${limit} unset; requested ${requested})`;
  }
  return `${code} (${limit} @ ${value}; used ${used}; requested ${requested})`;
}

export interface TradingLimitChange {
  key: TradingLimitKey;
  symbol: string | null;
  before: number | null;
  after: number | null;
  settingKey: string;
  changedAt: string;
}

export type TradingLimitChangeResult =
  | { ok: true; change: TradingLimitChange }
  | { ok: false; code: "unknown_limit_key" | "invalid_limit_value" | "limit_write_unavailable"; message: string };

/**
 * Apply one change to the persisted configuration. The caller audits the
 * returned change (who/what/when is the caller's context, not this
 * module's): `{ before, after }` is the record's payload.
 */
export function applyTradingLimitChange(input: {
  key: unknown;
  value: unknown;
  symbol?: string | null;
  readSetting?: TradingLimitRead;
  writeSetting?: (key: string, value: string) => void;
}): TradingLimitChangeResult {
  if (!isTradingLimitKey(input.key)) {
    return {
      ok: false,
      code: "unknown_limit_key",
      message: `Unknown trading limit '${String(input.key)}'. Accepted: ${TRADING_LIMIT_KEYS.join(", ")}.`,
    };
  }
  if (typeof input.writeSetting !== "function") {
    return {
      ok: false,
      code: "limit_write_unavailable",
      message: "Trading limit changes need the settings writer; this surface has none, so nothing changed.",
    };
  }

  const key = input.key;
  const symbol = input.symbol ? String(input.symbol).trim().toUpperCase() : null;
  const settingKey = symbol ? tradingLimitTickerSettingKey(symbol) : TRADING_LIMITS_SETTING_KEY;

  let after: number | null;
  if (input.value === null || input.value === undefined || input.value === "") {
    after = null;
  } else {
    after = parseTradingLimitValue(input.value);
    if (after === null) {
      return {
        ok: false,
        code: "invalid_limit_value",
        message: `'${String(input.value)}' is not a usable trading limit: it must be a number greater than or equal to 0. Nothing changed.`,
      };
    }
  }

  const container = readJsonObject(input.readSetting?.(settingKey)) ?? {};
  const before = parseTradingLimitValue(container[key]);
  if (after === null) {
    delete container[key];
  } else {
    container[key] = after;
  }
  input.writeSetting(settingKey, JSON.stringify(container));

  return {
    ok: true,
    change: { key, symbol, before, after, settingKey, changedAt: new Date().toISOString() },
  };
}
