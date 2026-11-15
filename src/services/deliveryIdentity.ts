/**
 * Issue #4624 — the delivery identity.
 *
 * A "delivery identity" is the stable id a screener run is delivered under.
 * It is the left half of the suppression key (`<runId>::<destination>` in
 * src/workflows/screenDeliverySuppression.ts) and the event subject, so it
 * decides whether two deliveries are the same one.
 *
 * The bug this module closes: the scheduled identity was
 * `${trigger}:${universe}:${minute}` — trigger + universe only. Two tenants
 * of one login firing the same trigger and universe in the same minute
 * produced the SAME identity, so the second tenant's delivery was suppressed
 * as a duplicate of the first. The tenant is now part of the identity.
 *
 * Two shapes, stated plainly:
 *  - scheduled: `<trigger>:<tenant>:<universe>:<minute>` — minute resolution
 *    is deliberate (a re-submitted deliver job for the same scheduled run
 *    must keep suppressing), so the tenant is what separates two tenants.
 *  - manual: `manual:<timestamp>:<universe>` — the timestamp is the run's
 *    full ISO instant, so it is already per-run unique; a retry of the same
 *    run reuses it (same run = same identity), which is the dedupe that
 *    shape wants. No tenant segment is added: there is nothing to separate.
 *
 * `unscoped` is the honest fallback when no tenant can be resolved. It keeps
 * the shape parseable and the row distinct from a named tenant, but it does
 * NOT invent a tenant — two unscoped runs still collide, which is the
 * pre-fix behavior for that degraded case only.
 */

/** Tenant segment used when the delivery's tenant could not be resolved. */
export const UNRESOLVED_DELIVERY_TENANT = "unscoped";

/** The scheduled-run delivery identity, tenant-scoped. */
export function scheduledDeliveryIdentity(input: {
  /** Resolved tenant, or null when it could not be resolved. */
  tenantId: string | null;
  /** `scheduled` | `manual` | any caller trigger label. */
  trigger: string;
  universe: string;
  /** ISO instant; truncated to the minute, so one scheduled run has one id. */
  timestamp: string;
}): string {
  const tenant = input.tenantId?.trim() || UNRESOLVED_DELIVERY_TENANT;
  return `${input.trigger}:${tenant}:${input.universe}:${input.timestamp.slice(0, 16)}`;
}

/** The manual-run delivery identity (full-resolution timestamp = per run). */
export function manualDeliveryIdentity(input: { timestamp: string; universe: string }): string {
  return `manual:${input.timestamp}:${input.universe}`;
}

/** True when the identity carries a real tenant segment (not `unscoped`). */
export function deliveryIdentityIsTenantScoped(identity: string): boolean {
  const parts = identity.split(":");
  if (parts[0] === "manual" || parts[0] === "workflow") return true;
  return parts.length >= 4 && parts[1] !== UNRESOLVED_DELIVERY_TENANT;
}
