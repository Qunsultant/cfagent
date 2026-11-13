/**
 * Issue #3307 (sub-issue of #3241), slice 1 — in-memory adapters
 * for the referral-code ports. Contract-mirror of the D1
 * adapter: same preconditions, same results, same error
 * semantics, so a test that passes against the in-memory
 * adapter passes against D1 for the same inputs. Stores carry
 * no seed rows — the migration's seed rules are D1-only; tests
 * that need a rule upsert one first (see
 * tests/referralCodeRoutes.test.ts).
 */
import {
  assertCodeRuns,
  assertReferralCodeRuleInput,
  assertReferrerForKind,
  displayPrefixForCodeValue,
  generateCodeValue,
  hashCodeValue,
  type CodeRedemption,
  type CodeRedemptionStore,
  type CodeRunsBalancePort,
  type CodeRunsConsumption,
  type ReferralCode,
  type ReferralCodeKind,
  type ReferralCodeRule,
  type ReferralCodeRuleStore,
  type ReferralCodeStore,
} from "./referralCodePorts";

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Referral-code rules held in memory. */
export class InMemoryReferralCodeRuleAdapter implements ReferralCodeRuleStore {
  private readonly rulesByKey = new Map<string, ReferralCodeRule>();

  private static key(productId: string, issuer: ReferralCodeRule["issuer"]): string {
    return `${productId}::${issuer}`;
  }

  async getRule(
    productId: string,
    issuer: ReferralCodeRule["issuer"],
  ): Promise<ReferralCodeRule | null> {
    return this.rulesByKey.get(InMemoryReferralCodeRuleAdapter.key(productId, issuer)) ?? null;
  }

  async listRules(productId: string): Promise<ReferralCodeRule[]> {
    return [...this.rulesByKey.values()]
      .filter((r) => r.productId === productId)
      .sort((a, b) => (a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : a.id.localeCompare(b.id)));
  }

  async upsertRule(input: {
    productId: unknown;
    issuer?: unknown;
    runsPerCode?: unknown;
    reusable?: unknown;
    expiryDays?: unknown;
    attributionMode?: unknown;
    maxRedemptionsPerCode?: unknown;
    maxRedemptionsPerLogin?: unknown;
    globalCap?: unknown;
    active?: unknown;
  }): Promise<ReferralCodeRule> {
    const validated = assertReferralCodeRuleInput(input);
    const now = Date.now();
    const key = InMemoryReferralCodeRuleAdapter.key(validated.productId, validated.issuer);
    const existing = this.rulesByKey.get(key);
    if (existing) {
      // Rule edits affect only codes issued AFTER the edit:
      // the id, the creation time, and the global redemption
      // count are preserved, never reset.
      const updated: ReferralCodeRule = { ...existing, ...validated, updatedAtMs: now };
      this.rulesByKey.set(key, updated);
      return updated;
    }
    const record: ReferralCodeRule = {
      id: randomId("coderule"),
      ...validated,
      redemptionCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.rulesByKey.set(key, record);
    return record;
  }

  /** Test seam: seed a rule directly (bypasses the assert). */
  seedRule(rule: ReferralCodeRule): void {
    this.rulesByKey.set(
      InMemoryReferralCodeRuleAdapter.key(rule.productId, rule.issuer),
      rule,
    );
  }

  /** Lookup by id — the global-cap increment's read leg. */
  findRuleById(id: string): ReferralCodeRule | null {
    return [...this.rulesByKey.values()].find((r) => r.id === id) ?? null;
  }

  /** The global-cap increment's write leg (called only after the cap check passed). */
  applyGlobalIncrement(id: string, nowMs: number): void {
    const rule = this.findRuleById(id);
    if (!rule) return;
    this.rulesByKey.set(InMemoryReferralCodeRuleAdapter.key(rule.productId, rule.issuer), {
      ...rule,
      redemptionCount: rule.redemptionCount + 1,
      updatedAtMs: nowMs,
    });
  }
}

/** Referral codes held in memory. */
export class InMemoryReferralCodeAdapter implements ReferralCodeStore {
  private readonly codesById = new Map<string, ReferralCode>();
  private readonly codesByHash = new Map<string, ReferralCode>();
  private readonly perLoginCounts = new Map<string, number>();

  private static countKey(codeId: string, redeemerLogin: string): string {
    return `${codeId}::${redeemerLogin}`;
  }

  async createCode(input: {
    rule: ReferralCodeRule;
    kind: ReferralCodeKind;
    issuerLogin: string;
    issuerKind: ReferralCodeRule["issuer"];
    referrerUserId: string | null;
    tenantScope: string | null;
    nowMs: number;
  }): Promise<{ code: ReferralCode; plaintext: string }> {
    const referrer = assertReferrerForKind(input.kind, input.referrerUserId);
    if (!input.issuerLogin.trim()) throw new Error("Referral code issuerLogin is required.");
    const expiresAtMs =
      input.rule.expiryDays === null ? null : input.nowMs + input.rule.expiryDays * 86_400_000;
    for (let attempt = 0; attempt < 5; attempt++) {
      const plaintext = generateCodeValue();
      const normalized = plaintext.replace(/-/g, "");
      const codeHash = await hashCodeValue(normalized);
      if (this.codesByHash.has(codeHash)) continue;
      const record: ReferralCode = {
        id: randomId("code"),
        codeHash,
        displayPrefix: displayPrefixForCodeValue(normalized),
        ruleId: input.rule.id,
        productId: input.rule.productId,
        kind: input.kind,
        issuerLogin: input.issuerLogin,
        issuerKind: input.issuerKind,
        referrerUserId: referrer,
        tenantScope: input.tenantScope,
        runs: input.rule.runsPerCode,
        reusable: input.rule.reusable,
        expiresAtMs,
        revokedAtMs: null,
        redemptionCount: 0,
        createdAtMs: input.nowMs,
      };
      this.codesById.set(record.id, record);
      this.codesByHash.set(record.codeHash, record);
      return { code: record, plaintext };
    }
    throw new Error("Failed to issue referral code after 5 attempts.");
  }

  async getCode(id: string): Promise<ReferralCode | null> {
    return this.codesById.get(id) ?? null;
  }

  async getCodeByHash(codeHash: string): Promise<ReferralCode | null> {
    return this.codesByHash.get(codeHash) ?? null;
  }

  async listCodes(productId: string): Promise<ReferralCode[]> {
    return [...this.codesById.values()]
      .filter((c) => c.productId === productId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
  }

  async listCodesByIssuerLogin(issuerLogin: string): Promise<ReferralCode[]> {
    return [...this.codesById.values()]
      .filter((c) => c.issuerLogin === issuerLogin)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
  }

  async revokeCode(codeId: string, nowMs: number): Promise<ReferralCode | null> {
    const code = this.codesById.get(codeId);
    if (!code) return null;
    if (code.revokedAtMs !== null) return code;
    const revoked: ReferralCode = { ...code, revokedAtMs: nowMs };
    this.codesById.set(codeId, revoked);
    this.codesByHash.set(code.codeHash, revoked);
    return revoked;
  }

  /**
   * The three conditional increments, in order (per-login,
   * per-code, global). The FIRST failed increment stops the
   * sequence; increments that already landed stand (documented
   * residual — caps err toward refusal). The global count lives
   * on the rule row; the caller passes the rule through the
   * optional rule adapter so the in-memory store can update it
   * without a store-to-store dependency in the interface.
   */
  async incrementCapCounts(input: {
    codeId: string;
    redeemerLogin: string;
    ruleId: string;
    maxPerCode: number | null;
    maxPerLogin: number | null;
    globalCap: number | null;
    nowMs: number;
  }): Promise<{ ok: true } | { ok: false; failed: "per_login" | "per_code" | "global" }> {
    // (a) Per-login.
    if (input.maxPerLogin !== null) {
      const key = InMemoryReferralCodeAdapter.countKey(input.codeId, input.redeemerLogin);
      const before = this.perLoginCounts.get(key) ?? 0;
      if (before >= input.maxPerLogin) return { ok: false, failed: "per_login" };
      this.perLoginCounts.set(key, before + 1);
    }
    // (b) Per-code.
    if (input.maxPerCode !== null) {
      const code = this.codesById.get(input.codeId);
      if (!code) return { ok: false, failed: "per_code" };
      if (code.redemptionCount >= input.maxPerCode) return { ok: false, failed: "per_code" };
      const updated: ReferralCode = {
        ...code,
        redemptionCount: code.redemptionCount + 1,
      };
      this.codesById.set(code.id, updated);
      this.codesByHash.set(code.codeHash, updated);
    }
    // (c) Global: the rule row is owned by the rule adapter;
    // the caller (redeem service) resolves the rule and applies
    // the increment through the rule adapter's shared instance
    // (see InMemoryReferralCodeRuleAdapter.applyGlobalIncrement).
    if (input.globalCap !== null) {
      const rule = this.ruleAdapter?.findRuleById(input.ruleId);
      if (!rule) return { ok: false, failed: "global" };
      if (rule.redemptionCount >= input.globalCap) return { ok: false, failed: "global" };
      this.ruleAdapter?.applyGlobalIncrement(input.ruleId, input.nowMs);
    }
    return { ok: true };
  }

  /**
   * The rule adapter sharing this in-memory store (set by the
   * composition root / test harness). Only the global-cap
   * increment needs it — the rule's redemption_count is the
   * rule row's, not the code store's.
   */
  ruleAdapter?: {
    findRuleById(id: string): ReferralCodeRule | null;
    applyGlobalIncrement(id: string, nowMs: number): void;
  };
}

/** Code redemptions held in memory. */
export class InMemoryCodeRedemptionAdapter implements CodeRedemptionStore {
  private readonly redemptions: CodeRedemption[] = [];

  async findRedemption(codeId: string, redeemerLogin: string): Promise<CodeRedemption | null> {
    const matches = this.redemptions
      .filter((r) => r.codeId === codeId && r.redeemerLogin === redeemerLogin)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
    return matches.length === 0 ? null : matches[0];
  }

  async recordRedemption(input: {
    codeId: string;
    redeemerLogin: string;
    redeemerTenantId: string;
    productId: string;
    runsGranted: number;
    attributionWritten: boolean;
    nowMs: number;
  }): Promise<CodeRedemption> {
    const record: CodeRedemption = {
      id: randomId("red"),
      codeId: input.codeId,
      redeemerLogin: input.redeemerLogin,
      redeemerTenantId: input.redeemerTenantId,
      productId: input.productId,
      runsGranted: input.runsGranted,
      attributionWritten: input.attributionWritten,
      createdAtMs: input.nowMs,
    };
    this.redemptions.push(record);
    return record;
  }

  async countRedemptionsByLogin(codeId: string, login: string): Promise<number> {
    return this.redemptions.filter((r) => r.codeId === codeId && r.redeemerLogin === login)
      .length;
  }

  async listRedemptionsForLogin(login: string): Promise<CodeRedemption[]> {
    return this.redemptions
      .filter((r) => r.redeemerLogin === login)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
  }
}

/** Code-runs balances held in memory. */
export class InMemoryCodeRunsBalanceAdapter implements CodeRunsBalancePort {
  private readonly balances = new Map<string, number>();

  async getBalance(login: string): Promise<number> {
    return this.balances.get(login) ?? 0;
  }

  async addCodeRuns(login: string, runs: number): Promise<number> {
    if (!login.trim()) throw new Error("Code-runs login must be a non-empty string.");
    const validatedRuns = assertCodeRuns(runs);
    const next = (this.balances.get(login.trim()) ?? 0) + validatedRuns;
    this.balances.set(login.trim(), next);
    return next;
  }

  async consumeCodeRun(input: { login: string }): Promise<CodeRunsConsumption> {
    const login = input.login.trim();
    if (!login) throw new Error("Code-runs login must be a non-empty string.");
    const current = this.balances.get(login) ?? 0;
    if (current <= 0) return { allowed: false, remaining: current };
    this.balances.set(login, current - 1);
    return { allowed: true, remaining: current - 1 };
  }
}
