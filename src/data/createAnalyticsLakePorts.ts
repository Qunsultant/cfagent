/**
 * Composition root for the analytics-lake port — the ONLY place that maps
 * deployment configuration to an adapter (the createFeedDatasetPorts
 * pattern). Domain code imports this helper and the port types, never an
 * adapter.
 *
 * Off by default, and fail-closed: `basin` without its endpoint/token is the
 * inert adapter carrying the resolver's reason, never a silent no-op that
 * looks like success.
 */
import { resolveAnalyticsLakeConfig, type AnalyticsLakeConfig } from "../config/analyticsLakeConfig";
import { BasinLakeAdapter } from "./basinLakeAdapter";
import { InMemoryAnalyticsLakeAdapter } from "./inMemoryAnalyticsLakeAdapter";
import type { AnalyticsLakePort } from "./analyticsLakePorts";

export interface AnalyticsLakePorts {
  config: AnalyticsLakeConfig;
  lake: AnalyticsLakePort;
}

export function createAnalyticsLakePorts(env: unknown): AnalyticsLakePorts {
  const config = resolveAnalyticsLakeConfig(env);
  if (config.mode === "basin" && config.endpoint && config.token) {
    return {
      config,
      lake: new BasinLakeAdapter({ endpoint: config.endpoint, token: config.token }),
    };
  }
  return {
    config,
    lake: new InMemoryAnalyticsLakeAdapter({
      accept: false,
      reason: config.reason ?? "analytics_lake_off",
    }),
  };
}
