/**
 * Issue #3185 (bridge slice) — the shared usage-events projector:
 * the ONE D1 writer for meter rows. The live hook, the queue-free
 * reconcile sweep, and the backfill all call this same function,
 * so the projection rule is literal, not a convention.
 *
 * - One row per meter id; rows are immutable once projected
 *   (INSERT OR IGNORE — a replay is a no-op, never a rewrite).
 * - The backfill's NULL-tenant stamp only ever fills NULL (the
 *   write-time stamp is authoritative, never overwritten).
 * - The projector never throws for a missing store — a null
 *   adapter resolves to {projected:false, skipped:"unbound"}.
 *   A store failure propagates to the caller: best-effort callers
 *   catch it (postUsageEventBestEffort), the sweep records it.
 */
import type { UsageEventDetailRow } from "./canonicalReportStorePorts";
import type { D1UsageEventMirrorAdapter } from "./d1UsageEventMirrorAdapter";

export interface UsageEventProjectionInput extends UsageEventDetailRow {
  /** Which DO instance projected the row (provenance, not a join key). */
  sourceInstance?: string | null;
}

export interface ProjectUsageEventResult {
  projected: boolean;
  /** Set when nothing was written and why (never silent). */
  skipped?: string;
}

export interface UsageEventProjectorDeps {
  mirror: D1UsageEventMirrorAdapter | null;
}

export function createUsageEventProjector(deps: UsageEventProjectorDeps) {
  return {
    async projectUsageEvent(
      row: UsageEventProjectionInput,
      nowMs: number,
    ): Promise<ProjectUsageEventResult> {
      if (!deps.mirror) return { projected: false, skipped: "unbound" };
      const landed = await deps.mirror.recordUsageEvent(row, {
        sourceInstance: row.sourceInstance ?? null,
        nowMs,
      });
      return landed
        ? { projected: true }
        : { projected: false, skipped: "already-current" };
    },

    async stampTenantIfUnattributed(
      id: string,
      tenantId: string,
    ): Promise<boolean> {
      if (!deps.mirror) return false;
      return deps.mirror.stampTenantIfUnattributed(id, tenantId);
    },
  };
}

export type UsageEventProjector = ReturnType<typeof createUsageEventProjector>;
