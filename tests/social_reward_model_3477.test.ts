/**
 * Issue #3477 — social reward model + ledger alignment.
 *
 * The model layer the whole #3476 program runs on, as pure rules:
 * reward types mapped onto existing mechanisms, accumulation /
 * expiry / daily+monthly-cap rules as externalized config, stacking
 * rules, tenant scoping, abuse guards. Every value is owner/CBO
 * decided and unset (null) until configured — the model is
 * fail-closed when unconfigured, and no value is hardcoded here.
 *
 * No store, no routes, no UI in this slice: the grant record shape
 * is defined here and its store arrives in a later slice. These
 * tests pin the rules; they import the same pure functions the
 * future call sites will use.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/outcomes/outcomeCatalog.json";
import { freeRunMonthKey } from "../src/data/freeRunCounterPorts";
import { digestDayKey } from "../src/data/lifecyclePorts";
import {
  allocateSocialCreditRedemption,
  allocateSocialRunRedemption,
  assertSocialActionSupported,
  assertSocialGrantParties,
  assertSocialRewardTenant,
  evaluateSocialCaps,
  isGrantExpired,
  isGrantVested,
  redeemableGrants,
  requireVerifiedSocialAction,
  resolveFreeMonthEligibility,
  resolveRunCoverage,
  resolveSocialRewardAvailability,
  SOCIAL_REWARD_OUTCOME_CODES,
  socialRewardGrantId,
  validateSocialRewardConfig,
  type SocialRewardConfig,
  type SocialRewardGrant,
} from "../src/data/socialRewardModel";
import { SOCIAL_REWARD_CONFIG } from "../src/config/socialRewardLimits";

const catalogOutcomes = (
  catalog as { outcomes: Record<string, { outcome: string }> }
).outcomes;

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function fullConfig(): SocialRewardConfig {
  return {
    credit: {
      enabled: true,
      vestingDelayMs: 7 * DAY_MS,
      expiryWindowMs: 30 * DAY_MS,
      dailyCap: 2,
      monthlyCap: 10,
      amountUSD: 5,
      runs: null,
    },
    "free-runs": {
      enabled: true,
      vestingDelayMs: 0,
      expiryWindowMs: 30 * DAY_MS,
      dailyCap: 1,
      monthlyCap: 5,
      amountUSD: null,
      runs: 3,
    },
    "free-month": {
      enabled: true,
      vestingDelayMs: 0,
      expiryWindowMs: 90 * DAY_MS,
      dailyCap: 1,
      monthlyCap: 1,
      amountUSD: null,
      runs: null,
    },
  };
}

function grant(overrides: Partial<SocialRewardGrant> = {}): SocialRewardGrant {
  return {
    id: "social:user-1:credit:like:facebook:2026-11-07",
    userId: "user-1",
    tenantId: "tenant-1",
    type: "credit",
    action: "like",
    platform: "facebook",
    amountUSD: 5,
    runs: null,
    redeemedAmountUSD: 0,
    redeemedRuns: 0,
    grantedAtMs: NOW - 10 * DAY_MS,
    vestedAtMs: NOW - 3 * DAY_MS,
    expiresAtMs: NOW + 20 * DAY_MS,
    redeemedAtMs: null,
    redeemedFor: null,
    ...overrides,
  };
}

describe("social reward config validation (#3477)", () => {
  it("accepts the all-null (unconfigured) config", () => {
    const validated = validateSocialRewardConfig({
      credit: {
        enabled: null,
        vestingDelayMs: null,
        expiryWindowMs: null,
        dailyCap: null,
        monthlyCap: null,
        amountUSD: null,
        runs: null,
      },
      "free-runs": {
        enabled: null,
        vestingDelayMs: null,
        expiryWindowMs: null,
        dailyCap: null,
        monthlyCap: null,
        amountUSD: null,
        runs: null,
      },
      "free-month": {
        enabled: null,
        vestingDelayMs: null,
        expiryWindowMs: null,
        dailyCap: null,
        monthlyCap: null,
        amountUSD: null,
        runs: null,
      },
    });
    expect(validated.credit.enabled).toBeNull();
    expect(validated["free-runs"].runs).toBeNull();
  });

  it("accepts a fully configured config unchanged", () => {
    expect(validateSocialRewardConfig(fullConfig())).toEqual(fullConfig());
  });

  it("rejects a non-positive or non-finite credit amount", () => {
    const bad = fullConfig();
    bad.credit.amountUSD = 0;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
    bad.credit.amountUSD = -1;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
    bad.credit.amountUSD = Number.NaN;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
  });

  it("rejects a non-integer or negative vesting delay and a non-positive expiry window", () => {
    const bad = fullConfig();
    bad.credit.vestingDelayMs = -1;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
    bad.credit.vestingDelayMs = 1.5;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
    bad.credit.expiryWindowMs = 0;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
  });

  it("rejects non-integer or non-positive caps", () => {
    const bad = fullConfig();
    bad.credit.dailyCap = 0;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
    bad.credit.monthlyCap = 1.5;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
  });

  it("rejects an amount on free-runs and runs on credit (cross-field misuse)", () => {
    const bad = fullConfig();
    bad["free-runs"].amountUSD = 5;
    expect(() => validateSocialRewardConfig(bad)).toThrow();
    const bad2 = fullConfig();
    bad2.credit.runs = 2;
    expect(() => validateSocialRewardConfig(bad2)).toThrow();
    const bad3 = fullConfig();
    bad3["free-month"].amountUSD = 1;
    expect(() => validateSocialRewardConfig(bad3)).toThrow();
  });

  it("rejects unknown types and missing type blocks", () => {
    expect(() => validateSocialRewardConfig({})).toThrow();
    expect(() => validateSocialRewardConfig(null)).toThrow();
    const bad = fullConfig() as unknown as Record<string, unknown>;
    bad.credit = "nope";
    expect(() => validateSocialRewardConfig(bad)).toThrow();
  });

  it("the shipped config file is the all-null (unconfigured) config", () => {
    expect(SOCIAL_REWARD_CONFIG.credit.amountUSD).toBeNull();
    expect(SOCIAL_REWARD_CONFIG.credit.dailyCap).toBeNull();
    expect(SOCIAL_REWARD_CONFIG["free-runs"].runs).toBeNull();
    expect(SOCIAL_REWARD_CONFIG["free-month"].expiryWindowMs).toBeNull();
  });
});

describe("social reward availability — fail-closed (#3477)", () => {
  it("unconfigured config is unavailable with the not-configured code", () => {
    const config = validateSocialRewardConfig({
      credit: {
        enabled: null,
        vestingDelayMs: null,
        expiryWindowMs: null,
        dailyCap: null,
        monthlyCap: null,
        amountUSD: null,
        runs: null,
      },
      "free-runs": {
        enabled: null,
        vestingDelayMs: null,
        expiryWindowMs: null,
        dailyCap: null,
        monthlyCap: null,
        amountUSD: null,
        runs: null,
      },
      "free-month": {
        enabled: null,
        vestingDelayMs: null,
        expiryWindowMs: null,
        dailyCap: null,
        monthlyCap: null,
        amountUSD: null,
        runs: null,
      },
    });
    expect(resolveSocialRewardAvailability(config, "credit")).toEqual({
      available: false,
      code: "FAILURE_SOCIAL_REWARD_NOT_CONFIGURED",
    });
    expect(resolveSocialRewardAvailability(config, "free-runs")).toEqual({
      available: false,
      code: "FAILURE_SOCIAL_REWARD_NOT_CONFIGURED",
    });
  });

  it("enabled:false is unavailable even with values set", () => {
    const config = fullConfig();
    config.credit.enabled = false;
    expect(
      resolveSocialRewardAvailability(config, "credit").available,
    ).toBe(false);
  });

  it("a missing required value is unavailable", () => {
    const config = fullConfig();
    config["free-runs"].dailyCap = null;
    expect(
      resolveSocialRewardAvailability(config, "free-runs").available,
    ).toBe(false);
  });

  it("a fully configured, enabled type is available", () => {
    expect(
      resolveSocialRewardAvailability(fullConfig(), "credit"),
    ).toEqual({ available: true, code: null });
  });
});

describe("social grant vesting and expiry (#3477)", () => {
  it("a grant vests exactly at vestedAtMs", () => {
    expect(isGrantVested(grant({ vestedAtMs: NOW }), NOW)).toBe(true);
    expect(isGrantVested(grant({ vestedAtMs: NOW + 1 }), NOW)).toBe(false);
  });

  it("a grant expires exactly at expiresAtMs", () => {
    expect(isGrantExpired(grant({ expiresAtMs: NOW }), NOW)).toBe(true);
    expect(isGrantExpired(grant({ expiresAtMs: NOW + 1 }), NOW)).toBe(false);
  });

  it("redeemable grants are vested, unexpired, unredeemed — oldest first", () => {
    const older = grant({
      id: "a",
      grantedAtMs: NOW - 10 * DAY_MS,
      vestedAtMs: NOW - 3 * DAY_MS,
    });
    const newer = grant({
      id: "b",
      grantedAtMs: NOW - 5 * DAY_MS,
      vestedAtMs: NOW - 1 * DAY_MS,
    });
    const unvested = grant({ id: "c", vestedAtMs: NOW + DAY_MS });
    const expired = grant({ id: "d", expiresAtMs: NOW - 1 });
    const redeemed = grant({
      id: "e",
      redeemedAmountUSD: 5,
      redeemedAtMs: NOW - 1,
      redeemedFor: "run-1",
    });
    expect(
      redeemableGrants([newer, expired, older, redeemed, unvested], "credit", NOW).map(
        (g) => g.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("redeemable grants filter by type", () => {
    const runs = grant({
      id: "r",
      type: "free-runs",
      amountUSD: null,
      runs: 3,
    });
    expect(redeemableGrants([runs, grant()], "credit", NOW)).toEqual([
      grant(),
    ]);
  });
});

describe("social redemption allocation (#3477)", () => {
  it("allocates credit oldest-first across vested grants", () => {
    const first = grant({ id: "a", amountUSD: 5 });
    const second = grant({ id: "b", amountUSD: 5, grantedAtMs: NOW - 5 * DAY_MS });
    expect(
      allocateSocialCreditRedemption([second, first], 8, NOW),
    ).toEqual([
      { grantId: "a", amountUSD: 5 },
      { grantId: "b", amountUSD: 3 },
    ]);
  });

  it("credit allocation throws on shortfall and never dips into unvested or expired grants", () => {
    const vested = grant({ id: "a", amountUSD: 5 });
    const unvested = grant({ id: "b", amountUSD: 100, vestedAtMs: NOW + DAY_MS });
    const expired = grant({ id: "c", amountUSD: 100, expiresAtMs: NOW - 1 });
    expect(() =>
      allocateSocialCreditRedemption([vested, unvested, expired], 6, NOW),
    ).toThrow(/Insufficient vested/);
  });

  it("allocates free runs oldest-first and throws on shortfall", () => {
    const first = grant({
      id: "a",
      type: "free-runs",
      amountUSD: null,
      runs: 3,
    });
    const second = grant({
      id: "b",
      type: "free-runs",
      amountUSD: null,
      runs: 3,
      grantedAtMs: NOW - 5 * DAY_MS,
    });
    expect(allocateSocialRunRedemption([second, first], 4, NOW)).toEqual([
      { grantId: "a", runs: 3 },
      { grantId: "b", runs: 1 },
    ]);
    expect(() => allocateSocialRunRedemption([first], 4, NOW)).toThrow(
      /Insufficient vested/,
    );
  });

  it("allocation rejects non-positive amounts", () => {
    expect(() => allocateSocialCreditRedemption([grant()], 0, NOW)).toThrow();
    expect(() => allocateSocialRunRedemption([grant()], -1, NOW)).toThrow();
  });
});

describe("social daily/monthly caps (#3477)", () => {
  it("allows use below both caps", () => {
    expect(
      evaluateSocialCaps({ usesToday: 1, usesThisMonth: 5, dailyCap: 2, monthlyCap: 10 }),
    ).toEqual({ allowed: true, code: null });
  });

  it("refuses at the daily cap", () => {
    expect(
      evaluateSocialCaps({ usesToday: 2, usesThisMonth: 5, dailyCap: 2, monthlyCap: 10 }),
    ).toEqual({ allowed: false, code: "FAILURE_SOCIAL_REWARD_CAP_REACHED" });
  });

  it("refuses at the monthly cap even when the day is clear", () => {
    expect(
      evaluateSocialCaps({ usesToday: 0, usesThisMonth: 10, dailyCap: 2, monthlyCap: 10 }),
    ).toEqual({ allowed: false, code: "FAILURE_SOCIAL_REWARD_CAP_REACHED" });
  });

  it("cap windows are the UTC day and the UTC calendar month", () => {
    expect(digestDayKey(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe("2026-11-30");
    expect(digestDayKey(Date.UTC(2026, 11, 1, 0, 0, 0))).toBe("2026-12-01");
    expect(freeRunMonthKey(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe("2026-11");
    expect(freeRunMonthKey(Date.UTC(2026, 11, 1, 0, 0, 0))).toBe("2026-12");
  });
});

describe("social stacking rules (#3477)", () => {
  it("run coverage is allowance-first, social bucket second, none when both are empty", () => {
    expect(
      resolveRunCoverage({ allowanceRemaining: 3, socialRemaining: 2 }),
    ).toBe("allowance");
    expect(
      resolveRunCoverage({ allowanceRemaining: 0, socialRemaining: 2 }),
    ).toBe("social-bucket");
    expect(
      resolveRunCoverage({ allowanceRemaining: 0, socialRemaining: 0 }),
    ).toBe("none");
  });

  it("a free month is eligible only with no active paid subscription and no active free period", () => {
    expect(
      resolveFreeMonthEligibility({
        hasActivePaidSubscription: false,
        hasActiveFreePeriod: false,
      }),
    ).toEqual({ eligible: true, reason: null });
    expect(
      resolveFreeMonthEligibility({
        hasActivePaidSubscription: true,
        hasActiveFreePeriod: false,
      }),
    ).toEqual({ eligible: false, reason: "active-subscription" });
    expect(
      resolveFreeMonthEligibility({
        hasActivePaidSubscription: false,
        hasActiveFreePeriod: true,
      }),
    ).toEqual({ eligible: false, reason: "active-free-period" });
  });
});

describe("social tenant scoping, parties, verification (#3477)", () => {
  it("a tenant mismatch throws; a match passes", () => {
    expect(() =>
      assertSocialRewardTenant("tenant-1", "tenant-2"),
    ).toThrow(/tenant/i);
    expect(() => assertSocialRewardTenant("", "tenant-1")).toThrow();
    expect(() => assertSocialRewardTenant("tenant-1", "tenant-1")).not.toThrow();
  });

  it("self-reward throws; distinct parties pass", () => {
    expect(() => assertSocialGrantParties("user-1", "user-1")).toThrow(
      /self/i,
    );
    expect(() => assertSocialGrantParties("user-1", "user-2")).not.toThrow();
    expect(() => assertSocialGrantParties("", "user-2")).toThrow();
  });

  it("an unverified action throws naming the not-verified outcome", () => {
    expect(() => requireVerifiedSocialAction(false)).toThrow(
      /FAILURE_SOCIAL_REWARD_NOT_VERIFIED/,
    );
    expect(() => requireVerifiedSocialAction(true)).not.toThrow();
  });

  it("like/subscribe are not supported on slack; share is supported everywhere", () => {
    expect(() => assertSocialActionSupported("like", "facebook")).not.toThrow();
    expect(() =>
      assertSocialActionSupported("subscribe", "threads"),
    ).not.toThrow();
    expect(() => assertSocialActionSupported("like", "slack")).toThrow();
    expect(() => assertSocialActionSupported("subscribe", "slack")).toThrow();
    expect(() => assertSocialActionSupported("share", "slack")).not.toThrow();
    expect(() => assertSocialActionSupported("share", "instagram")).not.toThrow();
  });

  it("the grant id is deterministic per (user, type, action, platform, UTC day)", () => {
    const id = socialRewardGrantId({
      userId: "user-1",
      type: "credit",
      action: "like",
      platform: "facebook",
      dayKey: "2026-11-07",
    });
    expect(id).toBe("social:user-1:credit:like:facebook:2026-11-07");
    expect(
      socialRewardGrantId({
        userId: "user-1",
        type: "credit",
        action: "like",
        platform: "facebook",
        dayKey: "2026-11-08",
      }),
    ).not.toBe(id);
  });
});

describe("social reward outcome codes (#3477)", () => {
  it("every code in the model map exists in the outcome catalog with the expected outcome", () => {
    const expected: Record<string, "success" | "failure"> = {
      granted: "success",
      redeemed: "success",
      notConfigured: "failure",
      expired: "failure",
      notVested: "failure",
      capReached: "failure",
      notVerified: "failure",
    };
    for (const [key, outcome] of Object.entries(expected)) {
      const code =
        SOCIAL_REWARD_OUTCOME_CODES[
          key as keyof typeof SOCIAL_REWARD_OUTCOME_CODES
        ];
      expect(catalogOutcomes[code]).toBeDefined();
      expect(catalogOutcomes[code].outcome).toBe(outcome);
    }
  });
});
