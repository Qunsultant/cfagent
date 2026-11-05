/**
 * Issue #3305 (sub-issue of #3241) — in-memory free-run counter.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 *
 * Seeding: when `allowances` is omitted, the adapter starts with
 * the decided default allowance (10 runs per product per month
 * for every family, the same values the D1 ensure writes). When
 * `allowances` is given — even empty — it is used exactly, so a
 * fail-closed test can build a counter with no allowances at
 * all (`new InMemoryFreeRunCounterAdapter({})`).
 *
 * consumeFreeRun mirrors the D1 adapter's contract: it checks
 * the cap, increments, and reports allowed only when the
 * increment landed. (Single-threaded here, so the boundary
 * race the D1 adapter guards with a conditional upsert cannot
 * occur; the return shape is identical so gate tests cannot
 * tell the adapters apart.)
 */
import {
  assertFreeRunAllowance,
  DEFAULT_FREE_RUN_ALLOWANCE,
  FREE_RUN_FAMILIES,
  type FreeRunConsumption,
  type FreeRunCounter,
  type FreeRunUsageInput,
} from "./freeRunCounterPorts";
import { assertPriceFamily, type PriceFamily } from "./priceCataloguePorts";

export class InMemoryFreeRunCounterAdapter implements FreeRunCounter {
  private allowances = new Map<PriceFamily, number>();
  private counts = new Map<string, number>();

  constructor(allowances?: Partial<Record<PriceFamily, number>>) {
    const seed: Partial<Record<PriceFamily, number>> =
      allowances ?? Object.fromEntries(FREE_RUN_FAMILIES.map((f) => [f, DEFAULT_FREE_RUN_ALLOWANCE]));
    for (const [family, runs] of Object.entries(seed)) {
      if (runs === undefined) continue;
      this.allowances.set(assertPriceFamily(family), assertFreeRunAllowance(runs));
    }
  }

  async getAllowance(family: string): Promise<number | null> {
    const value = this.allowances.get(family as PriceFamily);
    return value === undefined ? null : value;
  }

  async getUsed(input: FreeRunUsageInput): Promise<number> {
    const family = assertPriceFamily(input.family);
    return this.counts.get(this.key(input.login, family, input.month)) ?? 0;
  }

  async consumeFreeRun(input: FreeRunUsageInput): Promise<FreeRunConsumption> {
    const family = assertPriceFamily(input.family);
    const allowance = await this.getAllowance(family);
    if (allowance === null || allowance <= 0) {
      return { allowed: false, used: await this.getUsed({ ...input, family }), allowance };
    }
    const key = this.key(input.login, family, input.month);
    const used = this.counts.get(key) ?? 0;
    if (used >= allowance) return { allowed: false, used, allowance };
    this.counts.set(key, used + 1);
    return { allowed: true, used: used + 1, allowance };
  }

  async setAllowance(input: { family: unknown; runs: unknown }): Promise<number> {
    const family = assertPriceFamily(input.family);
    const runs = assertFreeRunAllowance(input.runs);
    this.allowances.set(family, runs);
    return runs;
  }

  private key(login: string, family: PriceFamily, month: string): string {
    return `${login}|${family}|${month}`;
  }
}
