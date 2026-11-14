/**
 * Issue #2846 — commercial defaults, the single source of truth.
 *
 * Every pagination default the commercial surfaces enforce lives in
 * `config/commercial-defaults.json`; no module hardcodes a limit. Change
 * the JSON to change behavior, then update the pins in the tests that
 * quote the value (they read COMMERCIAL_DEFAULTS, never a second copy).
 *
 * Values are UNCHANGED from the inline literals they replace (verified
 * by `tests/commercial_url_catalog_2846.test.ts`):
 * - receipts list: default 50, cap 100 (`src/agents/routes/payments.ts`);
 * - transactions list: default 50, both modes (`src/agents/routes/payments.ts`);
 * - ledger payments list: default 50 (`src/agents/routes/agenticPayments.ts`).
 *
 * NOT here, by design: top-up bounds (operator-set via the billing
 * policy, never a code default); refund windows/proration (the
 * PROPOSED_SEED_POLICY store seed — an open owner decision); prices
 * (the price catalogue, #2668 — distinct from this config).
 */
import raw from "../../config/commercial-defaults.json";

export interface CommercialDefaults {
  /** Receipts list: rows returned when no `limit` query param is given (50). */
  receiptsDefaultLimit: number;
  /** Receipts list: hard cap applied to any requested `limit` (100). */
  receiptsMaxLimit: number;
  /** Transactions list: rows returned when no `limit` is given (50). */
  transactionsDefaultLimit: number;
  /** Ledger payments list: rows returned when no `limit` is given (50). */
  ledgerPaymentsDefaultLimit: number;
}

export const COMMERCIAL_DEFAULTS: CommercialDefaults = raw as CommercialDefaults;
