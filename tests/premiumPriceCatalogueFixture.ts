/**
 * #5609 (G-7) — approved premium-price catalogue fixture for gate tests.
 *
 * The premium routes, MCP paid tools, and NLQ refusal resolve their
 * price from the price catalogue (getApprovedPrice). Test envs bind
 * no D1, so these suites resolve from this approved in-memory
 * catalogue instead — the REAL port semantics (approved vs proposed
 * vs missing), with the binding stubbed, never the price itself.
 *
 * The fixture holds PREMIUM families only (options-scan,
 * market-research, stock-signals), seeded from PROPOSED_SEED_PRICES
 * and approved by a test operator. A caller that asks for a per-run
 * family ("options") gets null — the premium price is never the
 * per-run price, and a wrong-family read fails closed here exactly
 * as it would against the real store.
 */
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { PROPOSED_SEED_PRICES } from "../src/data/priceCataloguePorts";

export const approvedPremiumCatalogue = new InMemoryPriceCatalogueAdapter(
  {
    "options-scan": PROPOSED_SEED_PRICES["options-scan"],
    "market-research": PROPOSED_SEED_PRICES["market-research"],
    "stock-signals": PROPOSED_SEED_PRICES["stock-signals"],
  },
  { approvedBy: "test-operator" },
);

function must(price: number | null, family: string): number {
  if (price === null) {
    throw new Error(`approved premium price missing for ${family} in test catalogue`);
  }
  return price;
}

/**
 * The approved premium prices, resolved from the catalogue (never
 * literals). Awaits the port reads once at module load; importing
 * test files read these synchronously.
 */
export const APPROVED_PREMIUM_PRICES = {
  "options-scan": must(
    await approvedPremiumCatalogue.getApprovedPrice("options-scan"),
    "options-scan",
  ),
  "market-research": must(
    await approvedPremiumCatalogue.getApprovedPrice("market-research"),
    "market-research",
  ),
  "stock-signals": must(
    await approvedPremiumCatalogue.getApprovedPrice("stock-signals"),
    "stock-signals",
  ),
} as const;
