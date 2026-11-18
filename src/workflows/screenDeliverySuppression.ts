/**
 * Issue #2867 (Phase 2 Slice 7 under #2764) — (runId, destination)
 * delivery suppression, the adopted Phase 1 decision.
 *
 * GRASP Information Expert / Pure Fabrication: this module owns
 * the single definition of a duplicate delivery — the same run
 * delivered twice to the same destination — and the claim
 * operation that suppresses the second send. It owns no
 * transport, no job store, and no new delivery bridge: the
 * followup.deliver executor (src/agents/orchestrator/asyncJobs.ts)
 * consults it before sending, after the existing pipeline-policy
 * gates, and the existing delivery port still performs the send.
 *
 * Key shape: `<runId>::<destination>`. The runId is the run's
 * stable delivery id (ScreenerRunOutcome.deliveryId) when one
 * exists, else the deliver job's own id. The destination is the
 * channel ("slack" | "email" | "webhook"), except email, where
 * the recipient distinguishes destinations
 * (`email:<lowercased recipient>`) — two recipients for one run
 * are two different deliveries, not duplicates.
 *
 * Store scope, stated plainly: the suppressor's store is
 * injected; the executor default is an in-memory set held on
 * the executor context (the same per-instance pattern as the
 * context's scheduled slot sets), which suppresses retries
 * and duplicate submissions within one agent instance.
 * Issue #2913 (G6) adds the durable store
 * (mas_delivery_claims in the DO SQLite store, wired by the
 * orchestrator's asyncJobsContext, so claims survive an
 * instance eviction) — its SQL lives in
 * src/data/deliveryClaimsStore.ts, the data-layer home for
 * this table — and stamps the REST bridge's outcomes with
 * the stable deliveryId the legacy fallback already uses,
 * so a resubmitted deliver job carrying that deliveryId is
 * matched across instances. A resubmitted deliver job that
 * carries no deliveryId at all is still keyed by its own job
 * id — the mas_async_jobs completion marking remains the
 * durable guard against re-executing a completed deliver job.
 */

export interface DeliverySuppressionStore {
  has(key: string): boolean;
  add(key: string): void;
  /** Optional: remove a claim (send-failure release). Absent = release is a no-op. */
  delete?(key: string): void;
}

export interface DeliverySuppressor {
  /**
   * Claim (runId, destination) for sending. Returns true on
   * the first claim (proceed to send) and false when the pair
   * was already claimed (suppress — do not send again).
   */
  tryClaim(runId: string, destination: string): boolean;
  /** True when the pair was already claimed. Does not claim. */
  wasClaimed(runId: string, destination: string): boolean;
  /**
   * Release a claim, so a later send may proceed. Used ONLY
   * when the send itself failed (transport error — the
   * recipient holds nothing, so a retry must be allowed).
   * A post-send failure (e.g. the delivery audit throwing
   * after the recipient already holds the artifact) must NOT
   * release: the retry is then exactly the duplicate this
   * suppressor exists to stop.
   */
  release(runId: string, destination: string): void;
}

/** The canonical duplicate-delivery key. Destinations are trimmed; email recipients are lowercased by the caller (see header). */
export function deliverySuppressionKey(runId: string, destination: string): string {
  return `${runId.trim()}::${destination.trim()}`;
}

/**
 * Issue #4608 (G22 verification): ensure a delivery claim's `runId` is
 * tenant+run scoped whenever a resolved `tenantId` is known.
 *
 * - If `tenantId` is absent or `"unscoped"`, returns `runId` unchanged
 *   (preserving existing behavior for single-tenant / unscoped tests).
 * - If `runId` already embeds the tenant (`scheduled:<tenant>:...` from
 *   #4624 or `tenant:<tenant>:...`), returns `runId` unchanged.
 * - Otherwise prefixes `tenant:<tenantId>:<runId>` so two tenants sharing
 *   a bare or manual `runId` never collide in `mas_delivery_claims`.
 */
export function scopedDeliveryClaimRunId(
  runId: string,
  tenantId?: string | null,
): string {
  const trimmedRunId = runId.trim();
  const trimmedTenant = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!trimmedTenant || trimmedTenant === "unscoped") {
    return trimmedRunId;
  }
  if (
    trimmedRunId.startsWith(`tenant:${trimmedTenant}:`) ||
    trimmedRunId.startsWith(`scheduled:${trimmedTenant}:`)
  ) {
    return trimmedRunId;
  }
  const parts = trimmedRunId.split(":");
  if (parts.length >= 4 && parts[1] === trimmedTenant) {
    return trimmedRunId;
  }
  return `tenant:${trimmedTenant}:${trimmedRunId}`;
}

/** The destination for a followup.deliver send: channel, or email:<recipient> for email. */
export function deliveryDestinationFor(
  channel: "slack" | "email" | "webhook",
  emailTo?: string,
): string {
  if (channel === "email" && emailTo?.trim()) {
    return `email:${emailTo.trim().toLowerCase()}`;
  }
  return channel;
}

export function createDeliverySuppressor(
  store?: DeliverySuppressionStore,
): DeliverySuppressor {
  const seen = new Set<string>();
  const backing: DeliverySuppressionStore = store ?? {
    has: (key) => seen.has(key),
    add: (key) => {
      seen.add(key);
    },
    delete: (key) => {
      seen.delete(key);
    },
  };
  return {
    tryClaim(runId, destination) {
      const key = deliverySuppressionKey(runId, destination);
      if (backing.has(key)) return false;
      backing.add(key);
      return true;
    },
    wasClaimed(runId, destination) {
      return backing.has(deliverySuppressionKey(runId, destination));
    },
    release(runId, destination) {
      backing.delete?.(deliverySuppressionKey(runId, destination));
    },
  };
}

/**
 * Issue #4438 — the async seam: the same claim discipline
 * over an async backing store, for residencies whose durable
 * claims live behind a door (an RPC), where no sync store
 * exists. The key shape, the claim/release discipline, and
 * the module ownership are unchanged — only the backing
 * call is awaited. The sync seam above stays the seam for
 * DO residencies with local SQLite; the door-backed
 * suppressor (src/services/deliveryClaimsDoor.ts) is the
 * async seam's production backing.
 */
export interface AsyncDeliverySuppressionStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
  /** Optional: remove a claim (send-failure release). Absent = release is a no-op. */
  delete?(key: string): Promise<void>;
}

export interface AsyncDeliverySuppressor {
  /**
   * Claim (runId, destination) for sending. Returns true on
   * the first claim (proceed to send) and false when the pair
   * was already claimed (suppress — do not send again).
   */
  tryClaim(runId: string, destination: string): Promise<boolean>;
  /** True when the pair was already claimed. Does not claim. */
  wasClaimed(runId: string, destination: string): Promise<boolean>;
  /**
   * Release a claim, so a later send may proceed. Used ONLY
   * when the send itself failed (the sync release's rule,
   * unchanged).
   */
  release(runId: string, destination: string): Promise<void>;
}

export function createAsyncDeliverySuppressor(
  store?: AsyncDeliverySuppressionStore,
): AsyncDeliverySuppressor {
  const seen = new Set<string>();
  const backing: AsyncDeliverySuppressionStore = store ?? {
    has: async (key) => seen.has(key),
    add: async (key) => {
      seen.add(key);
    },
    delete: async (key) => {
      seen.delete(key);
    },
  };
  return {
    async tryClaim(runId, destination) {
      const key = deliverySuppressionKey(runId, destination);
      if (await backing.has(key)) return false;
      await backing.add(key);
      return true;
    },
    async wasClaimed(runId, destination) {
      return backing.has(deliverySuppressionKey(runId, destination));
    },
    async release(runId, destination) {
      await backing.delete?.(deliverySuppressionKey(runId, destination));
    },
  };
}
