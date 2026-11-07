/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — in-memory
 * approved-free quota.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 *
 * Seeding: there is none. When `caps` / `settings` are omitted the
 * adapter starts EMPTY — a family with no row reads null and
 * settings read null (fail-closed, exactly like the D1 adapter on
 * a store with no seed rows). Callers pass explicit values
 * (`new InMemoryApprovedFreeQuotaAdapter({ caps: { goal: 10 },
 * settings: { windowKind: "month", atLimitAction:
 * "upgrade_or_buy_credits" } })`); a fail-closed test builds a
 * quota with no values at all (no argument). No quota number,
 * window, or at-limit action is hardcoded anywhere in this module:
 * the decided defaults live only as migration 0055's rows.
 *
 * consumeQuotaRun mirrors the D1 adapter's contract: it checks the
 * cap, increments, and reports allowed only when the increment
 * landed. (Single-threaded here, so the boundary race the D1
 * adapter guards with a conditional upsert cannot occur; the
 * return shape is identical so gate tests cannot tell the adapters
 * apart.)
 */
import {
  ApprovedFreeQuotaError,
  assertApprovedFreeQuotaAtLimitAction,
  assertApprovedFreeQuotaCap,
  assertApprovedFreeQuotaFamily,
  assertApprovedFreeQuotaSettings,
  assertApprovedFreeQuotaWindowKind,
  assertTenantLogin,
  type ApprovedFreeQuota,
  type ApprovedFreeQuotaConsumption,
  type ApprovedFreeQuotaSettings,
  type ApprovedFreeQuotaUsageInput,
} from "./approvedFreeQuotaPorts";
import { type PriceFamily } from "./priceCataloguePorts";

export interface InMemoryApprovedFreeQuotaSeed {
  caps?: Partial<Record<PriceFamily, number>>;
  settings?: {
    windowKind: ApprovedFreeQuotaSettings["windowKind"];
    atLimitAction: ApprovedFreeQuotaSettings["atLimitAction"];
    updatedBy?: string | null;
  };
}

export class InMemoryApprovedFreeQuotaAdapter implements ApprovedFreeQuota {
  private caps = new Map<PriceFamily, number>();
  private counts = new Map<string, number>();
  private settings: ApprovedFreeQuotaSettings | null = null;

  constructor(seed?: InMemoryApprovedFreeQuotaSeed) {
    for (const [family, capRuns] of Object.entries(seed?.caps ?? {})) {
      if (capRuns === undefined) continue;
      this.caps.set(assertApprovedFreeQuotaFamily(family), assertApprovedFreeQuotaCap(capRuns));
    }
    if (seed?.settings) {
      const parsed = assertApprovedFreeQuotaSettings(seed.settings);
      this.settings = { ...parsed, updatedAtMs: 0, updatedBy: seed.settings.updatedBy ?? null };
    }
  }

  /** Port method: no SQL to migrate — a no-op returning no applied versions. */
  async ensureSchema(): Promise<number[]> {
    return [];
  }

  async getCap(family: string): Promise<number | null> {
    const value = this.caps.get(family as PriceFamily);
    return value === undefined ? null : value;
  }

  async getUsed(input: ApprovedFreeQuotaUsageInput): Promise<number> {
    assertTenantLogin(input);
    const family = assertApprovedFreeQuotaFamily(input.family);
    return this.counts.get(this.key(input.tenantId, input.login, family, input.period)) ?? 0;
  }

  async getSettings(): Promise<ApprovedFreeQuotaSettings | null> {
    return this.settings;
  }

  async consumeQuotaRun(input: ApprovedFreeQuotaUsageInput): Promise<ApprovedFreeQuotaConsumption> {
    assertTenantLogin(input);
    const family = assertApprovedFreeQuotaFamily(input.family);
    const cap = await this.getCap(family);
    if (cap === null || cap <= 0) {
      return { allowed: false, used: await this.getUsed({ ...input, family }), cap, period: input.period };
    }
    const key = this.key(input.tenantId, input.login, family, input.period);
    const used = this.counts.get(key) ?? 0;
    if (used >= cap) return { allowed: false, used, cap, period: input.period };
    this.counts.set(key, used + 1);
    return { allowed: true, used: used + 1, cap, period: input.period };
  }

  async setCap(input: { family: unknown; capRuns: unknown; updatedBy?: unknown }): Promise<number> {
    const family = assertApprovedFreeQuotaFamily(input.family);
    const capRuns = assertApprovedFreeQuotaCap(input.capRuns);
    this.caps.set(family, capRuns);
    return capRuns;
  }

  async setSettings(input: {
    windowKind?: unknown;
    atLimitAction?: unknown;
    updatedBy?: unknown;
  }): Promise<ApprovedFreeQuotaSettings> {
    const windowKind =
      input.windowKind === undefined
        ? this.settings?.windowKind
        : assertApprovedFreeQuotaWindowKind(input.windowKind);
    const atLimitAction =
      input.atLimitAction === undefined
        ? this.settings?.atLimitAction
        : assertApprovedFreeQuotaAtLimitAction(input.atLimitAction);
    if (windowKind === undefined || atLimitAction === undefined) {
      throw new ApprovedFreeQuotaError("invalid_settings");
    }
    const updatedBy =
      typeof input.updatedBy === "string" ? input.updatedBy : (this.settings?.updatedBy ?? null);
    this.settings = { windowKind, atLimitAction, updatedAtMs: Date.now(), updatedBy };
    return this.settings;
  }

  private key(tenantId: string, login: string, family: PriceFamily, period: string): string {
    return `${tenantId}|${login}|${family}|${period}`;
  }
}
