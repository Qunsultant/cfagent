/**
 * Issue #4116 — composition root for the run-ledger projection
 * ports (mirrors src/data/createAuditReportPorts.ts).
 *
 * This is the ONLY module besides the adapter that may touch the
 * AGENT_DB binding for run-ledger rows, and it never lets a missing
 * binding throw: an unbound environment yields a null adapter.
 * Callers decide what null means (the read routes answer 503; the
 * projection paths treat it as a no-op / named skip).
 */
import {
  createD1RunLedgerDb,
  D1RunLedgerAdapter,
  ensureRunLedgerSchema,
} from "./d1RunLedgerAdapter";

type EnvWithAgentDb = { AGENT_DB?: unknown };

/** Null when AGENT_DB is not bound; never throws. */
export function createRunLedgerAdapter(
  env: EnvWithAgentDb,
): D1RunLedgerAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1RunLedgerAdapter(createD1RunLedgerDb(env.AGENT_DB));
}

/** Idempotent schema-ensure for the run-ledger tables. */
export async function ensureRunLedgerTables(
  adapter: D1RunLedgerAdapter,
): Promise<void> {
  await ensureRunLedgerSchema(adapter.db);
}
