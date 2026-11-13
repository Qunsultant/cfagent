/**
 * Issue #3307 (sub-issue of #3241), slice 1 — referral-code
 * ports, adapters, and issue/redeem services.
 *
 * A code is a bearer token that, redeemed by a verified login,
 * credits RUNS to that login's code-runs balance. Codes confer
 * runs only — never tier, never credits, never a price, never
 * access. The value is never stored (SHA-256 hash + display
 * prefix only); the plaintext is returned once, at issuance.
 *
 * Adapter tests run the same suite against the D1 adapter (over
 * a MockD1Database, node:sqlite — the slice0 pattern) and the
 * in-memory adapter, so a test that passes against one passes
 * against the other for the same inputs. Service tests run on
 * the in-memory adapters; the route tests run the same flows
 * over D1 end to end.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1ReferralCodeDb,
  D1CodeRedemptionAdapter,
  D1CodeRunsBalanceAdapter,
  D1ReferralCodeAdapter,
  D1ReferralCodeRuleAdapter,
  ensureReferralCodeSchema,
} from "../src/data/d1ReferralCodeAdapter";
import {
  InMemoryCodeRedemptionAdapter,
  InMemoryCodeRunsBalanceAdapter,
  InMemoryReferralCodeAdapter,
  InMemoryReferralCodeRuleAdapter,
} from "../src/data/inMemoryReferralCodeAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import {
  assertReferralCodeRuleInput,
  CROCKFORD_ALPHABET,
  displayPrefixForCodeValue,
  generateCodeValue,
  hashCodeValue,
  isCodeRedeemable,
  isTenantAdminForTenant,
  normalizeCodeValue,
  type CodeRedemptionStore,
  type CodeRunsBalancePort,
  type ReferralCodeRule,
  type ReferralCodeRuleStore,
  type ReferralCodeStore,
} from "../src/data/referralCodePorts";
import type { Membership } from "../src/security/authorization";
import {
  issueReferralCode,
  publicCodeView,
  redeemReferralCode,
  ReferralCodeCapExceededError,
  ReferralCodeCreditStuckError,
  ReferralCodeInvalidError,
  ReferralCodeRuleUnavailableError,
  ReferralCodeScopeRefusedError,
  type ReferralCodeServiceDeps,
} from "../src/services/referralCodes";

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

const NOW = 1_791_000_000_000;

function makeRule(overrides: Partial<ReferralCodeRule> = {}): ReferralCodeRule {
  return {
    id: "coderule-test-1",
    productId: "prod-per-run-stock",
    issuer: "platform_admin",
    runsPerCode: 5,
    reusable: false,
    expiryDays: 30,
    attributionMode: "ledger",
    maxRedemptionsPerCode: 1,
    maxRedemptionsPerLogin: 1,
    globalCap: null,
    redemptionCount: 0,
    active: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

interface Adapters {
  rules: ReferralCodeRuleStore;
  codes: ReferralCodeStore;
  redemptions: CodeRedemptionStore;
  balances: CodeRunsBalancePort;
}

async function makeAdapters(kind: "d1" | "memory"): Promise<Adapters> {
  if (kind === "d1") {
    const db = createD1ReferralCodeDb(new MockD1Database() as unknown as D1Database);
    await ensureReferralCodeSchema(db);
    return {
      rules: new D1ReferralCodeRuleAdapter(db),
      codes: new D1ReferralCodeAdapter(db),
      redemptions: new D1CodeRedemptionAdapter(db),
      balances: new D1CodeRunsBalanceAdapter(db),
    };
  }
  const rules = new InMemoryReferralCodeRuleAdapter();
  const codes = new InMemoryReferralCodeAdapter();
  // The global-cap increment lives on the rule row; the
  // in-memory code adapter reaches it through this seam.
  codes.ruleAdapter = rules;
  return {
    rules,
    codes,
    redemptions: new InMemoryCodeRedemptionAdapter(),
    balances: new InMemoryCodeRunsBalanceAdapter(),
  };
}

function makeDeps(adapters: Adapters, lifecycle?: ReferralCodeServiceDeps["lifecycle"]): ReferralCodeServiceDeps {
  return {
    rules: adapters.rules,
    codes: adapters.codes,
    redemptions: adapters.redemptions,
    balances: adapters.balances,
    lifecycle: lifecycle === undefined ? new InMemoryLifecycleAdapter() : lifecycle,
  };
}

describe("referral-code pure helpers", () => {
  it("normalizeCodeValue uppercases, strips dashes/spaces, and rejects anything else", () => {
    expect(normalizeCodeValue("0123-4567-89ab-cdef")).toBe("0123456789ABCDEF");
    expect(normalizeCodeValue(" 0123-4567-89AB-CDEF ")).toBe("0123456789ABCDEF");
    expect(() => normalizeCodeValue("too-short")).toThrow();
    expect(() => normalizeCodeValue("0123456789ABCDEI")).toThrow(); // I is not Crockford
    expect(() => normalizeCodeValue("0123456789ABCDEO")).toThrow(); // O is not Crockford
    expect(() => normalizeCodeValue(123)).toThrow();
  });

  it("generateCodeValue emits 16 Crockford chars in 4 groups, and two generations differ", () => {
    const first = generateCodeValue();
    const second = generateCodeValue();
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(first).not.toBe(second);
    expect(normalizeCodeValue(first)).toHaveLength(16);
  });

  it("hashCodeValue is deterministic, 64 hex chars, and collision-free across values", async () => {
    const a = await hashCodeValue("0123456789ABCDEF");
    const b = await hashCodeValue("0123456789ABCDEF");
    const c = await hashCodeValue("0123456789ABCDEG");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(c);
  });

  it("displayPrefixForCodeValue is the first group", () => {
    expect(displayPrefixForCodeValue("0123456789ABCDEF")).toBe("0123");
  });

  it("CROCKFORD_ALPHABET is 32 chars with no I, L, O, U", () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (const ch of ["I", "L", "O", "U"]) expect(CROCKFORD_ALPHABET).not.toContain(ch);
  });

  it("isCodeRedeemable requires an active rule, an unrevoked code, and a future expiry", () => {
    const code = { revokedAtMs: null, expiresAtMs: NOW + 1000 };
    expect(isCodeRedeemable(code, { active: true }, NOW)).toBe(true);
    expect(isCodeRedeemable(code, { active: false }, NOW)).toBe(false);
    expect(isCodeRedeemable(code, null, NOW)).toBe(false);
    expect(isCodeRedeemable({ ...code, revokedAtMs: NOW }, { active: true }, NOW)).toBe(false);
    expect(isCodeRedeemable({ ...code, expiresAtMs: NOW }, { active: true }, NOW)).toBe(false);
    expect(isCodeRedeemable({ ...code, expiresAtMs: null }, { active: true }, NOW)).toBe(true);
  });

  it("assertReferralCodeRuleInput defaults to the fail-closed shape", () => {
    const input = assertReferralCodeRuleInput({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
    });
    expect(input).toMatchObject({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      reusable: false,
      expiryDays: null,
      attributionMode: "ledger",
      maxRedemptionsPerCode: null,
      maxRedemptionsPerLogin: null,
      globalCap: null,
      active: false,
    });
    expect(() => assertReferralCodeRuleInput({ productId: "p", issuer: "platform_admin", runsPerCode: 0, attributionMode: "ledger" })).toThrow();
    expect(() => assertReferralCodeRuleInput({ productId: "p", issuer: "nobody", runsPerCode: 5, attributionMode: "ledger" })).toThrow();
    expect(() => assertReferralCodeRuleInput({ productId: "p", issuer: "platform_admin", runsPerCode: 5, attributionMode: "sideways" })).toThrow();
  });

  it("isTenantAdminForTenant mirrors the platform-admin shape, tenant-scoped", () => {
    const membership = (overrides: Partial<Membership> = {}): Membership => ({
      membershipId: "m1",
      internalUserId: "u1",
      tenantId: "t1",
      roleBindings: [
        {
          role: "tenant-admin",
          scope: "tenant",
          grantedBy: "op",
        },
      ],
      ...overrides,
    });
    expect(isTenantAdminForTenant([membership()], "t1", NOW)).toBe(true);
    expect(isTenantAdminForTenant([membership()], "t2", NOW)).toBe(false);
    expect(isTenantAdminForTenant([membership({ revokedAtMs: NOW })], "t1", NOW)).toBe(false);
    expect(
      isTenantAdminForTenant(
        [membership({ roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "op", expiresAtMs: NOW }] })],
        "t1",
        NOW,
      ),
    ).toBe(false);
    expect(
      isTenantAdminForTenant(
        [membership({ roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "op" }] })],
        "t1",
        NOW,
      ),
    ).toBe(false);
  });
});

describe.each(["d1", "memory"] as const)("referral-code adapters (%s)", (kind) => {
  it("upsertRule creates, then updates in place preserving id and redemption count", async () => {
    const a = await makeAdapters(kind);
    const created = await a.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      active: true,
    });
    expect(created.id).toBeTruthy();
    expect(created.active).toBe(true);
    expect(created.redemptionCount).toBe(0);
    const updated = await a.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 10,
      attributionMode: "none",
      active: false,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.runsPerCode).toBe(10);
    expect(updated.attributionMode).toBe("none");
    expect(updated.active).toBe(false);
    expect(updated.redemptionCount).toBe(0);
    expect(await a.rules.getRule("prod-per-run-stock", "platform_admin")).toEqual(updated);
    expect(await a.rules.getRule("prod-per-run-stock", "user")).toBeNull();
    expect(await a.rules.listRules("prod-per-run-stock")).toHaveLength(1);
  });

  it("createCode snapshots the rule terms and never stores the plaintext", async () => {
    const a = await makeAdapters(kind);
    const rule = makeRule();
    const { code, plaintext } = await a.codes.createCode({
      rule,
      kind: "referral",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: "op1",
      tenantScope: null,
      nowMs: NOW,
    });
    expect(plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(code.runs).toBe(5);
    expect(code.reusable).toBe(false);
    expect(code.expiresAtMs).toBe(NOW + 30 * 86_400_000);
    expect(code.displayPrefix).toBe(normalizeCodeValue(plaintext).slice(0, 4));
    expect(code.codeHash).toBe(await hashCodeValue(normalizeCodeValue(plaintext)));
    expect("plaintext" in code).toBe(false);
    expect(publicCodeView(code)).not.toHaveProperty("codeHash");
    const fetched = await a.codes.getCodeByHash(code.codeHash);
    expect(fetched?.id).toBe(code.id);
    expect((await a.codes.listCodes("prod-per-run-stock"))).toHaveLength(1);
    expect((await a.codes.listCodesByIssuerLogin("op1"))).toHaveLength(1);
    expect((await a.codes.listCodesByIssuerLogin("someone-else"))).toHaveLength(0);
  });

  it("revokeCode is idempotent and returns null for an unknown id", async () => {
    const a = await makeAdapters(kind);
    const { code } = await a.codes.createCode({
      rule: makeRule(),
      kind: "invite",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: null,
      tenantScope: null,
      nowMs: NOW,
    });
    expect(await a.codes.revokeCode("nope", NOW)).toBeNull();
    const revoked = await a.codes.revokeCode(code.id, NOW + 1000);
    expect(revoked?.revokedAtMs).toBe(NOW + 1000);
    const again = await a.codes.revokeCode(code.id, NOW + 2000);
    expect(again?.revokedAtMs).toBe(NOW + 1000);
  });

  it("incrementCapCounts enforces per-login, then per-code, then global — in order", async () => {
    const a = await makeAdapters(kind);
    const rule = await a.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      maxRedemptionsPerCode: 2,
      maxRedemptionsPerLogin: 1,
      globalCap: 3,
      active: true,
    });
    const { code } = await a.codes.createCode({
      rule,
      kind: "referral",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: "op1",
      tenantScope: null,
      nowMs: NOW,
    });
    const inc = (login: string) =>
      a.codes.incrementCapCounts({
        codeId: code.id,
        redeemerLogin: login,
        ruleId: rule.id,
        maxPerCode: rule.maxRedemptionsPerCode,
        maxPerLogin: rule.maxRedemptionsPerLogin,
        globalCap: rule.globalCap,
        nowMs: NOW,
      });
    // First login redeems: all three increments land.
    expect(await inc("u1")).toEqual({ ok: true });
    // Same login again: the per-login cap fails FIRST (before the per-code/global counts move).
    expect(await inc("u1")).toEqual({ ok: false, failed: "per_login" });
    // Second login: per-code is now at 1 of 2, global at 1 of 3 — lands.
    expect(await inc("u2")).toEqual({ ok: true });
    // Third login: per-code is now at its cap of 2 — fails per_code (global still has room).
    expect(await inc("u3")).toEqual({ ok: false, failed: "per_code" });
    const storedRule = await a.rules.getRule("prod-per-run-stock", "platform_admin");
    expect(storedRule?.redemptionCount).toBe(2);
  });

  it("incrementCapCounts with null caps never refuses", async () => {
    const a = await makeAdapters(kind);
    const rule = await a.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      active: true,
    });
    const { code } = await a.codes.createCode({
      rule,
      kind: "referral",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: "op1",
      tenantScope: null,
      nowMs: NOW,
    });
    for (let i = 0; i < 3; i++) {
      expect(
        await a.codes.incrementCapCounts({
          codeId: code.id,
          redeemerLogin: `u${i}`,
          ruleId: rule.id,
          maxPerCode: null,
          maxPerLogin: null,
          globalCap: null,
          nowMs: NOW,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("redemption store records, replays, counts, and lists per login", async () => {
    const a = await makeAdapters(kind);
    const first = await a.redemptions.recordRedemption({
      codeId: "code-1",
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      productId: "prod-per-run-stock",
      runsGranted: 5,
      attributionWritten: true,
      nowMs: NOW,
    });
    expect(await a.redemptions.findRedemption("code-1", "u1")).toEqual(first);
    expect(await a.redemptions.findRedemption("code-1", "u2")).toBeNull();
    expect(await a.redemptions.countRedemptionsByLogin("code-1", "u1")).toBe(1);
    expect(await a.redemptions.listRedemptionsForLogin("u1")).toHaveLength(1);
    expect(await a.redemptions.listRedemptionsForLogin("u2")).toHaveLength(0);
  });

  it("balance: unknown login reads 0, credits accumulate, spend is a single conditional decrement", async () => {
    const a = await makeAdapters(kind);
    expect(await a.balances.getBalance("u1")).toBe(0);
    expect(await a.balances.addCodeRuns("u1", 5)).toBe(5);
    expect(await a.balances.addCodeRuns("u1", 3)).toBe(8);
    expect(await a.balances.consumeCodeRun({ login: "u1" })).toEqual({ allowed: true, remaining: 7 });
    expect(await a.balances.consumeCodeRun({ login: "nobody" })).toEqual({ allowed: false, remaining: 0 });
  });
});

describe("migration 0066 — referral codes (#3307)", () => {
  it("ensureReferralCodeSchema alone on an empty store applies 0066 (with the 0058 chain) and is idempotent", async () => {
    const db = createD1ReferralCodeDb(new MockD1Database() as unknown as D1Database);
    const first = await ensureReferralCodeSchema(db);
    expect(first).toContain(66);
    const second = await ensureReferralCodeSchema(db);
    expect(second).toEqual([]);
    // The seed rules land INACTIVE with PROPOSED defaults — one
    // per per-run product x platform_admin issuer; no seed codes
    // or balances exist.
    const rules = new D1ReferralCodeRuleAdapter(db);
    for (const productId of [
      "prod-per-run-stock",
      "prod-per-run-goal",
      "prod-per-run-options",
      "prod-per-run-strategy",
    ]) {
      const rule = await rules.getRule(productId, "platform_admin");
      expect(rule).toMatchObject({
        productId,
        issuer: "platform_admin",
        runsPerCode: 5,
        reusable: false,
        expiryDays: 30,
        attributionMode: "ledger",
        maxRedemptionsPerCode: 1,
        maxRedemptionsPerLogin: 1,
        globalCap: null,
        active: false,
      });
    }
    expect(await rules.getRule("prod-per-run-stock", "user")).toBeNull();
    const codes = new D1ReferralCodeAdapter(db);
    expect(await codes.listCodes("prod-per-run-stock")).toHaveLength(0);
    const balances = new D1CodeRunsBalanceAdapter(db);
    expect(await balances.getBalance("anyone")).toBe(0);
  });
});

describe("issueReferralCode / redeemReferralCode services", () => {
  async function issued(deps: ReferralCodeServiceDeps, overrides: Record<string, unknown> = {}) {
    const rule = await deps.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      maxRedemptionsPerCode: 1,
      maxRedemptionsPerLogin: 1,
      globalCap: null,
      active: true,
      ...(overrides.rule as Record<string, unknown> | undefined),
    });
    void rule;
    return issueReferralCode(deps, {
      productId: "prod-per-run-stock",
      kind: "referral",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: "op1",
      tenantScope: null,
      nowMs: NOW,
      ...(overrides.issue as Record<string, unknown> | undefined),
    });
  }

  it("issue refuses a missing or inactive rule (fail-closed), and issues under an active rule", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    await expect(
      issueReferralCode(deps, {
        productId: "prod-per-run-stock",
        kind: "referral",
        issuerLogin: "op1",
        issuerKind: "platform_admin",
        referrerUserId: "op1",
        tenantScope: null,
        nowMs: NOW,
      }),
    ).rejects.toBeInstanceOf(ReferralCodeRuleUnavailableError);
    await deps.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      active: false,
    });
    await expect(
      issueReferralCode(deps, {
        productId: "prod-per-run-stock",
        kind: "referral",
        issuerLogin: "op1",
        issuerKind: "platform_admin",
        referrerUserId: "op1",
        tenantScope: null,
        nowMs: NOW,
      }),
    ).rejects.toBeInstanceOf(ReferralCodeRuleUnavailableError);
    await deps.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      active: true,
    });
    const { code, plaintext } = await issueReferralCode(deps, {
      productId: "prod-per-run-stock",
      kind: "referral",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: "op1",
      tenantScope: null,
      nowMs: NOW,
    });
    expect(code.productId).toBe("prod-per-run-stock");
    expect(code).not.toHaveProperty("codeHash");
    expect(await deps.codes.getCodeByHash(await hashCodeValue(normalizeCodeValue(plaintext)))).toBeTruthy();
  });

  it("issue enforces kind/referrer coherence (referral needs a referrer; invite forbids one)", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    await deps.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      active: true,
    });
    await expect(
      issueReferralCode(deps, {
        productId: "prod-per-run-stock",
        kind: "referral",
        issuerLogin: "op1",
        issuerKind: "platform_admin",
        referrerUserId: null,
        tenantScope: null,
        nowMs: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      issueReferralCode(deps, {
        productId: "prod-per-run-stock",
        kind: "invite",
        issuerLogin: "op1",
        issuerKind: "platform_admin",
        referrerUserId: "op1",
        tenantScope: null,
        nowMs: NOW,
      }),
    ).rejects.toThrow();
  });

  it("redeem credits the balance and writes a source=code attribution for referral+ledger", async () => {
    const adapters = await makeAdapters("memory");
    const lifecycle = new InMemoryLifecycleAdapter();
    const deps = makeDeps(adapters, lifecycle);
    const { plaintext } = await issued(deps);
    const result = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW + 1000,
    });
    expect(result.runsGranted).toBe(5);
    expect(result.replayed).toBe(false);
    expect(result.attributionWritten).toBe(true);
    expect(await deps.balances.getBalance("u1")).toBe(5);
    const attribution = await lifecycle.getAttribution("u1");
    expect(attribution).toMatchObject({ referrerUserId: "op1", referredUserId: "u1", source: "code" });
  });

  it("redeem is idempotent for a one-time code: replay returns the same redemption and never double-credits", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    const { plaintext } = await issued(deps);
    const first = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW + 1000,
    });
    const replay = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW + 2000,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.redemption.id).toBe(first.redemption.id);
    expect(replay.runsGranted).toBe(5);
    expect(await deps.balances.getBalance("u1")).toBe(5);
  });

  it("redeem of a reusable code by a second login credits again (per-login cap permitting)", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    const { plaintext } = await issued(deps, {
      rule: { reusable: true, maxRedemptionsPerCode: null, maxRedemptionsPerLogin: 2 },
    });
    const first = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW + 1000,
    });
    expect(first.replayed).toBe(false);
    const second = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW + 2000,
    });
    expect(second.replayed).toBe(false);
    expect(second.redemption.id).not.toBe(first.redemption.id);
    expect(await deps.balances.getBalance("u1")).toBe(10);
  });

  it("redeem refuses unknown, expired, revoked, and self codes with ONE generic error", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    const { plaintext } = await issued(deps);
    // Unknown value.
    await expect(
      redeemReferralCode(deps, { codeValue: "AAAA-BBBB-CCCC-DDDD", redeemerLogin: "u1", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);
    // Malformed value (not even Crockford-shaped).
    await expect(
      redeemReferralCode(deps, { codeValue: "not-a-code", redeemerLogin: "u1", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);
    // Self-redemption: the referrer (op1) may not redeem their own code.
    await expect(
      redeemReferralCode(deps, { codeValue: plaintext, redeemerLogin: "op1", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);
    // Expired: a code issued under a 1-day rule, redeemed on day 2.
    const short = await issued(deps, { rule: { expiryDays: 1 } });
    await expect(
      redeemReferralCode(deps, {
        codeValue: short.plaintext,
        redeemerLogin: "u1",
        redeemerTenantId: "t1",
        nowMs: NOW + 2 * 86_400_000,
      }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);
    // Revoked.
    const stored = await deps.codes.getCodeByHash(await hashCodeValue(normalizeCodeValue(plaintext)));
    await deps.codes.revokeCode(stored!.id, NOW);
    await expect(
      redeemReferralCode(deps, { codeValue: plaintext, redeemerLogin: "u1", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);
    // Disabled rule (deactivated after issuance — the operator kill-switch).
    const killable = await issued(deps);
    await deps.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 5,
      attributionMode: "ledger",
      maxRedemptionsPerCode: 1,
      maxRedemptionsPerLogin: 1,
      globalCap: null,
      active: false,
    });
    await expect(
      redeemReferralCode(deps, { codeValue: killable.plaintext, redeemerLogin: "u1", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeInvalidError);
  });

  it("redeem refuses a tenant-scoped code from any other tenant", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    const { plaintext } = await issued(deps, { issue: { tenantScope: "t1" } });
    await expect(
      redeemReferralCode(deps, { codeValue: plaintext, redeemerLogin: "u1", redeemerTenantId: "t2", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeScopeRefusedError);
    const ok = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW,
    });
    expect(ok.runsGranted).toBe(5);
  });

  it("redeem refuses with the cap error when the per-code cap is exhausted", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    const { plaintext } = await issued(deps, {
      rule: { reusable: true, maxRedemptionsPerCode: 1, maxRedemptionsPerLogin: null },
    });
    await redeemReferralCode(deps, { codeValue: plaintext, redeemerLogin: "u1", redeemerTenantId: "t1", nowMs: NOW });
    await expect(
      redeemReferralCode(deps, { codeValue: plaintext, redeemerLogin: "u2", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeCapExceededError);
    expect(await deps.balances.getBalance("u2")).toBe(0);
  });

  it("redeem never attributes an invite code, and never fails when attribution throws", async () => {
    const adapters = await makeAdapters("memory");
    const lifecycle = new InMemoryLifecycleAdapter();
    const deps = makeDeps(adapters, lifecycle);
    const { plaintext } = await issued(deps, { issue: { kind: "invite", referrerUserId: null } });
    const result = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW,
    });
    expect(result.attributionWritten).toBe(false);
    expect(await lifecycle.getAttribution("u1")).toBeNull();
    // A lifecycle port that throws on recordAttribution must not
    // fail the redemption (D8): the runs still land.
    const throwingLifecycle = {
      recordAttribution: async () => {
        throw new Error("lifecycle store down");
      },
    } as unknown as ReferralCodeServiceDeps["lifecycle"];
    const deps2 = makeDeps(await makeAdapters("memory"), throwingLifecycle);
    const second = await issued(deps2);
    const redeemed = await redeemReferralCode(deps2, {
      codeValue: second.plaintext,
      redeemerLogin: "u2",
      redeemerTenantId: "t1",
      nowMs: NOW,
    });
    expect(redeemed.attributionWritten).toBe(false);
    expect(await deps2.balances.getBalance("u2")).toBe(5);
  });

  it("redeem proceeds with no attribution when the lifecycle port is unbound", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters, null);
    const { plaintext } = await issued(deps);
    const result = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW,
    });
    expect(result.attributionWritten).toBe(false);
    expect(await deps.balances.getBalance("u1")).toBe(5);
  });

  it("redeem surfaces a stuck credit when the balance credit fails after the row is recorded", async () => {
    const adapters = await makeAdapters("memory");
    const failingBalances: CodeRunsBalancePort = {
      getBalance: (login: string) => adapters.balances.getBalance(login),
      addCodeRuns: async () => {
        throw new Error("balance store down");
      },
      consumeCodeRun: (input: { login: string }) => adapters.balances.consumeCodeRun(input),
    };
    const deps: ReferralCodeServiceDeps = {
      rules: adapters.rules,
      codes: adapters.codes,
      redemptions: adapters.redemptions,
      balances: failingBalances,
      lifecycle: new InMemoryLifecycleAdapter(),
    };
    const { plaintext } = await issued(deps);
    await expect(
      redeemReferralCode(deps, { codeValue: plaintext, redeemerLogin: "u1", redeemerTenantId: "t1", nowMs: NOW }),
    ).rejects.toBeInstanceOf(ReferralCodeCreditStuckError);
    // The redemption row stands (visible for operator reconcile);
    // the balance never landed.
    expect(await deps.redemptions.listRedemptionsForLogin("u1")).toHaveLength(1);
    expect(await adapters.balances.getBalance("u1")).toBe(0);
  });

  it("rule edits never reprice outstanding codes (terms are snapshotted at issuance)", async () => {
    const adapters = await makeAdapters("memory");
    const deps = makeDeps(adapters);
    const { plaintext } = await issued(deps);
    await deps.rules.upsertRule({
      productId: "prod-per-run-stock",
      issuer: "platform_admin",
      runsPerCode: 99,
      expiryDays: 1,
      attributionMode: "ledger",
      maxRedemptionsPerCode: 1,
      maxRedemptionsPerLogin: 1,
      globalCap: null,
      active: true,
    });
    const result = await redeemReferralCode(deps, {
      codeValue: plaintext,
      redeemerLogin: "u1",
      redeemerTenantId: "t1",
      nowMs: NOW + 10 * 86_400_000,
    });
    // The outstanding code still grants 5 runs and is still
    // unexpired (its 30-day snapshot), not the edited 99/1-day.
    expect(result.runsGranted).toBe(5);
  });
});
