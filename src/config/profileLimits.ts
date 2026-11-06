/**
 * Issue #3261 — user profile validation limits, the single source of truth.
 *
 * Every value the profile path enforces lives in
 * `config/profile-limits.json`; no module hardcodes a length. Change the
 * JSON to change behavior, then update the pins in the tests that quote
 * the value (they derive boundary cases from PROFILE_LIMITS, never from
 * a second copy). The phone character set is NOT here: it is a validation
 * rule in src/services/userProfile.ts, not a tunable value.
 *
 * The client reads the same module for input maxLength hints; the server
 * is the authority at validation time.
 */
import raw from "../../config/profile-limits.json";

export interface ProfileLimits {
  /** Display name: maximum characters after trimming (100). */
  displayNameMaxLength: number;
  /** Phone: maximum characters after trimming (30). */
  phoneMaxLength: number;
}

export const PROFILE_LIMITS: ProfileLimits = raw as ProfileLimits;
