/**
 * Issue #3477 — social reward configuration, the single source of truth.
 *
 * Every value the reward model enforces lives in
 * `config/social-rewards.json`; no module hardcodes a cap, an
 * expiry window, or an amount. Change the JSON (through the #3483
 * configuration surface when it lands) to change behavior.
 *
 * The shipped JSON is ALL NULLS: every value is owner/CBO-decided
 * and unset, so every reward type resolves to unavailable
 * (fail-closed) until configured — the same idiom as the cfpay
 * channel's null fixed price. There is no fallback value anywhere
 * in code. The loader validates strictly at import time and fails
 * fast on a malformed file rather than serving a half-valid config.
 */
import raw from "../../config/social-rewards.json";
import {
  resolveSocialRewardAvailability,
  validateSocialRewardConfig,
  type SocialRewardConfig,
  type SocialRewardType,
} from "../data/socialRewardModel";

export type { SocialRewardConfig };

export const SOCIAL_REWARD_CONFIG: SocialRewardConfig =
  validateSocialRewardConfig(raw);

/** True only when the type is enabled AND every value its rules need is configured. */
export function socialRewardTypeAvailable(type: SocialRewardType): boolean {
  return resolveSocialRewardAvailability(SOCIAL_REWARD_CONFIG, type).available;
}
