/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — composition
 * root for the approved-free quota port. This is the ONLY module that
 * maps a Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createApprovedFreeQuotaAdapter` returns null and the gate keeps
 * today's behavior for grant accounts — it falls through to the
 * normal gate (fail-closed: no free run without a verifiable bound).
 * A present-but-unreadable store fails at the call site, where the
 * caller decides the direction.
 */
import {
  createD1ApprovedFreeQuotaDb,
  D1ApprovedFreeQuotaAdapter,
  ensureApprovedFreeQuotaSchema,
  type ApprovedFreeQuotaDb,
} from "./d1ApprovedFreeQuotaAdapter";
import type { ApprovedFreeQuota } from "./approvedFreeQuotaPorts";

/** Build the approved-free quota adapter from Worker env, or null if unbound. */
export function createApprovedFreeQuotaAdapter(env: { AGENT_DB?: unknown }): D1ApprovedFreeQuotaAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ApprovedFreeQuotaAdapter(createD1ApprovedFreeQuotaDb(env.AGENT_DB as D1Database));
}

export { ensureApprovedFreeQuotaSchema };
export type { ApprovedFreeQuota, ApprovedFreeQuotaDb };
