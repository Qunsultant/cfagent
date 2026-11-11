/**
 * Issue #3289 (sub-issue of #3241) — per-customer version moves
 * and segment assignment (slice 1 primitives).
 *
 * Two operator primitives, no UI, no bulk job (slice 2):
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
 * Both are operator acts: the routes enforce operator-only and
 * audit them (commercial.product.move /
 * commercial.account.segment.set). The segment always derives
 * from the verified account row; a move never trusts a
 * client-supplied segment.
 */
import type { CommercialAccountRecord, CommercialStore } from "../data/commercialPorts";
import { assertSegment, DEFAULT_SEGMENT, type ProductStore } from "../data/productPorts";
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
