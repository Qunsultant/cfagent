/**
 * Issue #2419 — externalized polling cadences (AOP).
 * Issue #2513 — auto-refresh interval options externalized here too
 * (previously a hardcoded pill list in BrokerDynamicMenu.tsx and a
 * standalone 15s constant in autoRefresh.ts).
 *
 * Every tunable in the polling migration resolves through here. The
 * server injects window.__POLLING_CONFIG__ at app boot from wrangler
 * vars, the landing page interpolates the same values at render time,
 * and anything without an injected value falls back to the defaults
 * below. No polling interval literal lives in component code: a
 * component reads getPollingConfig(), a test injects values through
 * resolvePollingConfig(), and the server maps env vars through
 * resolvePollingConfigFromEnv().
 *
 * This module is environment-free (no window access at import time),
 * so both the browser bundle and the Worker can import it.
 */

export interface PollingConfig {
  /** REST fallback cadence for the quotes feeds (landing + app). */
  quotesRestFallbackMs: number;
  /** Initial WebSocket reconnect delay for the quotes feeds. */
  quotesWsReconnectBaseMs: number;
  /** Cap for the exponential WebSocket reconnect backoff. */
  quotesWsReconnectCapMs: number;
  /** Options flows live-stream refresh cadence. */
  optionsFlowsPollMs: number;
  /** /api/options/latest refresh cadence (both consumers share it). */
  optionsLatestPollMs: number;
  /** Floor for the Chat global auto-refresh interval, in seconds. */
  chatAutoRefreshFloorS: number;
  /** Goal staged-run tracking poll cadence. */
  goalTrackPollMs: number;
  /**
   * Issue #4782 S3 — the screen-door parent's poll cadence: how
   * often the screen door checks whether the parent workflow
   * step finished (was `SCREEN_DOOR_PARENT_POLL_INTERVAL_MS`).
   */
  screenDoorParentPollMs: number;
  /**
   * Issue #4782 S3 — the NLQ chat-screen parent's poll cadence:
   * how often the chat screen checks whether the parent
   * workflow step finished (was `CHAT_SCREEN_PARENT_POLL_INTERVAL_MS`).
   */
  chatScreenParentPollMs: number;
  /** Goal staged-run tracking absolute deadline. */
  goalTrackDeadlineMs: number;
  /** Auto-refresh cadence pill options offered by the dynamic panel, in seconds. */
  autoRefreshIntervalOptionsS: number[];
  /** Default auto-refresh interval, in seconds, when no tenant value is stored. */
  autoRefreshDefaultS: number;
  /** Minimum auto-refresh interval the server accepts, in seconds. */
  autoRefreshMinS: number;
  /** Maximum auto-refresh interval the server accepts, in seconds. */
  autoRefreshMaxS: number;
}

export const POLLING_CONFIG_DEFAULTS: PollingConfig = {
  quotesRestFallbackMs: 60_000,
  quotesWsReconnectBaseMs: 1_000,
  quotesWsReconnectCapMs: 30_000,
  optionsFlowsPollMs: 30_000,
  optionsLatestPollMs: 60_000,
  chatAutoRefreshFloorS: 5,
  goalTrackPollMs: 2_000,
  screenDoorParentPollMs: 5_000,
  chatScreenParentPollMs: 5_000,
  goalTrackDeadlineMs: 600_000,
  autoRefreshIntervalOptionsS: [10, 15, 30, 60, 120, 300],
  autoRefreshDefaultS: 15,
  autoRefreshMinS: 10,
  autoRefreshMaxS: 300,
};

const ENV_KEYS: Record<
  Exclude<keyof PollingConfig, "autoRefreshIntervalOptionsS">,
  keyof PollingEnvVars
> = {
  quotesRestFallbackMs: "QUOTES_REST_FALLBACK_MS",
  quotesWsReconnectBaseMs: "QUOTES_WS_RECONNECT_BASE_MS",
  quotesWsReconnectCapMs: "QUOTES_WS_RECONNECT_CAP_MS",
  optionsFlowsPollMs: "OPTIONS_FLOWS_POLL_MS",
  optionsLatestPollMs: "OPTIONS_LATEST_POLL_MS",
  chatAutoRefreshFloorS: "CHAT_AUTO_REFRESH_FLOOR_S",
  goalTrackPollMs: "GOAL_TRACK_POLL_MS",
  screenDoorParentPollMs: "SCREEN_DOOR_PARENT_POLL_MS",
  chatScreenParentPollMs: "CHAT_SCREEN_PARENT_POLL_MS",
  goalTrackDeadlineMs: "GOAL_TRACK_DEADLINE_MS",
  autoRefreshDefaultS: "AUTO_REFRESH_DEFAULT_S",
  autoRefreshMinS: "AUTO_REFRESH_MIN_S",
  autoRefreshMaxS: "AUTO_REFRESH_MAX_S",
};

/** Wrangler vars (string values) that map onto the polling config. */
export interface PollingEnvVars {
  QUOTES_REST_FALLBACK_MS?: unknown;
  QUOTES_WS_RECONNECT_BASE_MS?: unknown;
  QUOTES_WS_RECONNECT_CAP_MS?: unknown;
  OPTIONS_FLOWS_POLL_MS?: unknown;
  OPTIONS_LATEST_POLL_MS?: unknown;
  CHAT_AUTO_REFRESH_FLOOR_S?: unknown;
  GOAL_TRACK_POLL_MS?: unknown;
  SCREEN_DOOR_PARENT_POLL_MS?: unknown;
  CHAT_SCREEN_PARENT_POLL_MS?: unknown;
  GOAL_TRACK_DEADLINE_MS?: unknown;
  /** Comma-separated seconds, e.g. "10,15,30,60,120,300". */
  AUTO_REFRESH_INTERVAL_OPTIONS_S?: unknown;
  AUTO_REFRESH_DEFAULT_S?: unknown;
  AUTO_REFRESH_MIN_S?: unknown;
  AUTO_REFRESH_MAX_S?: unknown;
}

function toPositiveNumber(value: unknown): number | null {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse an auto-refresh options value (comma-separated string or number array) into positive whole seconds, or null when unusable. */
function toPositiveSecondOptions(value: unknown): number[] | null {
  const parts =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : null;
  if (!parts) return null;
  const parsed = parts
    .map((part) => (typeof part === "string" ? Number(part.trim()) : part))
    .filter(
      (n): n is number =>
        typeof n === "number" && Number.isFinite(n) && n > 0 && Number.isInteger(n),
    );
  return parsed.length > 0 ? parsed : null;
}

/** Resolve a partial config object (injected values) over the defaults. */
export function resolvePollingConfig(raw?: Record<string, unknown> | null): PollingConfig {
  const out: PollingConfig = {
    ...POLLING_CONFIG_DEFAULTS,
    autoRefreshIntervalOptionsS: [...POLLING_CONFIG_DEFAULTS.autoRefreshIntervalOptionsS],
  };
  if (!raw) return out;
  (Object.keys(ENV_KEYS) as (keyof PollingConfig)[]).forEach((key) => {
    const value = toPositiveNumber(raw[key]);
    if (value !== null) (out as unknown as Record<string, unknown>)[key] = value;
  });
  const options = toPositiveSecondOptions(raw.autoRefreshIntervalOptionsS);
  if (options !== null) out.autoRefreshIntervalOptionsS = options;
  return out;
}

/** Map wrangler env vars (string values) onto the config keys. */
export function resolvePollingConfigFromEnv(
  env?: PollingEnvVars | null,
): PollingConfig {
  if (!env) {
    return {
      ...POLLING_CONFIG_DEFAULTS,
      autoRefreshIntervalOptionsS: [...POLLING_CONFIG_DEFAULTS.autoRefreshIntervalOptionsS],
    };
  }
  const raw: Record<string, unknown> = {};
  (
    Object.entries(ENV_KEYS) as [keyof PollingConfig, keyof PollingEnvVars][]
  ).forEach(([key, envKey]) => {
    raw[key] = env[envKey];
  });
  raw.autoRefreshIntervalOptionsS = env.AUTO_REFRESH_INTERVAL_OPTIONS_S;
  return resolvePollingConfig(raw);
}

declare global {
  interface Window {
    __POLLING_CONFIG__?: Partial<PollingConfig>;
  }
}

/** Clamp an auto-refresh interval (seconds) to the configured min/max. Used by the server POST handler so the UI's 300s cap is enforced, not just offered. */
export function clampAutoRefreshIntervalS(
  intervalS: number,
  config: Pick<PollingConfig, "autoRefreshMinS" | "autoRefreshMaxS"> = POLLING_CONFIG_DEFAULTS,
): number {
  return Math.min(config.autoRefreshMaxS, Math.max(config.autoRefreshMinS, Math.floor(intervalS)));
}

/** Read the server-injected boot config, or the defaults when absent. */
export function getPollingConfig(): PollingConfig {
  const injected = (globalThis as { window?: Window }).window?.__POLLING_CONFIG__;
  if (injected && typeof injected === "object") {
    return resolvePollingConfig(injected as Record<string, unknown>);
  }
  return {
    ...POLLING_CONFIG_DEFAULTS,
    autoRefreshIntervalOptionsS: [...POLLING_CONFIG_DEFAULTS.autoRefreshIntervalOptionsS],
  };
}
