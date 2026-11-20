/**
 * Issue #3185 (bridge slice) — composition root for the
 * usage-events mirror ports (mirrors
 * src/data/createRunLedgerPorts.ts).
 *
 * This is the ONLY module besides the adapter that may touch the
 * AGENT_DB binding for usage-event mirror rows, and it never lets
 * a missing binding throw: an unbound environment yields a null
 * adapter. Callers decide what null means (the projection paths
 * treat it as a no-op / named skip).
 */
import {
  createD1UsageEventMirrorDb,
  D1UsageEventMirrorAdapter,
  ensureUsageEventMirrorSchema,
} from "./d1UsageEventMirrorAdapter";

type EnvWithAgentDb = { AGENT_DB?: unknown };

/** Null when AGENT_DB is not bound; never throws. */
export function createUsageEventMirrorAdapter(
  env: EnvWithAgentDb | undefined | null,
): D1UsageEventMirrorAdapter | null {
  if (!env?.AGENT_DB) return null;
  return new D1UsageEventMirrorAdapter(createD1UsageEventMirrorDb(env.AGENT_DB));
}

/** Idempotent schema-ensure for the mirror table. */
export async function ensureUsageEventMirrorTables(
  adapter: D1UsageEventMirrorAdapter,
): Promise<void> {
  await ensureUsageEventMirrorSchema(adapter.db);
}
