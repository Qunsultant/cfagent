/**
 * Issue #5160 — IDP profile config defaults, the single source of truth.
 *
 * Every value the IDP profile path enforces lives in
 * `config/idp-profile.json`; no module hardcodes a default. Change
 * the JSON to change behavior, then update the pins in the tests
 * that quote the value (they derive boundary cases from
 * DEFAULT_IDP_PROFILE_CONFIG, never from a second copy).
 *
 * Default is store-all per the owner directive (2026-11-17):
 * every IDP attribute is stored unless the operator excludes it.
 * retentionDays 0 = retain while the identity exists.
 */
import raw from "../../config/idp-profile.json";

export interface IdpProfileConfigShape {
  /** True = store every IDP attribute except the excluded list. */
  storeAll: boolean;
  /** IDP attribute names never stored (case-insensitive). */
  excludedAttributes: string[];
  /** Days to retain a profile after its identity's last sign-in; 0 = retain while the identity exists. */
  retentionDays: number;
}

export const DEFAULT_IDP_PROFILE_CONFIG: IdpProfileConfigShape = raw as IdpProfileConfigShape;
