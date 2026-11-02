/**
 * Issue #2753 (Platform Phase 7, program #2468) — product rollout stages.
 *
 * The product-agnostic rollout stage derivation, reusing the screening
 * flag idiom (src/services/screeningFlags.ts): reader-function
 * injection, validated setter, fail-safe defaults, recorded never
 * auto-advanced. Differences from screening, deliberate:
 * - Stages are internal → pilot → broad. The screening stage "paper"
 *   is a simulation stage of the screening system and does not apply
 *   to platform rollout; the platform pilot is a testnet stage with a
 *   named cohort (see pilotGate.ts), not a simulation.
 * - Mainnet is NOT a stage here. Mainnet enablement is a separate
 *   checklist gate (see mainnetGate.ts) that stays RED until every
 *   written requirement exists. A product at "broad" is broadly
 *   available on testnet, not on mainnet.
 * - One stage per product, applying to all its surfaces. Per-surface
 *   stages are not modeled (documented limitation).
 * - Stages change only through an explicit write. This module never
 *   advances a stage on its own, and no caller in this phase writes
 *   one: stage advancement is an operator action through whatever
 *   controls surface adopts this derivation later.
 * Pure derivation over caller-supplied data — zero reads, zero writes
 * beyond the caller-supplied writer, zero routes, zero activation.
 */

export type RolloutRead = (key: string) => string | null;
export type RolloutWrite = (key: string, value: string) => void;

export type RolloutStage = "internal" | "pilot" | "broad";
export const ROLLOUT_STAGES: RolloutStage[] = ["internal", "pilot", "broad"];

export function rolloutKey(productId: string): string {
  return `product.rollout.${productId}`;
}

export function isRolloutStage(v: unknown): v is RolloutStage {
  return typeof v === "string" && (ROLLOUT_STAGES as string[]).includes(v);
}

/**
 * Current stage for a product; absent/unknown/unreadable values read
 * as the safest stage, "internal" (the screeningFlags fail-safe).
 */
export function getProductRolloutStage(
  read: RolloutRead,
  productId: string,
): RolloutStage {
  let raw: string | null;
  try {
    raw = read(rolloutKey(productId));
  } catch (err) {
    console.error(
      `[productRollout] read of ${rolloutKey(productId)} failed; applying the fail-safe value:`,
      err,
    );
    return "internal";
  }
  return isRolloutStage(raw) ? raw : "internal";
}

/** Validated stage write: only known stages are accepted. */
export function setProductRolloutStage(
  write: RolloutWrite,
  productId: string,
  stage: RolloutStage,
): void {
  if (!isRolloutStage(stage)) {
    throw new Error(
      `Invalid rollout stage "${stage}" (expected one of ${ROLLOUT_STAGES.join(", ")}).`,
    );
  }
  write(rolloutKey(productId), stage);
}

/** Stage ordering: internal < pilot < broad. */
export function stageAtLeast(stage: RolloutStage, minimum: RolloutStage): boolean {
  return ROLLOUT_STAGES.indexOf(stage) >= ROLLOUT_STAGES.indexOf(minimum);
}
