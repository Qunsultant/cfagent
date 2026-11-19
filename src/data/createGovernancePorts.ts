/**
 * Issue #1548 ([AGENTIC] Slice 0) — composition root for the
 * governance ports (R1). This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state (the layer
 * is safe to merge before the binding propagates everywhere):
 * `createGovernanceAdapter` returns null and callers keep their
 * legacy behavior. A present-but-unreadable store fails closed
 * (see `readAgentDbHalt`).
 */
import {
  createD1GovernanceDb,
  D1GovernanceAdapter,
  ensureGovernanceSchema,
} from "./d1GovernanceAdapter";
import type { HaltReader } from "./governancePorts";

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Build the governance adapter from Worker env, or null if unbound. */
export function createGovernanceAdapter(env: {
  AGENT_DB?: unknown;
  OBSERVABILITY?: unknown;
}): D1GovernanceAdapter | null {
  if (!env.AGENT_DB) return null;
  // #3515 S3 batch 7 — env-constructed sink (#5587) for the adapter's
  // halt-read event.
  return new D1GovernanceAdapter(createD1GovernanceDb(env.AGENT_DB as D1Database), {
    sink: createObservabilitySink(env),
  });
}

/**
 * Fresh halt read for the tick path: ensure schema (idempotent,
 * migration-gated), then read. Any failure — schema-ensure or
 * read — reports halted (fail-closed). The adapter's own
 * `isHalted` already fails closed; this wrapper covers the
 * schema-ensure step too, so no failure mode reads as clear.
 */
export async function readAgentDbHalt(
  env: { AGENT_DB?: unknown; OBSERVABILITY?: unknown },
  tenantId: string,
): Promise<boolean> {
  // #3515 S3 batch 7 — env-constructed sink (#5587).
  const structuredLog = createStructuredLogger(createObservabilitySink(env), {
    component: "data/createGovernancePorts",
  });
  try {
    const adapter = createGovernanceAdapter(env);
    if (!adapter) return false;
    await ensureGovernanceSchema(adapter.db);
    return await adapter.isHalted(tenantId);
  } catch (err) {
    structuredLog.error("createGovernancePorts.agent_db_halt_read_failed", {
      message: "[data-foundation] AgentDB halt read failed; failing closed:",
      error: err instanceof Error ? err.message : String(err),
      tenantId,
    });
    return true;
  }
}

export type { HaltReader };
