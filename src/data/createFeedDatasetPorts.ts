/**
 * Issue #3530 (S1) — composition root for the feed-dataset port.
 * This is the ONLY module that maps a Worker binding to the
 * port's production implementation: domain code imports this
 * helper and the port types, never a store client (the
 * createProviderCapturePorts pattern).
 *
 * Absence of the binding is a normal, non-error state:
 * createFeedDatasetAdapter returns null and callers report the
 * feed surface as not configured instead of inventing a store.
 * AGENT_DB is bound in production (wrangler.jsonc) — the same
 * binding the capture log and the index lists live on.
 */
import {
  createD1FeedDatasetDb,
  D1FeedDatasetStore,
} from "./d1FeedDatasetAdapter";
import type { FeedDatasetStore } from "./feedDatasetPorts";
import { createAnalyticsLakePorts } from "./createAnalyticsLakePorts";
import { withLakeArchive } from "../aspects/analyticsLakeAspect";

/**
 * Build the feed-dataset adapter from Worker env, or null if unbound.
 *
 * Analytics lake (Basin/Iceberg): when `ANALYTICS_LAKE_MODE=basin` is
 * configured, the store is wrapped by the archiving aspect
 * (`withLakeArchive`) here — one composition point, no call-site changes,
 * and the domain never learns the lake exists. Off by default: the
 * returned store is the plain adapter, byte-identical to before.
 */
export function createFeedDatasetAdapter(env: {
  AGENT_DB?: unknown;
}): FeedDatasetStore | null {
  if (!env.AGENT_DB) return null;
  const store = new D1FeedDatasetStore(createD1FeedDatasetDb(env.AGENT_DB as D1Database));
  const { config, lake } = createAnalyticsLakePorts(env);
  if (config.mode !== "basin") return store;
  return withLakeArchive(store, lake, {
    datasets: config.datasets,
    table: config.table,
  });
}

export type { FeedDatasetStore };
