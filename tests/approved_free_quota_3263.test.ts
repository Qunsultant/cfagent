// @vitest-environment node
/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — per-service quota
 * for approved-free accounts.
 *
 * Defaults (owner direction 2026-11-06, PROPOSED, operator-managed):
 * 10 runs per service per month, monthly window, at-limit per #3241
 * decision 4 (upgrade or buy credits). The defaults live ONLY as
 * migration 0055's seed rows — no code constant holds them. With no
 * operator override the 10/service/month default applies (the brief's
 * old absent-quota rule is replaced).
 *
 * Tenant scoping (#1069 §10): quota counts are keyed
 * (tenant_id, login, family, period) — a login's usage in Tenant A
 * never leaks to Tenant B and cannot be spent from Tenant B.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  ALL_MIGRATIONS,
  MIGRATION_0054_APPROVED_FREE_QUOTA,
  MIGRATION_0055_APPROVED_FREE_QUOTA_SEED,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  agentApprovedFreeQuotaCounts,
  agentApprovedFreeQuotaSettings,
  agentApprovedFreeQuotas,
} from "../src/data/drizzleSchema";
import {
  APPROVED_FREE_QUOTA_ERROR_CODES,
  ApprovedFreeQuotaError,
  approvedFreeQuotaPeriodKey,
  assertApprovedFreeQuotaAtLimitAction,
  assertApprovedFreeQuotaCap,
  assertApprovedFreeQuotaFamily,
  assertApprovedFreeQuotaSettings,
  assertApprovedFreeQuotaWindowKind,
  type ApprovedFreeQuota,
  type ApprovedFreeQuotaErrorKind,
  type ApprovedFreeQuotaSettings,
} from "../src/data/approvedFreeQuotaPorts";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
import {
  createD1ApprovedFreeQuotaDb,
  D1ApprovedFreeQuotaAdapter,
  ensureApprovedFreeQuotaSchema,
} from "../src/data/d1ApprovedFreeQuotaAdapter";
import { InMemoryApprovedFreeQuotaAdapter } from "../src/data/inMemoryApprovedFreeQuotaAdapter";

const NOV_15 = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOV_16 = Date.UTC(2026, 10, 16, 0, 0, 0);
const NOV_30_LATE = Date.UTC(2026, 10, 30, 23, 59, 59);
const DEC_1 = Date.UTC(2026, 11, 1, 0, 0, 0);

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

const DEFAULT_SETTINGS: ApprovedFreeQuotaSettings = {
  windowKind: "month",
  atLimitAction: "upgrade_or_buy_credits",
  updatedAtMs: 0,
  updatedBy: null,
};

describe("approved-free quota: period key (#3263)", () => {
  it("month is the UTC calendar month, YYYY-MM", () => {
    expect(approvedFreeQuotaPeriodKey(NOV_15, "month")).toBe("2026-11");
    expect(approvedFreeQuotaPeriodKey(NOV_30_LATE, "month")).toBe("2026-11");
    expect(approvedFreeQuotaPeriodKey(DEC_1, "month")).toBe("2026-12");
  });

  it("week is the ISO week, YYYY-Www, boundary Monday 00:00 UTC", () => {
    expect(approvedFreeQuotaPeriodKey(NOV_15, "week")).toBe("2026-W46");
    expect(approvedFreeQuotaPeriodKey(NOV_16, "week")).toBe("2026-W47");
    // The week spans the month boundary: Nov 30 and Dec 1 share W49.
    expect(approvedFreeQuotaPeriodKey(NOV_30_LATE, "week")).toBe("2026-W49");
    expect(approvedFreeQuotaPeriodKey(DEC_1, "week")).toBe("2026-W49");
    expect(approvedFreeQuotaPeriodKey(Date.UTC(2026, 0, 1, 0, 0, 0), "week")).toBe("2026-W01");
  });

  it("rejects an unknown window kind", () => {
    // AOP: the failure is a typed error carrying its catalog code —
    // the message is the catalog businessMessage, asserted FROM the
    // catalog, never a hardcoded string.
    expectQuotaError(() => approvedFreeQuotaPeriodKey(NOV_15, "fortnight" as never), "invalid_window");
    expectQuotaError(() => assertApprovedFreeQuotaWindowKind("day"), "invalid_window");
  });
});

/** Assert a sync throw is the typed quota error for its kind, with the catalog message. */
function expectQuotaError(fn: () => unknown, kind: ApprovedFreeQuotaErrorKind): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApprovedFreeQuotaError);
  const typed = caught as ApprovedFreeQuotaError;
  expect(typed.kind).toBe(kind);
  expect(typed.code).toBe(APPROVED_FREE_QUOTA_ERROR_CODES[kind]);
  expect(typed.message).toBe(resolveOutcome(typed.code).businessMessage);
}

describe("approved-free quota: settings validation (#3263)", () => {
  it("accepts the decided settings shape", () => {
    expect(assertApprovedFreeQuotaSettings({ windowKind: "month", atLimitAction: "upgrade_or_buy_credits" })).toEqual({
      windowKind: "month",
      atLimitAction: "upgrade_or_buy_credits",
    });
    expect(assertApprovedFreeQuotaSettings({ windowKind: "week", atLimitAction: "stop" })).toEqual({
      windowKind: "week",
      atLimitAction: "stop",
    });
  });

  it("rejects unknown window kinds and at-limit actions", () => {
    expectQuotaError(
      () => assertApprovedFreeQuotaSettings({ windowKind: "day", atLimitAction: "upgrade_or_buy_credits" }),
      "invalid_window",
    );
    expectQuotaError(
      () => assertApprovedFreeQuotaSettings({ windowKind: "month", atLimitAction: "checkout" }),
      "invalid_action",
    );
    expectQuotaError(() => assertApprovedFreeQuotaAtLimitAction("upgrade"), "invalid_action");
    expectQuotaError(() => assertApprovedFreeQuotaSettings(null), "invalid_settings");
    expectQuotaError(() => assertApprovedFreeQuotaFamily("nope"), "invalid_family");
  });

  it("rejects non-integer, negative, or non-numeric caps", () => {
    expect(assertApprovedFreeQuotaCap(10)).toBe(10);
    expect(assertApprovedFreeQuotaCap(0)).toBe(0);
    expectQuotaError(() => assertApprovedFreeQuotaCap(-1), "invalid_cap");
    expectQuotaError(() => assertApprovedFreeQuotaCap(1.5), "invalid_cap");
    expectQuotaError(() => assertApprovedFreeQuotaCap("10"), "invalid_cap");
  });
});

describe("approved-free quota: migration 0055 seed rows (#3263)", () => {
  it("is registered (position-independent containment)", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0055_APPROVED_FREE_QUOTA_SEED);
    expect(MIGRATION_0055_APPROVED_FREE_QUOTA_SEED.version).toBe(55);
    expect(MIGRATION_0055_APPROVED_FREE_QUOTA_SEED.name).toBe("0055_approved_free_quota_seed");
  });

  it("seeds every family at the decided default (10) with INSERT OR IGNORE, plus the default settings row", () => {
    const sql = MIGRATION_0055_APPROVED_FREE_QUOTA_SEED.sql;
    expect(sql).toContain("INSERT OR IGNORE INTO agent_approved_free_quotas");
    for (const family of ["stock", "goal", "options", "strategy"]) {
      expect(sql).toContain(`('${family}', 10, 0, NULL)`);
    }
    expect(sql).toContain("INSERT OR IGNORE INTO agent_approved_free_quota_settings");
    expect(sql).toContain(`('default', 'month', 'upgrade_or_buy_credits', 0, NULL)`);
  });
});

describe("approved-free quota: migration 0054 registration (#3263)", () => {
  it("is registered (position-independent containment)", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0054_APPROVED_FREE_QUOTA);
    expect(MIGRATION_0054_APPROVED_FREE_QUOTA.version).toBe(54);
    expect(MIGRATION_0054_APPROVED_FREE_QUOTA.name).toBe("0054_approved_free_quota");
  });

  it("DDL and the Drizzle schema agree on tables and columns", () => {
    const sql = MIGRATION_0054_APPROVED_FREE_QUOTA.sql;
    expect(sql).toContain("agent_approved_free_quotas");
    expect(sql).toContain("agent_approved_free_quota_counts");
    expect(sql).toContain("agent_approved_free_quota_settings");
    expect(Object.keys(getTableColumns(agentApprovedFreeQuotas))).toEqual([
      "family",
      "capRuns",
      "updatedAtMs",
      "updatedBy",
    ]);
    expect(Object.keys(getTableColumns(agentApprovedFreeQuotaCounts))).toEqual([
      "tenantId",
      "userLogin",
      "family",
      "period",
      "used",
      "updatedAtMs",
    ]);
    expect(Object.keys(getTableColumns(agentApprovedFreeQuotaSettings))).toEqual([
      "id",
      "windowKind",
      "atLimitAction",
      "updatedAtMs",
      "updatedBy",
    ]);
  });
});

async function consumeTimes(
  quota: ApprovedFreeQuota,
  n: number,
  input: { tenantId: string; login: string; family: string; period: string },
): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await quota.consumeQuotaRun(input)).allowed);
  }
  return out;
}

interface QuotaFixture {
  quota: ApprovedFreeQuota;
}

describe.each([
  [
    "D1",
    async (): Promise<QuotaFixture> => {
      const mock = new MockD1Database();
      const db = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
      await ensureApprovedFreeQuotaSchema(db);
      return { quota: new D1ApprovedFreeQuotaAdapter(db) };
    },
  ],
  [
    "in-memory",
    async (): Promise<QuotaFixture> => {
      // The in-memory adapter starts empty (no hardcoded defaults), so
      // the fixture passes the decided values explicitly — the seed
      // lives only as migration 0055's rows.
      return {
        quota: new InMemoryApprovedFreeQuotaAdapter({
          caps: { stock: 10, goal: 10, options: 10, strategy: 10 },
          settings: { windowKind: "month", atLimitAction: "upgrade_or_buy_credits" },
        }),
      };
    },
  ],
])("approved-free quota: port contract (%s)", (_label, makeFixture) => {
  it("seeds the decided default: cap 10 per family, monthly window, decision-4 at-limit", async () => {
    const { quota } = await makeFixture();
    expect(await quota.getCap("goal")).toBe(10);
    expect(await quota.getCap("stock")).toBe(10);
    expect(await quota.getSettings()).toMatchObject(DEFAULT_SETTINGS);
  });

  it("consume under the cap is allowed and counted; the 11th is refused and uncounted", async () => {
    const { quota } = await makeFixture();
    const input = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    expect(await consumeTimes(quota, 10, input)).toEqual(Array(10).fill(true));
    expect(await quota.getUsed(input)).toBe(10);
    const eleventh = await quota.consumeQuotaRun(input);
    expect(eleventh).toMatchObject({ allowed: false, used: 10, cap: 10, period: "2026-11" });
    expect(await quota.getUsed(input)).toBe(10);
  });

  it("the cap is per service: stock usage never spends goal quota", async () => {
    const { quota } = await makeFixture();
    const goal = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    const stock = { tenantId: "tenant-a", login: "u1", family: "stock", period: "2026-11" };
    await consumeTimes(quota, 10, goal);
    expect((await quota.consumeQuotaRun(goal)).allowed).toBe(false);
    expect((await quota.consumeQuotaRun(stock)).allowed).toBe(true);
    expect(await quota.getUsed(stock)).toBe(1);
  });

  it("counts are tenant-scoped (#1069): Tenant B starts at 0 and cannot spend Tenant A's quota", async () => {
    const { quota } = await makeFixture();
    const inA = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    const inB = { tenantId: "tenant-b", login: "u1", family: "goal", period: "2026-11" };
    await consumeTimes(quota, 10, inA);
    expect(await quota.getUsed(inA)).toBe(10);
    expect(await quota.getUsed(inB)).toBe(0);
    expect((await quota.consumeQuotaRun(inB)).allowed).toBe(true);
    expect(await quota.getUsed(inB)).toBe(1);
    expect(await quota.getUsed(inA)).toBe(10);
  });

  it("counts are per login: another login in the same tenant starts at 0", async () => {
    const { quota } = await makeFixture();
    const u1 = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    const u2 = { tenantId: "tenant-a", login: "u2", family: "goal", period: "2026-11" };
    await consumeTimes(quota, 10, u1);
    expect(await quota.getUsed(u2)).toBe(0);
    expect((await quota.consumeQuotaRun(u2)).allowed).toBe(true);
  });

  it("the cap resets in the next period and the old period stays at the cap", async () => {
    const { quota } = await makeFixture();
    const nov = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    const dec = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-12" };
    await consumeTimes(quota, 10, nov);
    expect((await quota.consumeQuotaRun(nov)).allowed).toBe(false);
    expect((await quota.consumeQuotaRun(dec)).allowed).toBe(true);
    expect(await quota.getUsed(dec)).toBe(1);
    expect(await quota.getUsed(nov)).toBe(10);
  });

  it("the cap is operator-changeable: lowering it to 2 caps the period at 2", async () => {
    const { quota } = await makeFixture();
    await quota.setCap({ family: "goal", capRuns: 2 });
    const input = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    expect(await consumeTimes(quota, 2, input)).toEqual([true, true]);
    expect((await quota.consumeQuotaRun(input)).allowed).toBe(false);
    expect(await quota.getCap("goal")).toBe(2);
  });

  it("settings are operator-changeable: week window + stop action round-trip", async () => {
    const { quota } = await makeFixture();
    const next = await quota.setSettings({ windowKind: "week", atLimitAction: "stop" });
    expect(next).toMatchObject({ windowKind: "week", atLimitAction: "stop" });
    expect(await quota.getSettings()).toMatchObject({ windowKind: "week", atLimitAction: "stop" });
  });

  it("a family with no cap row reads null (D1 without seeds / in-memory empty)", async () => {
    const { quota } = await makeFixture();
    // Both fixtures seed all four families; an unknown family proves the null read.
    expect(await quota.getCap("not-a-family" as never)).toBeNull();
  });
});

describe("approved-free quota: in-memory adapter starts empty (#3263)", () => {
  it("no caps and no settings without explicit values (no hardcoded defaults)", async () => {
    const quota = new InMemoryApprovedFreeQuotaAdapter();
    expect(await quota.getCap("goal")).toBeNull();
    expect(await quota.getSettings()).toBeNull();
    const denied = await quota.consumeQuotaRun({ tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" });
    expect(denied).toMatchObject({ allowed: false, used: 0, cap: null });
  });
});

describe("approved-free quota: D1 ensure (#3263)", () => {
  it("applies migrations 0054+0055 idempotently; an operator edit survives re-ensure", async () => {
    const mock = new MockD1Database();
    const db = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
    const applied = await ensureApprovedFreeQuotaSchema(db);
    expect(applied).toContain(54);
    expect(applied).toContain(55);
    const quota = new D1ApprovedFreeQuotaAdapter(db);
    await quota.setCap({ family: "goal", capRuns: 3 });
    const reapplied = await ensureApprovedFreeQuotaSchema(db);
    expect(reapplied).toEqual([]);
    expect(await quota.getCap("goal")).toBe(3);
    expect(await quota.getCap("stock")).toBe(10);
  });

  it("applyMigrations records both versions in _migrations", async () => {
    const mock = new MockD1Database();
    const db = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
    await ensureApprovedFreeQuotaSchema(db);
    const rows = (mock as unknown as { sqlite: DatabaseSync }).sqlite
      .prepare("SELECT version FROM _migrations WHERE version IN (54, 55) ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual([54, 55]);
  });
});

describe("approved-free quota: typed errors + port ensureSchema (AOP, #3263)", () => {
  it("a corrupt stored count reads as the typed corrupt_count error (D1)", async () => {
    const mock = new MockD1Database();
    const db = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
    await ensureApprovedFreeQuotaSchema(db);
    const quota = new D1ApprovedFreeQuotaAdapter(db);
    // A count row written outside the port with an invalid value.
    await db
      .insert(agentApprovedFreeQuotaCounts)
      .values({ tenantId: "tenant-a", userLogin: "u1", family: "goal", period: "2026-11", used: -1, updatedAtMs: 1 });
    const input = { tenantId: "tenant-a", login: "u1", family: "goal", period: "2026-11" };
    await expect(quota.getUsed(input)).rejects.toMatchObject({
      kind: "corrupt_count",
      code: "FAILURE_APPROVED_FREE_QUOTA_CORRUPT",
    });
    // The gate's consume path fails the same way (never counts from a corrupt row).
    await expect(quota.consumeQuotaRun(input)).rejects.toMatchObject({ kind: "corrupt_count" });
  });

  it("adapter writes reject invalid inputs with their typed kind (both adapters)", async () => {
    const mock = new MockD1Database();
    const db = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
    await ensureApprovedFreeQuotaSchema(db);
    const adapters: ApprovedFreeQuota[] = [
      new D1ApprovedFreeQuotaAdapter(db),
      new InMemoryApprovedFreeQuotaAdapter({
        caps: { goal: 10 },
        settings: { windowKind: "month", atLimitAction: "upgrade_or_buy_credits" },
      }),
    ];
    for (const quota of adapters) {
      await expect(quota.setCap({ family: "nope", capRuns: 5 })).rejects.toMatchObject({
        kind: "invalid_family",
        code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_FAMILY",
      });
      await expect(quota.setCap({ family: "goal", capRuns: -1 })).rejects.toMatchObject({
        kind: "invalid_cap",
        code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_CAP",
      });
      await expect(quota.setSettings({ windowKind: "year" })).rejects.toMatchObject({
        kind: "invalid_window",
        code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_WINDOW",
      });
      await expect(quota.setSettings({ atLimitAction: "refund" })).rejects.toMatchObject({
        kind: "invalid_action",
        code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_ACTION",
      });
    }
  });

  it("ensureSchema is a port method: D1 applies 0054+0055, in-memory is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
    const d1 = new D1ApprovedFreeQuotaAdapter(db);
    expect(await d1.ensureSchema()).toEqual([54, 55]);
    expect(await d1.ensureSchema()).toEqual([]);
    const memory = new InMemoryApprovedFreeQuotaAdapter();
    expect(await memory.ensureSchema()).toEqual([]);
  });
});
