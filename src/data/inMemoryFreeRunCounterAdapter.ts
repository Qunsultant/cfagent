/**
 * Issue #3305 (sub-issue of #3241) — in-memory free-run counter.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 *
 * Seeding: there is none. When `allowances` is omitted the
 * adapter starts EMPTY — a family with no row reads null
 * (fail-closed, exactly like the D1 adapter on a store with no
 * seed rows). Callers pass explicit allowances
 * (`new InMemoryFreeRunCounterAdapter({ goal: 10 })`); a
 * fail-closed test builds a counter with no allowances at all
 * (`new InMemoryFreeRunCounterAdapter({})` or no argument).
 * No allowance value is hardcoded anywhere in this module:
 * the decided seed lives only as migration 0044's rows.
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
  type FreeRunConsumption,
  type FreeRunCounter,
  type FreeRunUsageInput,
} from "./freeRunCounterPorts";
import { assertPriceFamily, type PriceFamily } from "./priceCataloguePorts";

export class InMemoryFreeRunCounterAdapter implements FreeRunCounter {
  private allowances = new Map<PriceFamily, number>();
  private counts = new Map<string, number>();

  constructor(allowances?: Partial<Record<PriceFamily, number>>) {
    for (const [family, runs] of Object.entries(allowances ?? {})) {
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
