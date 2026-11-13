/**
 * Issue #3246 (sub-issue of #3241), slice 3 — composition root for
 * the runs-pack ports. This is the ONLY module that maps a Worker
 * binding to a runs-pack implementation: domain code imports this
 * helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createRunsPackAdapters` returns null and callers keep their fail
 * direction — fail-closed on money paths, empty packs on the offer
 * surface. A present-but-unreadable store fails at the call site,
 * where the caller decides the direction.
 */
import {
  createD1RunsPackDb,
  D1RunsPackBalanceAdapter,
  D1RunsPackDraftAdapter,
  D1RunsPackVersionAdapter,
  ensureRunsPackSchema,
  type RunsPackDb,
} from "./d1RunsPackAdapter";
import type {
  RunsPackBalancePort,
  RunsPackDraftStore,
  RunsPackVersionStore,
} from "./runsPackPorts";

/** The three runs-pack adapters, built from one Drizzle D1 database object. */
export interface RunsPackAdapters {
  versions: D1RunsPackVersionAdapter;
  balance: D1RunsPackBalanceAdapter;
  drafts: D1RunsPackDraftAdapter;
}

/** Build the runs-pack adapters from Worker env, or null if unbound. */
export function createRunsPackAdapters(env: { AGENT_DB?: unknown }): RunsPackAdapters | null {
  if (!env.AGENT_DB) return null;
  const db = createD1RunsPackDb(env.AGENT_DB as D1Database);
  return {
    versions: new D1RunsPackVersionAdapter(db),
    balance: new D1RunsPackBalanceAdapter(db),
    drafts: new D1RunsPackDraftAdapter(db),
  };
}

export { ensureRunsPackSchema };
export type { RunsPackDb, RunsPackBalancePort, RunsPackDraftStore, RunsPackVersionStore };
