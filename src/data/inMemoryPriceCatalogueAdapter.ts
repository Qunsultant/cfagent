/**
 * Issue #2185 (sub-issue of #2012) — in-memory price catalogue.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 *
 * Seeding: when `initial` is omitted, the adapter starts with the
 * proposed seed prices (the same values the D1 ensure writes).
 * When `initial` is given — even empty — it is used exactly, so
 * a fail-closed test can build a catalogue with no prices at all
 * (`new InMemoryPriceCatalogueAdapter({})`).
 *
 * Approval (#2547): seeded and set prices are PROPOSED, exactly
 * like the D1 adapter. The `approvedBy` constructor option is a
 * fixture convenience for gate tests: it records the seeded
 * entries as approved by that approver, the same state the D1
 * adapter reaches after an operator approvePrice call.
 */
import {
  assertApproverId,
  assertPriceFamily,
  assertPriceUSD,
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
  type PriceEntry,
  type PriceFamily,
} from "./priceCataloguePorts";

export class InMemoryPriceCatalogueAdapter implements PriceCatalogue {
  private prices = new Map<PriceFamily, PriceEntry>();

  constructor(initial?: Partial<Record<PriceFamily, number>>, options?: { approvedBy?: string }) {
    const seed: Partial<Record<PriceFamily, number>> = initial ?? { ...PROPOSED_SEED_PRICES };
    const approvedBy = options?.approvedBy !== undefined ? assertApproverId(options.approvedBy) : null;
    const now = Date.now();
    for (const [family, priceUSD] of Object.entries(seed)) {
      if (priceUSD === undefined) continue;
      this.prices.set(assertPriceFamily(family), {
        family: assertPriceFamily(family),
        priceUSD: assertPriceUSD(priceUSD),
        updatedAtMs: now,
        approvalStatus: approvedBy ? "approved" : "proposed",
        approvedBy,
        approvedAtMs: approvedBy ? now : null,
      });
    }
  }

  async getPrice(family: string): Promise<number | null> {
    const entry = this.prices.get(family as PriceFamily);
    if (!entry) return null;
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) return null;
    return entry.priceUSD;
  }

  async getEntry(family: string): Promise<PriceEntry | null> {
    const entry = this.prices.get(family as PriceFamily);
    if (!entry) return null;
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) return null;
    return { ...entry };
  }

  async getApprovedPrice(family: string): Promise<number | null> {
    const entry = await this.getEntry(family);
    if (!entry || entry.approvalStatus !== "approved") return null;
    return entry.priceUSD;
  }

  async getAllPrices(): Promise<PriceEntry[]> {
    return [...this.prices.values()].sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  }

  async setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry> {
    // #2547: a price write is a proposal; any prior approval is cleared.
    const record: PriceEntry = {
      family: assertPriceFamily(input.family),
      priceUSD: assertPriceUSD(input.priceUSD),
      updatedAtMs: Date.now(),
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
    };
    this.prices.set(record.family, record);
    return { ...record };
  }

  async approvePrice(input: { family: unknown; approverId: unknown }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const approverId = assertApproverId(input.approverId);
    const existing = await this.getEntry(family);
    if (!existing) {
      throw new Error(`No stored price for family ${family}: cannot approve a price that does not exist.`);
    }
    const now = Date.now();
    const record: PriceEntry = {
      ...existing,
      approvalStatus: "approved",
      approvedBy: approverId,
      approvedAtMs: now,
      updatedAtMs: now,
    };
    this.prices.set(family, record);
    return { ...record };
  }
}
