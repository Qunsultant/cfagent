/**
 * Issue #2185 (sub-issue of #2012) — in-memory price catalogue.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 *
 * Seeding: when `initial` is omitted, the adapter starts with
 * the proposed seed prices as v1 rows (the same values the D1
 * ensure writes). When `initial` is given — even empty — it is
 * used exactly, so a fail-closed test can build a catalogue with
 * no prices at all (`new InMemoryPriceCatalogueAdapter({})`).
 *
 * Approval (#2547): seeded and set prices are PROPOSED, exactly
 * like the D1 adapter. The `approvedBy` constructor option is a
 * fixture convenience for gate tests: it records the seeded
 * entries as approved by that approver, the same state the D1
 * adapter reaches after an operator approvePrice call.
 *
 * Issue #3289: a catalogue row IS a version — the store holds
 * one version chain per family+segment, and setPrice creates a
 * new version instead of updating a row in place.
 */
import {
  assertApproverId,
  assertPriceFamily,
  assertPriceUSD,
  PRICE_FAMILIES,
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
  type PriceEntry,
  type PriceFamily,
} from "./priceCataloguePorts";
import {
  assertSegment,
  catalogueVersionId,
  DEFAULT_SEGMENT,
  perRunProductId,
  resolveEffectiveVersion,
} from "./productPorts";

export class InMemoryPriceCatalogueAdapter implements PriceCatalogue {
  private entries = new Map<string, PriceEntry>();

  constructor(initial?: Partial<Record<PriceFamily, number>>, options?: { approvedBy?: string }) {
    const seed: Partial<Record<PriceFamily, number>> = initial ?? { ...PROPOSED_SEED_PRICES };
    const approvedBy = options?.approvedBy !== undefined ? assertApproverId(options.approvedBy) : null;
    const now = Date.now();
    for (const [family, priceUSD] of Object.entries(seed)) {
      if (priceUSD === undefined) continue;
      const familyKey = assertPriceFamily(family);
      this.entries.set(catalogueVersionId(familyKey, DEFAULT_SEGMENT, 1), {
        id: catalogueVersionId(familyKey, DEFAULT_SEGMENT, 1),
        family: familyKey,
        priceUSD: assertPriceUSD(priceUSD),
        updatedAtMs: now,
        approvalStatus: approvedBy ? "approved" : "proposed",
        approvedBy,
        approvedAtMs: approvedBy ? now : null,
        productId: perRunProductId(familyKey),
        segment: DEFAULT_SEGMENT,
        version: 1,
        effectiveFromMs: now,
        effectiveToMs: null,
      });
    }
  }

  async getPrice(family: string, segment?: string): Promise<number | null> {
    const entry = await this.getEntry(family, segment);
    return entry ? entry.priceUSD : null;
  }

  async getEntry(family: string, segment?: string): Promise<PriceEntry | null> {
    const entry = await this.getEffectiveEntry(
      family,
      segment === undefined ? DEFAULT_SEGMENT : assertSegment(segment),
    );
    if (!entry) return null;
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) return null;
    return { ...entry };
  }

  async getApprovedPrice(family: string, segment?: string): Promise<number | null> {
    const entry = await this.getEntry(family, segment);
    if (!entry || entry.approvalStatus !== "approved") return null;
    return entry.priceUSD;
  }

  async getEffectiveEntry(family: string, segment: string, nowMs?: number): Promise<PriceEntry | null> {
    // Read path, fail-closed: an invalid family reads as no
    // effective entry (null), never a throw — the old getPrice
    // contract ("nope" → null) is preserved. The write path
    // (createVersion/setPrice) still validates the family.
    if (!(PRICE_FAMILIES as readonly string[]).includes(family)) return null;
    const familyKey = family as PriceFamily;
    const seg = assertSegment(segment);
    const versions = await this.listVersions(familyKey, seg);
    return resolveEffectiveVersion(versions, seg, nowMs ?? Date.now());
  }

  async getAllPrices(): Promise<PriceEntry[]> {
    // Issue #3289: the operator price list is the effective
    // version per family for the default segment — one row per
    // family, never a stale or future version.
    const byFamily = new Map<PriceFamily, PriceEntry[]>();
    for (const entry of this.entries.values()) {
      const list = byFamily.get(entry.family) ?? [];
      list.push(entry);
      byFamily.set(entry.family, list);
    }
    const effective: PriceEntry[] = [];
    for (const versions of byFamily.values()) {
      const resolved = resolveEffectiveVersion(versions, DEFAULT_SEGMENT, Date.now());
      if (resolved) effective.push({ ...resolved });
    }
    return effective.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  }

  async listVersions(family: string, segment?: string): Promise<PriceEntry[]> {
    const familyKey = assertPriceFamily(family);
    const productId = perRunProductId(familyKey);
    return [...this.entries.values()]
      .filter((e) => e.productId === productId && (segment === undefined || e.segment === segment))
      .sort(
        (a, b) =>
          a.effectiveFromMs - b.effectiveFromMs ||
          a.version - b.version ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((e) => ({ ...e }));
  }

  async createVersion(input: {
    family: PriceFamily;
    priceUSD: number;
    segment?: string;
    effectiveFromMs?: number;
    effectiveToMs?: number | null;
  }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const priceUSD = assertPriceUSD(input.priceUSD);
    const segment = input.segment === undefined ? DEFAULT_SEGMENT : assertSegment(input.segment);
    const effectiveFromMs = input.effectiveFromMs ?? Date.now();
    if (!Number.isFinite(effectiveFromMs) || effectiveFromMs < 0) {
      throw new Error("effectiveFromMs must be a non-negative epoch-ms number.");
    }
    const effectiveToMs = input.effectiveToMs ?? null;
    if (effectiveToMs !== null && (!Number.isFinite(effectiveToMs) || effectiveToMs <= effectiveFromMs)) {
      throw new Error("effectiveToMs must be an epoch-ms number after effectiveFromMs when present.");
    }
    const productId = perRunProductId(family);
    // Two versions may share an effectiveFromMs (same-ms
    // creation is a race, not a caller error — see the 0058
    // header note): the resolver tiebreaks ties by greatest
    // version, so the newest version wins. No bump: a version
    // created "effective now" must be effective now.
    const siblings = await this.listVersions(family, segment);
    const version = siblings.reduce((max, s) => Math.max(max, s.version), 0) + 1;
    const record: PriceEntry = {
      id: catalogueVersionId(family, segment, version),
      family,
      priceUSD,
      updatedAtMs: Date.now(),
      // #2547: a price write is a proposal; the new version
      // carries no approval.
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
      productId,
      segment,
      version,
      effectiveFromMs,
      effectiveToMs,
    };
    this.entries.set(record.id, record);
    return { ...record };
  }

  async setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry> {
    // Issue #3289: set a price = create a new version.
    return this.createVersion({
      family: assertPriceFamily(input.family),
      priceUSD: assertPriceUSD(input.priceUSD),
    });
  }

  async approvePrice(input: {
    family: unknown;
    approverId: unknown;
    segment?: unknown;
  }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const approverId = assertApproverId(input.approverId);
    const segment =
      input.segment === undefined || input.segment === null ? DEFAULT_SEGMENT : assertSegment(input.segment);
    // Issue #3289: approval targets the EFFECTIVE version for
    // the segment.
    const existing = await this.getEffectiveEntry(family, segment);
    if (!existing) {
      throw new Error(
        `No effective price for family ${family} in segment ${segment}: cannot approve a price that does not exist.`,
      );
    }
    const now = Date.now();
    const record: PriceEntry = {
      ...existing,
      approvalStatus: "approved",
      approvedBy: approverId,
      approvedAtMs: now,
      updatedAtMs: now,
    };
    this.entries.set(existing.id, record);
    return { ...record };
  }
}
