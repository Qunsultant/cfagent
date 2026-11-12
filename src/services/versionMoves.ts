/**
 * Issue #3289 (sub-issue of #3241) — per-customer version moves,
 * segment assignment, and the bulk-move job driver.
 *
 * Slice 1 primitives (no UI):
 *
 * 1. moveSubscriptionToVersion — move ONE subscription to
 *    another version of the SAME product. The target must be
 *    the effective, approved version for the holder's segment
 *    at the move instant; a move onto a superseded, future,
 *    expired, deactivated, or unapproved version refuses, and
 *    a move across products refuses (a move changes the
 *    version, never the product). A move onto the version
 *    already held is a no-op success (idempotent retry). The
 *    planId update happens first, then the audit row; an audit
 *    failure throws (the route maps it to 500) — the state is
 *    true and the audit is missing, which the operator sees as
 *    an error, never as a silent success. Runs and credits are
 *    untouched by a move; the renewal stacks on the new version
 *    at the new price (design §6).
 *
 * 2. setAccountSegment — assign an account's segment. The
 *    segment changes what the NEXT per-run charge resolves to
 *    (and what a future move may target); it changes nothing
 *    about held versions, runs, or credits. The audit row
 *    records the held version when one exists (the version did
 *    not change, so from == to), and null product/version when
 *    the customer holds no version.
 *
 * Slice 2 (design §4.8):
 *
 * 3. runBulkMove — "move all customers to current pricing."
 *    One operator action, product-scoped and segment-aware:
 *    every live holder of a non-current version of the product
 *    moves to their own segment's current effective version.
 *    The job runs synchronously inside the bulk-move route
 *    with a row cap (no background-job handle is reachable
 *    from the route context, and the J1 pipeline engine is a
 *    control plane for scheduled pipeline jobs, not operator
 *    actions). Each customer move is atomic per customer (the
 *    per-customer primitive above); the job is resumable via
 *    the (bulkMoveId, userId) idempotency backstop plus the
 *    planId check — a re-run never moves the same customer
 *    twice. A per-customer failure is recorded and counted,
 *    never fatal to the job.
 *
 * All three are operator acts: the routes enforce
 * operator-only and audit them (commercial.product.move /
 * commercial.account.segment.set / commercial.product.bulk_move).
 * The segment always derives from the verified account row; a
 * move never trusts a client-supplied segment.
 */
import type { CommercialAccountRecord, CommercialStore } from "../data/commercialPorts";
import {
  assertSegment,
  DEFAULT_SEGMENT,
  type BulkMoveRecord,
  type ProductStore,
} from "../data/productPorts";
import type { SubscriptionRecord, SubscriptionStore } from "../data/subscriptionPorts";
import { assertPlanEffectiveAndApprovedForSegment } from "./subscriptionActivation";

export interface MoveSubscriptionInput {
  subs: SubscriptionStore;
  store: CommercialStore;
  products: ProductStore;
  subscriptionId: string;
  toVersionId: string;
  /** Verified operator login performing the move (audited). */
  movedBy: string;
  reason?: string | null;
  /** The bulk move this move belongs to; null for a per-customer move. */
  bulkMoveId?: string | null;
  nowMs?: number;
}

export interface MoveSubscriptionResult {
  subscription: SubscriptionRecord;
  /** False when the subscription already held the target version (no-op success). */
  moved: boolean;
  fromVersionId: string;
  toVersionId: string;
}

export async function moveSubscriptionToVersion(
  input: MoveSubscriptionInput,
): Promise<MoveSubscriptionResult> {
  const { subs, store, products, subscriptionId, toVersionId, movedBy } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!movedBy) throw new Error("movedBy is required.");
  if (!toVersionId) throw new Error("toVersionId is required.");
  const subscription = await subs.getSubscription(subscriptionId);
  if (!subscription) throw new Error(`No subscription ${subscriptionId}.`);
  const target = await subs.getPlan(toVersionId);
  if (!target) throw new Error(`No plan version ${toVersionId}.`);
  // Same version = no-op success: a retried move never
  // double-moves, and the audit row is not duplicated.
  if (subscription.planId === toVersionId) {
    return { subscription, moved: false, fromVersionId: subscription.planId, toVersionId };
  }
  // Same product only: a move changes the version, never the
  // product. A subscription whose current plan row is unknown
  // (pre-0058 row) skips this check — moving it to a valid
  // version repairs it.
  const current = await subs.getPlan(subscription.planId);
  if (current && current.productId !== target.productId) {
    throw new Error(
      `Cannot move subscription ${subscriptionId} from product ${current.productId} to ${target.productId}: a move changes the version, never the product.`,
    );
  }
  // The holder's segment, from the verified account row.
  const account = await store.getAccount(subscription.userId);
  const segment = account?.segment ?? DEFAULT_SEGMENT;
  // Effective + approved for the holder's segment, at now.
  await assertPlanEffectiveAndApprovedForSegment(subs, target, segment, nowMs);
  // PlanId update first, then the audit row.
  const updated = await subs.moveSubscriptionToVersion(subscriptionId, toVersionId);
  await products.recordMove({
    bulkMoveId: input.bulkMoveId ?? null,
    userId: subscription.userId,
    productId: target.productId,
    fromVersionId: subscription.planId,
    toVersionId,
    segment,
    movedBy,
    reason: input.reason ?? null,
    movedAtMs: nowMs,
  });
  return { subscription: updated, moved: true, fromVersionId: subscription.planId, toVersionId };
}

export interface SetAccountSegmentInput {
  store: CommercialStore;
  subs: SubscriptionStore;
  products: ProductStore;
  userId: string;
  segment: string;
  /** Verified operator login performing the change (audited). */
  movedBy: string;
  reason?: string | null;
  nowMs?: number;
}

export interface SetAccountSegmentResult {
  account: CommercialAccountRecord;
  previousSegment: string;
  segment: string;
}

export async function setAccountSegment(
  input: SetAccountSegmentInput,
): Promise<SetAccountSegmentResult> {
  const { store, subs, products, userId } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!input.movedBy) throw new Error("movedBy is required.");
  const segment = assertSegment(input.segment);
  const account = await store.getAccount(userId);
  if (!account) throw new Error(`No commercial account for user ${userId}.`);
  const previousSegment = account.segment ?? DEFAULT_SEGMENT;
  // The held version, for the audit row: the customer's live
  // subscription's plan, when one exists. The version does not
  // change here — only the segment does.
  const subscriptions = await subs.listSubscriptions(userId);
  const live = subscriptions.find((s) => s.status === "active" && s.periodEndMs > nowMs);
  const heldPlan = live ? await subs.getPlan(live.planId) : null;
  const updated = await store.setAccountSegment(userId, segment);
  await products.recordMove({
    userId,
    productId: heldPlan?.productId ?? null,
    fromVersionId: heldPlan?.id ?? null,
    toVersionId: heldPlan?.id ?? null,
    segment,
    movedBy: input.movedBy,
    reason: input.reason ?? null,
    movedAtMs: nowMs,
  });
  return { account: updated, previousSegment, segment };
}

/**
 * Slice 2 — the bulk-move job driver (design §4.8).
 *
 * Execution: synchronous inside the bulk-move route, paged
 * over the product's live holders with a row cap (default
 * 500). The cap bounds one request; when the population
 * exceeds it the summary row stays "running" with hasMore,
 * and the operator resumes with the same bulkMoveId — the
 * resume pass skips every holder already on target, so no
 * customer is ever moved twice.
 */
export const BULK_MOVE_DEFAULT_LIMIT = 500;

/** One segment's slice of a bulk-move preview (dry run) or result. */
export interface BulkMovePreviewSegment {
  segment: string;
  /** The effective version id for the segment, or null when no version is effective. */
  targetVersionId: string | null;
  /** Whether the target is movable: effective + approved + active. */
  targetReady: boolean;
  /** Live holders of the product in this segment. */
  holderCount: number;
  /** Holders by currently-held version id. */
  fromVersions: Array<{ versionId: string; count: number }>;
}

export interface BulkMoveFailure {
  userId: string;
  subscriptionId: string;
  error: string;
}

export interface RunBulkMoveInput {
  subs: SubscriptionStore;
  store: CommercialStore;
  products: ProductStore;
  productId: string;
  /** Narrow to one segment; null/undefined = all segments ("all customers on this product"). */
  segmentScope?: string | null;
  /** Verified operator login performing the move (audited). */
  movedBy: string;
  reason?: string | null;
  /** Resume a running bulk move instead of starting a new one. */
  resumeBulkMoveId?: string;
  /** Max holders processed in this invocation (default 500). */
  limit?: number;
  /** Preview only: resolve targets + count the population, move nobody, write nothing. */
  dryRun?: boolean;
  nowMs?: number;
}

export interface RunBulkMoveResult {
  /** The summary row; null on a dry run (nothing is written). */
  bulkMove: BulkMoveRecord | null;
  /** Per-segment preview: targets, readiness, holder counts, from-versions. */
  preview: BulkMovePreviewSegment[];
  /** Counts from THIS invocation (on a resume, the summary row carries the accumulated totals). */
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  /** True when the cap stopped the job with holders unprocessed — resume to continue. */
  hasMore: boolean;
  /** Per-customer failures from this invocation (recorded, never fatal). */
  failures: BulkMoveFailure[];
}

interface BulkMoveHolder {
  subscription: SubscriptionRecord;
  segment: string;
}

async function resolveBulkMovePopulation(
  input: RunBulkMoveInput,
  nowMs: number,
): Promise<{
  preview: BulkMovePreviewSegment[];
  /** Holders in segments with a ready target, in deterministic order. */
  movable: BulkMoveHolder[];
  /** Ready targets by segment, resolved at job start. */
  targets: Record<string, string>;
}> {
  const { subs, store, products, productId } = input;
  const product = await products.getProduct(productId);
  if (!product) throw new Error(`No product ${productId}.`);
  if (product.kind !== "subscription") {
    throw new Error(
      `Bulk move applies to subscription products only: ${productId} is a per-run product, and per-run customers always pay their segment's current price.`,
    );
  }
  const segmentScope =
    input.segmentScope === undefined || input.segmentScope === null ? null : assertSegment(input.segmentScope);
  const versions = await subs.listVersions(productId);
  const versionIds = new Set(versions.map((v) => v.id));
  // Live holders of this product: active, unexpired, holding a
  // version of the product. Expired/canceled rows confer
  // nothing and are never moved.
  const holders: BulkMoveHolder[] = [];
  for (const subscription of await subs.listAllSubscriptions()) {
    if (!versionIds.has(subscription.planId)) continue;
    if (subscription.status !== "active" || subscription.periodEndMs <= nowMs) continue;
    const account = await store.getAccount(subscription.userId);
    const segment = account?.segment ?? DEFAULT_SEGMENT;
    if (segmentScope !== null && segment !== segmentScope) continue;
    holders.push({ subscription, segment });
  }
  // Group by segment; resolve each segment's target at job
  // start. A segment whose effective version is missing,
  // unapproved, or deactivated has no movable target: its
  // holders stay put and the preview says why.
  const bySegment = new Map<string, BulkMoveHolder[]>();
  for (const holder of holders) {
    const list = bySegment.get(holder.segment) ?? [];
    list.push(holder);
    bySegment.set(holder.segment, list);
  }
  const preview: BulkMovePreviewSegment[] = [];
  const movable: BulkMoveHolder[] = [];
  const targets: Record<string, string> = {};
  for (const segment of [...bySegment.keys()].sort()) {
    const segmentHolders = bySegment.get(segment) ?? [];
    const effective = await subs.getEffectiveVersion(productId, segment, nowMs);
    const targetReady =
      effective !== null && effective.approvalStatus === "approved" && effective.active !== false;
    const fromCounts = new Map<string, number>();
    for (const holder of segmentHolders) {
      fromCounts.set(holder.subscription.planId, (fromCounts.get(holder.subscription.planId) ?? 0) + 1);
    }
    preview.push({
      segment,
      targetVersionId: effective?.id ?? null,
      targetReady,
      holderCount: segmentHolders.length,
      fromVersions: [...fromCounts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([versionId, count]) => ({ versionId, count })),
    });
    if (targetReady && effective) {
      targets[segment] = effective.id;
      movable.push(...segmentHolders);
    }
  }
  // Deterministic processing order: the store list is already
  // ordered by user then id; the segment grouping above must
  // not reorder it.
  movable.sort((a, b) =>
    a.subscription.userId < b.subscription.userId
      ? -1
      : a.subscription.userId > b.subscription.userId
        ? 1
        : a.subscription.id < b.subscription.id
          ? -1
          : a.subscription.id > b.subscription.id
            ? 1
            : 0,
  );
  return { preview, movable, targets };
}

export async function runBulkMove(input: RunBulkMoveInput): Promise<RunBulkMoveResult> {
  const { subs, store, products, productId, movedBy } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!movedBy) throw new Error("movedBy is required.");
  const limit = input.limit ?? BULK_MOVE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer.");
  const { preview, movable, targets } = await resolveBulkMovePopulation(input, nowMs);

  // Dry run: the preview is the whole result. Nothing moves,
  // nothing is written — the confirmation screen is built from
  // exactly the population and targets the real run would use.
  if (input.dryRun) {
    return {
      bulkMove: null,
      preview,
      movedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      hasMore: false,
      failures: [],
    };
  }

  // Resume: continue a running summary row, accumulating its
  // counts. A finished row refuses — re-running a finished
  // bulk move starts a new one.
  let bulkMove: BulkMoveRecord;
  let movedTotal = 0;
  let skippedTotal = 0;
  let failedTotal = 0;
  let resumeTargets: Record<string, string> | null = null;
  if (input.resumeBulkMoveId) {
    const existing = await products.getBulkMove(input.resumeBulkMoveId);
    if (!existing) throw new Error(`No bulk move ${input.resumeBulkMoveId}.`);
    if (existing.productId !== productId) {
      throw new Error(`Bulk move ${input.resumeBulkMoveId} belongs to product ${existing.productId}.`);
    }
    if (existing.status !== "running") {
      throw new Error(`Bulk move ${input.resumeBulkMoveId} is ${existing.status}; only a running bulk move resumes.`);
    }
    bulkMove = existing;
    movedTotal = existing.movedCount;
    skippedTotal = existing.skippedCount;
    failedTotal = existing.failedCount;
    try {
      resumeTargets = JSON.parse(existing.targetVersionIdsJson) as Record<string, string>;
    } catch {
      throw new Error(`Bulk move ${input.resumeBulkMoveId} has unreadable target versions.`);
    }
  } else {
    bulkMove = await products.createBulkMove({
      productId,
      segmentScope:
        input.segmentScope === undefined || input.segmentScope === null ? null : assertSegment(input.segmentScope),
      targetVersionIdsJson: JSON.stringify(targets),
      movedBy,
      reason: input.reason ?? null,
      startedAtMs: nowMs,
    });
  }
  const effectiveTargets = resumeTargets ?? targets;

  let moved = 0;
  let skipped = 0;
  let failed = 0;
  const failures: BulkMoveFailure[] = [];
  let processed = 0;
  let hasMore = false;
  for (const holder of movable) {
    if (processed >= limit) {
      hasMore = true;
      break;
    }
    processed += 1;
    const targetVersionId = effectiveTargets[holder.segment];
    // A resumed job whose targets predate a segment-scope
    // change can name a segment with no target: that holder
    // is skipped, never moved onto an unresolved version.
    if (!targetVersionId) {
      skipped += 1;
      continue;
    }
    if (holder.subscription.planId === targetVersionId) {
      skipped += 1;
      continue;
    }
    try {
      const result = await moveSubscriptionToVersion({
        subs,
        store,
        products,
        subscriptionId: holder.subscription.id,
        toVersionId: targetVersionId,
        movedBy,
        reason: input.reason ?? null,
        bulkMoveId: bulkMove.id,
        nowMs,
      });
      if (result.moved) moved += 1;
      else skipped += 1;
    } catch (err: any) {
      // Per-customer failure: recorded and counted, never
      // fatal to the job. The operator re-runs for the
      // failures, or moves those customers individually.
      failed += 1;
      failures.push({
        userId: holder.subscription.userId,
        subscriptionId: holder.subscription.id,
        error: err?.message || "Move failed.",
      });
    }
  }

  const finished = !hasMore;
  bulkMove = await products.updateBulkMove(bulkMove.id, {
    status: finished ? (failedTotal + failed > 0 ? "complete_with_failures" : "complete") : "running",
    movedCount: movedTotal + moved,
    skippedCount: skippedTotal + skipped,
    failedCount: failedTotal + failed,
    ...(finished ? { finishedAtMs: nowMs } : {}),
  });
  return {
    bulkMove,
    preview,
    movedCount: moved,
    skippedCount: skipped,
    failedCount: failed,
    hasMore,
    failures,
  };
}
