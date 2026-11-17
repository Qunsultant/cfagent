/**
 * Issue #5226 (2.27) — automatic referral attribution at account creation.
 *
 * RED first: captureSignupAttribution / resolveSignupReferrer
 * (src/services/referralAttribution.ts), the "signup" attribution
 * source, the setup route's referralCode capture, and the
 * firstRunApi referralCode plumbing do not exist yet.
 *
 * Rules under test (owner decision, recorded 2026-11-17):
 * - A referral code/link captured at account creation counts.
 * - Earn fires on the referred user's FIRST verified paid run.
 * - Self-referral excluded; one earn per referred user; replay
 *   cannot double-earn.
 * - Fraud guard: the code must exist at capture time; earn needs
 *   a VERIFIED paid run.
 * - Attribution failure never blocks account creation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  captureSignupAttribution,
  resolveSignupReferrer,
  type SignupAttributionDeps,
} from "../src/services/referralAttribution";
import { recordFirstPaidRunEarning } from "../src/services/referralCredits";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import {
  hashCodeValue,
  normalizeCodeValue,
  type ReferralCode,
  type ReferralCodeRule,
} from "../src/data/referralCodePorts";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountPorts,
  type PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import { referralCodeFromSearch, setupAccount } from "../src/client/firstRunApi";

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CODE_VALUE = "AAAA1111BBBB2222";
const NOW = 1_700_000_000_000;

async function codeRow(overrides: Partial<ReferralCode> = {}): Promise<ReferralCode> {
  return {
    id: "code-1",
    codeHash: await hashCodeValue(normalizeCodeValue(CODE_VALUE)),
    displayPrefix: "AAAA",
    ruleId: "rule-1",
    productId: "prod-1",
    kind: "referral",
    issuerLogin: "referrer-1",
    issuerKind: "user",
    referrerUserId: "referrer-1",
    tenantScope: null,
    runs: 1,
    reusable: false,
    expiresAtMs: null,
    revokedAtMs: null,
    redemptionCount: 0,
    createdAtMs: NOW,
    ...overrides,
  };
}

function ruleRow(overrides: Partial<ReferralCodeRule> = {}): ReferralCodeRule {
  return {
    id: "rule-1",
    productId: "prod-1",
    issuer: "user",
    runsPerCode: 1,
    reusable: false,
    expiryDays: null,
    attributionMode: "ledger",
    maxRedemptionsPerCode: null,
    maxRedemptionsPerLogin: null,
    globalCap: null,
    redemptionCount: 0,
    active: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SignupAttributionDeps> = {}): SignupAttributionDeps {
  return {
    codes: { getCodeByHash: async () => null },
    rules: { getRule: async () => ruleRow() },
    commercial: new InMemoryCommercialAdapter(),
    lifecycle: new InMemoryLifecycleAdapter(),
    ...overrides,
  };
}

// Service -------------------------------------------------------------------

describe("resolveSignupReferrer (#5226)", () => {
  it("resolves an issued referral code to its referrer", async () => {
    const row = await codeRow();
    const deps = makeDeps({
      codes: { getCodeByHash: async (hash) => (hash === row.codeHash ? row : null) },
    });
    const resolved = await resolveSignupReferrer(deps, {
      codeValue: CODE_VALUE,
      referredUserId: "new-user",
      tenantId: "t1",
      nowMs: NOW,
    });
    expect(resolved).toEqual({ referrerUserId: "referrer-1" });
  });

  it("resolves a referral-link login with an account in the same tenant", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "referrer-1", tenantId: "t1", tier: "Free" });
    const deps = makeDeps({ commercial });
    const resolved = await resolveSignupReferrer(deps, {
      codeValue: "referrer-1",
      referredUserId: "new-user",
      tenantId: "t1",
      nowMs: NOW,
    });
    expect(resolved).toEqual({ referrerUserId: "referrer-1" });
  });

  it("returns null for an unknown value, an expired code, a revoked code, and a code with no referrer", async () => {
    const expired = await codeRow({ expiresAtMs: NOW - 1 });
    const revoked = await codeRow({ revokedAtMs: NOW - 1 });
    const invite = await codeRow({ kind: "invite", referrerUserId: null });
    const deps = makeDeps({
      codes: {
        getCodeByHash: async (hash) => {
          if (hash === expired.codeHash) return expired;
          if (hash === revoked.codeHash) return revoked;
          if (hash === invite.codeHash) return invite;
          return null;
        },
      },
    });
    for (const value of [CODE_VALUE, "nobody-at-all", "", "   "]) {
      expect(
        await resolveSignupReferrer(deps, {
          codeValue: value,
          referredUserId: "new-user",
          tenantId: "t1",
          nowMs: NOW,
        }),
      ).toBeNull();
    }
    // Expired / revoked / invite-kind codes resolve to nothing: the
    // test re-points the store at each row in turn.
    const expiredDeps = makeDeps({ codes: { getCodeByHash: async () => expired } });
    expect(
      await resolveSignupReferrer(expiredDeps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
    const revokedDeps = makeDeps({ codes: { getCodeByHash: async () => revoked } });
    expect(
      await resolveSignupReferrer(revokedDeps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
    const inviteDeps = makeDeps({ codes: { getCodeByHash: async () => invite } });
    expect(
      await resolveSignupReferrer(inviteDeps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("refuses a code whose tenant scope does not cover the referred tenant", async () => {
    const row = await codeRow({ tenantScope: "t2" });
    const deps = makeDeps({ codes: { getCodeByHash: async () => row } });
    expect(
      await resolveSignupReferrer(deps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("refuses a link login whose account lives in another tenant, and a self-referral", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({ userId: "referrer-1", tenantId: "t2", tier: "Free" });
    const deps = makeDeps({ commercial });
    expect(
      await resolveSignupReferrer(deps, {
        codeValue: "referrer-1",
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      await resolveSignupReferrer(deps, {
        codeValue: "new-user",
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

describe("captureSignupAttribution (#5226)", () => {
  it("writes a source 'signup' attribution row for a captured code", async () => {
    const row = await codeRow();
    const lifecycle = new InMemoryLifecycleAdapter();
    const deps = makeDeps({
      codes: { getCodeByHash: async () => row },
      lifecycle,
    });
    const attribution = await captureSignupAttribution(deps, {
      codeValue: CODE_VALUE,
      referredUserId: "new-user",
      tenantId: "t1",
      nowMs: NOW,
    });
    expect(attribution).not.toBeNull();
    expect(attribution!.referrerUserId).toBe("referrer-1");
    expect(attribution!.referredUserId).toBe("new-user");
    expect(attribution!.source).toBe("signup");
    expect(await lifecycle.getAttribution("new-user")).toEqual(attribution);
  });

  it("capturing twice replays the same row and never double-attributes", async () => {
    const row = await codeRow();
    const lifecycle = new InMemoryLifecycleAdapter();
    const deps = makeDeps({ codes: { getCodeByHash: async () => row }, lifecycle });
    const first = await captureSignupAttribution(deps, {
      codeValue: CODE_VALUE,
      referredUserId: "new-user",
      tenantId: "t1",
      nowMs: NOW,
    });
    const second = await captureSignupAttribution(deps, {
      codeValue: CODE_VALUE,
      referredUserId: "new-user",
      tenantId: "t1",
      nowMs: NOW,
    });
    expect(second).toEqual(first);
  });

  it("self-referral captures nothing", async () => {
    const row = await codeRow({ referrerUserId: "new-user" });
    const lifecycle = new InMemoryLifecycleAdapter();
    const deps = makeDeps({ codes: { getCodeByHash: async () => row }, lifecycle });
    expect(
      await captureSignupAttribution(deps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(await lifecycle.getAttribution("new-user")).toBeNull();
  });

  it("never throws: a failing lifecycle store yields null, not an error", async () => {
    const row = await codeRow();
    const throwing = {
      recordAttribution: async () => {
        throw new Error("store down");
      },
      getAttribution: async () => null,
    } as unknown as SignupAttributionDeps["lifecycle"];
    const deps = makeDeps({ codes: { getCodeByHash: async () => row }, lifecycle: throwing });
    expect(
      await captureSignupAttribution(deps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("a conflicting pre-existing attribution is left alone, not overwritten", async () => {
    const lifecycle = new InMemoryLifecycleAdapter();
    await lifecycle.recordAttribution({
      referrerUserId: "referrer-A",
      referredUserId: "new-user",
      tenantId: "t1",
      source: "operator",
    });
    const row = await codeRow({ referrerUserId: "referrer-B" });
    const deps = makeDeps({ codes: { getCodeByHash: async () => row }, lifecycle });
    expect(
      await captureSignupAttribution(deps, {
        codeValue: CODE_VALUE,
        referredUserId: "new-user",
        tenantId: "t1",
        nowMs: NOW,
      }),
    ).toBeNull();
    expect((await lifecycle.getAttribution("new-user"))?.referrerUserId).toBe("referrer-A");
  });
});

describe("earn on the first verified paid run (#5226)", () => {
  it("fires once for a captured attribution and never double-earns", async () => {
    const row = await codeRow();
    const lifecycle = new InMemoryLifecycleAdapter();
    const deps = makeDeps({ codes: { getCodeByHash: async () => row }, lifecycle });
    await captureSignupAttribution(deps, {
      codeValue: CODE_VALUE,
      referredUserId: "new-user",
      tenantId: "t1",
      nowMs: NOW,
    });
    const attribution = await lifecycle.getAttribution("new-user");
    expect(attribution).not.toBeNull();
    const first = await recordFirstPaidRunEarning(lifecycle, {
      referrerUserId: attribution!.referrerUserId,
      referredUserId: "new-user",
      tenantId: "t1",
    });
    const second = await recordFirstPaidRunEarning(lifecycle, {
      referrerUserId: attribution!.referrerUserId,
      referredUserId: "new-user",
      tenantId: "t1",
    });
    expect(second.id).toBe(first.id);
    expect(await lifecycle.listEarnings("referrer-1")).toHaveLength(1);
  });
});

// Route ---------------------------------------------------------------------

function makePorts(overrides: Partial<PlatformAccountPorts> = {}): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
    profile: null,
    lifecycle: new InMemoryLifecycleAdapter(),
    referralCodes: {
      rules: { getRule: async () => ruleRow() },
      codes: { getCodeByHash: async () => null },
    },
    ...overrides,
  };
}

function makeCtx(
  ports: PlatformAccountPorts,
): PlatformAccountRouteContext & { audit: ReturnType<typeof vi.fn> } {
  return { env: {} as never, audit: vi.fn(), ports } as PlatformAccountRouteContext & {
    audit: ReturnType<typeof vi.fn>;
  };
}

function req(method: string, path: string, login: string, body?: unknown): Request {
  return new Request(`https://agent.openaimp.com${path}`, {
    method,
    headers: { "x-user-login": login, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callSetup(
  ports: PlatformAccountPorts,
  login: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handlePlatformAccountRoutes(
    req("POST", "/platform/accounts/setup", login, body),
    new URL("https://agent.openaimp.com/platform/accounts/setup"),
    "/platform/accounts/setup",
    "sess-1",
    makeCtx(ports),
  );
  expect(res).not.toBeNull();
  return { status: res!.status, json: (await res!.json()) as Record<string, unknown> };
}

describe("POST /platform/accounts/setup captures attribution (#5226)", () => {
  it("records the attribution when a valid code is supplied at creation", async () => {
    const row = await codeRow();
    const lifecycle = new InMemoryLifecycleAdapter();
    const ports = makePorts({
      lifecycle,
      referralCodes: {
        rules: { getRule: async () => ruleRow() },
        codes: { getCodeByHash: async (hash) => (hash === row.codeHash ? row : null) },
      },
    });
    const { status, json } = await callSetup(ports, "new-user", { referralCode: CODE_VALUE });
    expect(status).toBe(200);
    expect(json.created).toBe(true);
    const attribution = await lifecycle.getAttribution("new-user");
    expect(attribution?.referrerUserId).toBe("referrer-1");
    expect(attribution?.source).toBe("signup");
  });

  it("creates the account with no attribution when the code is invalid", async () => {
    const lifecycle = new InMemoryLifecycleAdapter();
    const ports = makePorts({ lifecycle });
    const { status, json } = await callSetup(ports, "new-user", { referralCode: "NOT-A-CODE" });
    expect(status).toBe(200);
    expect(json.created).toBe(true);
    expect(await lifecycle.getAttribution("new-user")).toBeNull();
  });

  it("creates the account when the attribution stores are unbound", async () => {
    const ports = makePorts({ lifecycle: null, referralCodes: null });
    const { status, json } = await callSetup(ports, "new-user", { referralCode: CODE_VALUE });
    expect(status).toBe(200);
    expect(json.created).toBe(true);
  });

  it("does not re-attribute on the idempotent second setup call", async () => {
    const row = await codeRow();
    const lifecycle = new InMemoryLifecycleAdapter();
    const ports = makePorts({
      lifecycle,
      referralCodes: {
        rules: { getRule: async () => ruleRow() },
        codes: { getCodeByHash: async () => row },
      },
    });
    await callSetup(ports, "new-user", { referralCode: CODE_VALUE });
    const second = await callSetup(ports, "new-user", { referralCode: CODE_VALUE });
    expect(second.json.created).toBe(false);
    const attribution = await lifecycle.getAttribution("new-user");
    expect(attribution?.referrerUserId).toBe("referrer-1");
    expect(attribution?.source).toBe("signup");
  });
});

// Client --------------------------------------------------------------------

describe("referralCodeFromSearch (#5226)", () => {
  it("reads ?ref=, trims it, and returns null when absent or blank", () => {
    expect(referralCodeFromSearch("?ref=OpenAIMP&tab=billing")).toBe("OpenAIMP");
    expect(referralCodeFromSearch("?tab=billing")).toBeNull();
    expect(referralCodeFromSearch("?ref=%20%20")).toBeNull();
    expect(referralCodeFromSearch("?ref=")).toBeNull();
    expect(referralCodeFromSearch("")).toBeNull();
  });
});

describe("setupAccount sends the referral code (#5226)", () => {
  it("posts { referralCode } when one is supplied and {} otherwise", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({
        created: true,
        identity: {
          userLogin: "new-user",
          tenantId: "t1",
          hasAccount: true,
          tier: "Free",
          creditsUSD: 0,
          includedRunsRemaining: 0,
        },
      });
    }) as typeof fetch;
    await setupAccount("AAAA1111BBBB2222");
    await setupAccount();
    expect(seen[0]).toEqual({ referralCode: "AAAA1111BBBB2222" });
    expect(seen[1]).toEqual({});
  });
});
