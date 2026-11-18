/**
 * Issue #5230 — lifecycle content caps, the single source of truth.
 *
 * Every content cap the lifecycle/digest/teaser surfaces enforce lives
 * in `config/lifecycle-defaults.json`; no module hardcodes a cap. Change
 * the JSON to change behavior, then update the pins in the tests that
 * quote the value (they read LIFECYCLE_DEFAULTS, never a second copy).
 *
 * Values are UNCHANGED from the inline literals they replace (verified
 * by `tests/commercial_externalization_census_5230.test.ts`):
 * - limited digest items for a non-Subscribed tier: 3
 *   (`src/services/lifecycleEmail.ts`, the slice-3 digest cap, #2522);
 * - digest highlight summary truncation: 280 chars
 *   (`src/services/digestContentProvider.ts`);
 * - catalog teaser candidate cap: 3 (`src/data/productMarketing.ts`,
 *   the #1076 B1 teaser cap, following the slice-3 digest-cap
 *   precedent).
 *
 * The client reads the same module for the teaser copy
 * (`src/client/ProductCatalogPanel.tsx`); the server is the authority
 * at enforcement time.
 */
import raw from "../../config/lifecycle-defaults.json";

export interface LifecycleDefaults {
  /** Digest items shown to a non-Subscribed tier before the cap line (3). */
  limitedDigestItemCap: number;
  /** Digest highlight summary truncation, in characters (280). */
  digestHighlightSummaryMax: number;
  /** Catalog teaser candidates shown, in rank order (3). */
  teaserCandidateCap: number;
}

export const LIFECYCLE_DEFAULTS: LifecycleDefaults = raw as LifecycleDefaults;
