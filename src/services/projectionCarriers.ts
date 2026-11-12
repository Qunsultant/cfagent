/**
 * Issue #4116 — the tenant's run-ledger projection carrier config
 * read, in the readTenantBrokerSelection shape (#1069 pattern):
 * presence-aware, status union, named denial — never a default.
 *
 * - ok: the tenant configured carriers (each flag independent) +
 *   the read mode the surfaces use.
 * - unconfigured: no carrier row exists. The tenant projects
 *   nothing; the caller names the refusal, never silently degrades
 *   to a default carrier.
 * - store_unavailable: AGENT_DB unbound, or the read threw.
 *
 * The read happens once per call chain; callers thread the
 * resolved flags down (the same threading the queue binding
 * already uses) — never a D1 round-trip per row write.
 */
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { createRunLedgerAdapter } from "../data/createRunLedgerPorts";
import type { D1RunLedgerAdapter } from "../data/d1RunLedgerAdapter";
import type { TenantProjectionCarriersRead } from "../data/runLedgerPorts";
import type { Env } from "../types";

export type ProjectionCarrierStore = Pick<
  D1RunLedgerAdapter,
  "getTenantProjectionCarriers"
>;

export async function readTenantProjectionCarriers(
  env: Partial<Env>,
  store?: ProjectionCarrierStore | null,
): Promise<TenantProjectionCarriersRead> {
  const adapter = store !== undefined ? store : createRunLedgerAdapter(env);
  if (!adapter) {
    return {
      status: "store_unavailable",
      error: "projection carriers could not be read: tenant store is not bound",
    };
  }
  let stored: Awaited<ReturnType<ProjectionCarrierStore["getTenantProjectionCarriers"]>>;
  try {
    stored = await adapter.getTenantProjectionCarriers(resolveIaaaTenant(env));
  } catch {
    return {
      status: "store_unavailable",
      error: "projection carriers could not be read: tenant store failed",
    };
  }
  if (stored === null) {
    return {
      status: "unconfigured",
      error: "no projection carriers configured: the tenant has not configured a run-ledger projection carrier",
    };
  }
  return { status: "ok", carriers: stored.carriers, readMode: stored.readMode };
}
