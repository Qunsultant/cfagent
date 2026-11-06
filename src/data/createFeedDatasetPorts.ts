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
  D1FeedDatasetStore,
  type FeedDatasetD1Db,
} from "./d1FeedDatasetAdapter";
import type { FeedDatasetStore } from "./feedDatasetPorts";

/** Build the feed-dataset adapter from Worker env, or null if unbound. */
export function createFeedDatasetAdapter(env: {
  AGENT_DB?: unknown;
}): D1FeedDatasetStore | null {
  if (!env.AGENT_DB) return null;
  return new D1FeedDatasetStore(env.AGENT_DB as FeedDatasetD1Db);
}

export type { FeedDatasetStore };
