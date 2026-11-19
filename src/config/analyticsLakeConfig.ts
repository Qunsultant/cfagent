/**
 * Analytics lake configuration — externalized, no literals in code.
 *
 * The lake is an append-only ANALYTICS tier (Iceberg tables on R2 through a
 * Basin pipeline), never a transactional store: D1 and Durable Object SQLite
 * keep their jobs. `ANALYTICS_LAKE_MODE` decides whether anything is published
 * at all, and `off` is the default — the platform behaves exactly as before
 * until an operator turns it on.
 *
 * Fail-closed: `basin` without an endpoint and token resolves to `off` with a
 * named reason, so a half-configured deployment never silently drops events
 * into a void that looks like success.
 */
export const ANALYTICS_LAKE_MODE_SWITCH = "ANALYTICS_LAKE_MODE";
export const ANALYTICS_LAKE_ENDPOINT_SETTING = "ANALYTICS_LAKE_STREAM_ENDPOINT";
export const ANALYTICS_LAKE_TOKEN_SETTING = "ANALYTICS_LAKE_TOKEN";
export const ANALYTICS_LAKE_DATASETS_SETTING = "ANALYTICS_LAKE_DATASETS";
export const ANALYTICS_LAKE_TABLE_SETTING = "ANALYTICS_LAKE_TABLE";

export type AnalyticsLakeMode = "off" | "basin";

export interface AnalyticsLakeConfig {
  mode: AnalyticsLakeMode;
  /** Datasets whose artifacts are archived (default: the technicals dataset). */
  datasets: readonly string[];
  /** Iceberg table the pipeline writes (namespace.table). */
  table: string;
  endpoint?: string;
  token?: string;
  /** Present when a requested mode was refused (fail-closed). */
  reason?: string;
}

const DEFAULT_TABLE = "market_data.technicals_bars";
const DEFAULT_DATASETS = ["technicals"] as const;

function readString(env: unknown, key: string): string | undefined {
  const raw = (env as Record<string, unknown> | null | undefined)?.[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
}

function readMode(env: unknown): AnalyticsLakeMode {
  const raw = readString(env, ANALYTICS_LAKE_MODE_SWITCH)?.toLowerCase();
  return raw === "basin" ? "basin" : "off";
}

export function resolveAnalyticsLakeConfig(env: unknown): AnalyticsLakeConfig {
  const datasets = (readString(env, ANALYTICS_LAKE_DATASETS_SETTING) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const table =
    readString(env, ANALYTICS_LAKE_TABLE_SETTING) ?? DEFAULT_TABLE;
  const base = {
    datasets: datasets.length > 0 ? datasets : DEFAULT_DATASETS,
    table,
  };
  const mode = readMode(env);
  if (mode === "off") return { mode, ...base };

  const endpoint = readString(env, ANALYTICS_LAKE_ENDPOINT_SETTING);
  const token = readString(env, ANALYTICS_LAKE_TOKEN_SETTING);
  if (!endpoint || !token) {
    return {
      mode: "off",
      ...base,
      reason: `analytics_lake_not_configured: ${ANALYTICS_LAKE_ENDPOINT_SETTING} and ${ANALYTICS_LAKE_TOKEN_SETTING} are required for mode "basin"`,
    };
  }
  return { mode, ...base, endpoint, token };
}
