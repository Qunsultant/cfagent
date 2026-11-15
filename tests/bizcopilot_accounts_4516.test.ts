/**
 * Issue #4516 (BizCopilot slice 2) — the deterministic account
 * branch: intent parsing + in-process execution through the
 * Accounts page's own routes.
 *
 * The route handlers compose their real Drizzle adapters over one
 * shared MockD1Database (node:sqlite, the slice0 pattern), so the
 * executor is exercised through the real handlers — the
 * store-operator gate, the audit events, and the 403/404/400
 * outcomes included — not through a stub of them. No grant is made
 * to any real account anywhere here: every login is a test-only
 * fixture in the in-memory world.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi } from "vitest";
import {
  BIZCOPILOT_ACCOUNTS_PAGE_URL,
  executeBizCopilotAccountIntent,
  parseBizCopilotAccountIntent,
  runBizCopilotAccountBranch,
  type BizCopilotAccountIntent,
} from "../src/services/bizCopilotAccounts";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1ProductDb,
  D1ProductAdapter,
  ensureProductSchema,
} from "../src/data/d1ProductAdapter";
import {
  createD1FreeAccessGrantDb,
  D1FreeAccessGrantAdapter,
  ensureFreeAccessGrantSchema,
} from "../src/data/d1FreeAccessGrantAdapter";
import type { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

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

const OPERATOR = "op1";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CAROL = "carol@example.com";
const NON_OPERATOR = "mallory@example.com";
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  const productDb = createD1ProductDb(mock as unknown as D1Database);
  const freeAccessDb = createD1FreeAccessGrantDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  await ensureSubscriptionSchema(subsDb);
  await ensureProductSchema(productDb);
  await ensureFreeAccessGrantSchema(freeAccessDb);
  const env = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: OPERATOR,
  } as unknown as Env;
  const audit = vi.fn();
  const store = new D1CommercialAdapter(commercialDb);
  const subs = new D1SubscriptionAdapter(subsDb);
  const products = new D1ProductAdapter(productDb);
  const freeAccess = new D1FreeAccessGrantAdapter(freeAccessDb);
  const deps = (userLogin: string) => ({
    env,
    userLogin,
    getOrm: () => ({}) as DatabaseORM,
    audit,
  });
  return { env, audit, store, subs, products, freeAccess, deps };
}

async function seedAccount(
  store: D1CommercialAdapter,
  userId: string,
  tenantId = "tenant-a",
) {
  await store.upsertAccount({ userId, tenantId, tier: "Free" });
}

async function seedPlan(
  subs: D1SubscriptionAdapter,
  products: D1ProductAdapter,
  name: string,
  priceUSD: number,
  effectiveFromMs: number,
) {
  const product = await products.getOrCreateProduct({
    name,
    kind: "subscription",
  });
  const plan = await subs.createPlan({
    name,
    priceUSD,
    periodDays: 30,
    includedRuns: 20,
    effectiveFromMs,
    productId: product.id,
  });
  await subs.approvePlan(plan.id, "test-operator");
  return { product, plan };
}

async function seedSubscription(
  subs: D1SubscriptionAdapter,
  id: string,
  userId: string,
  planId: string,
  periodEndMs: number,
  periodStartMs: number = Date.now(),
) {
  return subs.createSubscription({
    id,
    userId,
    tenantId: "tenant-a",
    planId,
    provider: "manual",
    providerPaymentRef: `ref-${id}`,
    periodStartMs,
    periodEndMs,
  });
}

/** Strip the RESULT/ERROR prefix and parse the context JSON. */
function parseContext(context: string): Record<string, any> {
  const marker = context.indexOf(": ");
  expect(marker).toBeGreaterThan(0);
  return JSON.parse(context.slice(marker + 2));
}

function auditTypes(audit: ReturnType<typeof vi.fn>): string[] {
  return audit.mock.calls.map((call) => String(call[0]));
}

describe("parseBizCopilotAccountIntent (#4516)", () => {
  it("parses lookup commands", () => {
    expect(parseBizCopilotAccountIntent(`Show account ${ALICE}`)).toEqual({
      action: "lookup",
      userId: ALICE,
    });
    expect(parseBizCopilotAccountIntent(`look up account ${ALICE}`)).toEqual({
      action: "lookup",
      userId: ALICE,
    });
    expect(
      parseBizCopilotAccountIntent(`Show subscriptions for ${ALICE}`),
    ).toEqual({ action: "lookup", userId: ALICE });
  });

  it("parses the operator subscription grant by plan name", () => {
    expect(
      parseBizCopilotAccountIntent(`Grant Basic subscription to ${ALICE}`),
    ).toEqual({
      action: "grant-subscription",
      userId: ALICE,
      planRef: "Basic",
    });
    expect(
      parseBizCopilotAccountIntent(`Grant subscription Premium to ${ALICE}`),
    ).toEqual({
      action: "grant-subscription",
      userId: ALICE,
      planRef: "Premium",
    });
  });

  it("parses unlimited-free grant/revoke, with and without reason and expiry", () => {
    expect(
      parseBizCopilotAccountIntent(
        `Grant unlimited free to ${ALICE} because approved by the tenant admin`,
      ),
    ).toEqual({
      action: "grant-unlimited-free",
      userId: ALICE,
      expiresRaw: null,
      reason: "approved by the tenant admin",
    });
    expect(
      parseBizCopilotAccountIntent(
        `Grant unlimited free to ${ALICE} until 2027-01-01 because approved for a trial`,
      ),
    ).toEqual({
      action: "grant-unlimited-free",
      userId: ALICE,
      expiresRaw: "2027-01-01",
      reason: "approved for a trial",
    });
    expect(
      parseBizCopilotAccountIntent(`Grant unlimited free to ${ALICE}`),
    ).toEqual({
      action: "grant-unlimited-free",
      userId: ALICE,
      expiresRaw: null,
      reason: null,
    });
    expect(
      parseBizCopilotAccountIntent(`Revoke unlimited free from ${ALICE}`),
    ).toEqual({ action: "revoke-unlimited-free", userId: ALICE });
  });

  it("parses free-access grant/revoke, lifetime and limited", () => {
    expect(
      parseBizCopilotAccountIntent(
        `Grant free access lifetime to ${ALICE} because approved by the tenant admin`,
      ),
    ).toEqual({
      action: "grant-free-access",
      userId: ALICE,
      kind: "lifetime",
      expiresRaw: null,
      reason: "approved by the tenant admin",
    });
    expect(
      parseBizCopilotAccountIntent(
        `Grant free access limited to ${ALICE} until 2027-01-01 because approved for a trial`,
      ),
    ).toEqual({
      action: "grant-free-access",
      userId: ALICE,
      kind: "limited",
      expiresRaw: "2027-01-01",
      reason: "approved for a trial",
    });
    expect(
      parseBizCopilotAccountIntent(`Revoke free access from ${ALICE}`),
    ).toEqual({ action: "revoke-free-access", userId: ALICE });
  });

  it("parses grant history and the per-customer version move", () => {
    expect(
      parseBizCopilotAccountIntent(`Show grants for ${ALICE}`),
    ).toEqual({ action: "grant-history", userId: ALICE });
    expect(
      parseBizCopilotAccountIntent(`Show grant history for ${ALICE}`),
    ).toEqual({ action: "grant-history", userId: ALICE });
    expect(
      parseBizCopilotAccountIntent(`Move ${ALICE} to current pricing`),
    ).toEqual({
      action: "move-current-pricing",
      userId: ALICE,
      reason: null,
    });
    expect(
      parseBizCopilotAccountIntent(
        `Move account ${ALICE} to current pricing because prices changed`,
      ),
    ).toEqual({
      action: "move-current-pricing",
      userId: ALICE,
      reason: "prices changed",
    });
  });

  it("returns null for anything that is not an explicit account command", () => {
    expect(parseBizCopilotAccountIntent("")).toBeNull();
    expect(parseBizCopilotAccountIntent("Hello")).toBeNull();
    // Credit adjustment is NOT a #4516 activity — the turn
    // proceeds normally, never guesses a money write.
    expect(
      parseBizCopilotAccountIntent(`Add 10 credits to ${ALICE}`),
    ).toBeNull();
    // A bare grant without a target is partial, never guessed.
    expect(parseBizCopilotAccountIntent("Grant Basic subscription")).toBeNull();
    // The tenant-admin grant path is out of scope — no parse.
    expect(
      parseBizCopilotAccountIntent(
        `Grant unlimited free to ${ALICE} as tenant admin`,
      ),
    ).toBeNull();
  });
});

describe("executeBizCopilotAccountIntent (#4516)", () => {
  it("lookup returns the account fields and links the Accounts page", async () => {
    const { store, subs, products, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    const { plan } = await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    await seedSubscription(subs, "sub-1", ALICE, plan.id, now + DAY);
    const intent = parseBizCopilotAccountIntent(
      `Show account ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    const payload = parseContext(context);
    expect(payload.pageUrl).toBe(BIZCOPILOT_ACCOUNTS_PAGE_URL);
    expect(payload.result.identity.userLogin).toBe(ALICE);
    expect(payload.result.identity.hasAccount).toBe(true);
    // The identity tier is the EFFECTIVE tier: the live
    // subscription makes it Subscribed even though the stored
    // tier is Free.
    expect(payload.result.identity.tier).toBe("Subscribed");
    expect(payload.result.identity.tenantId).toBe("tenant-a");
    expect(payload.result.subscriptions).toHaveLength(1);
    expect(payload.result.subscriptions[0].planId).toBe(plan.id);
  });

  it("lookup of an unknown login reports no account, still a result", async () => {
    const { deps } = await setup();
    const intent = parseBizCopilotAccountIntent(
      `Show account ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    const payload = parseContext(context);
    expect(payload.result.identity.hasAccount).toBe(false);
    expect(payload.pageUrl).toBe(BIZCOPILOT_ACCOUNTS_PAGE_URL);
  });

  it("a non-operator lookup is refused by the same gate as the page", async () => {
    const { store, deps } = await setup();
    await seedAccount(store, ALICE);
    const intent = parseBizCopilotAccountIntent(
      `Show account ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(
      intent,
      deps(NON_OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(context).status).toBe(403);
  });

  it("operator subscription grant creates the subscription and bumps included runs", async () => {
    const { store, subs, products, audit, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    const { plan } = await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    const intent = parseBizCopilotAccountIntent(
      `Grant Basic subscription to ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    const payload = parseContext(context);
    expect(payload.result.subscription.planId).toBe(plan.id);
    expect(payload.result.subscription.provider).toBe("operator");
    expect(payload.pageUrl).toBe(BIZCOPILOT_ACCOUNTS_PAGE_URL);
    expect(auditTypes(audit)).toContain("commercial.subscription.granted");
    const account = await store.getAccount(ALICE);
    expect(account?.includedRuns).toBe(20);
  });

  it("a non-operator grant is refused and writes nothing", async () => {
    const { store, subs, products, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    const intent = parseBizCopilotAccountIntent(
      `Grant Basic subscription to ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(
      intent,
      deps(NON_OPERATOR),
    );
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(context).status).toBe(403);
    expect(await subs.listSubscriptions(ALICE)).toHaveLength(0);
    expect((await store.getAccount(ALICE))?.includedRuns).toBe(0);
  });

  it("an unknown plan name is a deterministic error listing the available plans", async () => {
    const { store, subs, products, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    const intent = parseBizCopilotAccountIntent(
      `Grant Deluxe subscription to ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    const payload = parseContext(context);
    expect(payload.error.error).toContain("No plan named");
    expect(payload.error.error).toContain("Basic");
    expect(await subs.listSubscriptions(ALICE)).toHaveLength(0);
  });

  it("a grant to a login with no account is refused before any write", async () => {
    const { subs, products, deps } = await setup();
    const now = Date.now();
    await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    const intent = parseBizCopilotAccountIntent(
      `Grant Basic subscription to ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(context).error.error).toContain("No commercial account");
    expect(await subs.listSubscriptions(ALICE)).toHaveLength(0);
  });

  it("unlimited-free grant writes the grant with the operator as grantedBy", async () => {
    const { store, audit, deps } = await setup();
    await seedAccount(store, ALICE);
    const intent = parseBizCopilotAccountIntent(
      `Grant unlimited free to ${ALICE} because approved by the tenant admin`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    const account = await store.getAccount(ALICE);
    expect(account?.unlimitedFreeGrant).toMatchObject({
      grantedBy: OPERATOR,
      reason: "approved by the tenant admin",
      expiresAtMs: null,
    });
    expect(auditTypes(audit)).toContain(
      "commercial.account.unlimited_free_granted",
    );
  });

  it("unlimited-free grant without a reason is refused and writes nothing", async () => {
    const { store, deps } = await setup();
    await seedAccount(store, ALICE);
    const intent = parseBizCopilotAccountIntent(
      `Grant unlimited free to ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(context).error.error).toContain("needs a reason");
    expect((await store.getAccount(ALICE))?.unlimitedFreeGrant).toBeNull();
  });

  it("unlimited-free grant with a past expiry is refused and writes nothing", async () => {
    const { store, deps } = await setup();
    await seedAccount(store, ALICE);
    const intent = parseBizCopilotAccountIntent(
      `Grant unlimited free to ${ALICE} until 2020-01-01 because approved`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(context).error.error).toContain("in the past");
    expect((await store.getAccount(ALICE))?.unlimitedFreeGrant).toBeNull();
  });

  it("unlimited-free revoke clears the grant; revoking none is an error", async () => {
    const { store, audit, deps } = await setup();
    await seedAccount(store, ALICE);
    const grant = parseBizCopilotAccountIntent(
      `Grant unlimited free to ${ALICE} because approved by the tenant admin`,
    ) as BizCopilotAccountIntent;
    await executeBizCopilotAccountIntent(grant, deps(OPERATOR));
    expect(
      (await store.getAccount(ALICE))?.unlimitedFreeGrant,
    ).not.toBeNull();
    const revoke = parseBizCopilotAccountIntent(
      `Revoke unlimited free from ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(revoke, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    expect((await store.getAccount(ALICE))?.unlimitedFreeGrant).toBeNull();
    expect(auditTypes(audit)).toContain(
      "commercial.account.unlimited_free_revoked",
    );
    const again = await executeBizCopilotAccountIntent(revoke, deps(OPERATOR));
    expect(again.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(again).status).toBe(404);
  });

  it("free-access lifetime grant writes the grant; limited needs an expiry", async () => {
    const { store, freeAccess, audit, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    const lifetime = parseBizCopilotAccountIntent(
      `Grant free access lifetime to ${ALICE} because approved by the tenant admin`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(lifetime, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    expect(parseContext(context).result.granted.kind).toBe("lifetime");
    expect(await freeAccess.getActiveGrant(ALICE, now)).not.toBeNull();
    expect(auditTypes(audit)).toContain("commercial.free_access.granted");

    await seedAccount(store, BOB);
    const limitedNoExpiry = parseBizCopilotAccountIntent(
      `Grant free access limited to ${BOB} because approved for a trial`,
    ) as BizCopilotAccountIntent;
    const refused = await executeBizCopilotAccountIntent(
      limitedNoExpiry,
      deps(OPERATOR),
    );
    expect(refused.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(refused).error.error).toContain("needs an expiry date");
    expect(await freeAccess.getActiveGrant(BOB, now)).toBeNull();

    const limited = parseBizCopilotAccountIntent(
      `Grant free access limited to ${BOB} until 2027-01-01 because approved for a trial`,
    ) as BizCopilotAccountIntent;
    const granted = await executeBizCopilotAccountIntent(limited, deps(OPERATOR));
    expect(granted.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    expect(parseContext(granted).result.granted.kind).toBe("limited");
    expect(await freeAccess.getActiveGrant(BOB, now)).not.toBeNull();
  });

  it("free-access revoke clears the grant; revoking none is an error", async () => {
    const { store, freeAccess, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    const revoke = parseBizCopilotAccountIntent(
      `Revoke free access from ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const none = await executeBizCopilotAccountIntent(revoke, deps(OPERATOR));
    expect(none.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(none).status).toBe(404);
    const grant = parseBizCopilotAccountIntent(
      `Grant free access lifetime to ${ALICE} because approved by the tenant admin`,
    ) as BizCopilotAccountIntent;
    await executeBizCopilotAccountIntent(grant, deps(OPERATOR));
    expect(await freeAccess.getActiveGrant(ALICE, now)).not.toBeNull();
    const context = await executeBizCopilotAccountIntent(revoke, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    expect(await freeAccess.getActiveGrant(ALICE, now)).toBeNull();
  });

  it("grant history shows subscriptions, free-access history, and the unlimited-free grant", async () => {
    const { store, subs, products, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    const { plan } = await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    await seedSubscription(subs, "sub-1", ALICE, plan.id, now + DAY);
    const grantFree = parseBizCopilotAccountIntent(
      `Grant free access lifetime to ${ALICE} because approved by the tenant admin`,
    ) as BizCopilotAccountIntent;
    await executeBizCopilotAccountIntent(grantFree, deps(OPERATOR));
    const grantUnlimited = parseBizCopilotAccountIntent(
      `Grant unlimited free to ${ALICE} because approved by the tenant admin`,
    ) as BizCopilotAccountIntent;
    await executeBizCopilotAccountIntent(grantUnlimited, deps(OPERATOR));
    const history = parseBizCopilotAccountIntent(
      `Show grants for ${ALICE}`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(history, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    const payload = parseContext(context);
    expect(payload.result.subscriptions).toHaveLength(1);
    expect(payload.result.freeAccess.active).not.toBeNull();
    expect(payload.result.freeAccess.history).toHaveLength(1);
    expect(payload.result.unlimitedFreeGrant).toMatchObject({
      reason: "approved by the tenant admin",
    });
  });

  it("version move moves a live subscription to the effective version and reports the rest", async () => {
    const { store, subs, products, audit, deps } = await setup();
    const now = Date.now();
    await seedAccount(store, ALICE);
    await seedAccount(store, BOB);
    await seedAccount(store, CAROL);
    const { plan: v1 } = await seedPlan(subs, products, "Basic", 49.99, now - 1000);
    const { plan: v2 } = await seedPlan(subs, products, "Basic", 59.99, now);
    await seedSubscription(subs, "sub-alice", ALICE, v1.id, now + DAY);
    await seedSubscription(subs, "sub-bob", BOB, v2.id, now + DAY);
    await seedSubscription(subs, "sub-carol", CAROL, v1.id, now - 1000, now - 2 * DAY);
    const intent = parseBizCopilotAccountIntent(
      `Move ${ALICE} to current pricing because prices changed`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    const payload = parseContext(context);
    expect(payload.result.moves).toEqual([
      {
        subscriptionId: "sub-alice",
        planId: v1.id,
        fromVersionId: v1.id,
        toVersionId: v2.id,
        moved: true,
        outcome: "moved",
      },
    ]);
    expect(auditTypes(audit)).toContain("commercial.product.move");
    const moved = await subs.getSubscription("sub-alice");
    expect(moved?.planId).toBe(v2.id);

    const bobIntent = parseBizCopilotAccountIntent(
      `Move ${BOB} to current pricing`,
    ) as BizCopilotAccountIntent;
    const bobContext = await executeBizCopilotAccountIntent(bobIntent, deps(OPERATOR));
    expect(parseContext(bobContext).result.moves[0].outcome).toBe("already-current");
    expect(parseContext(bobContext).result.moves[0].moved).toBe(false);

    const carolIntent = parseBizCopilotAccountIntent(
      `Move ${CAROL} to current pricing`,
    ) as BizCopilotAccountIntent;
    const carolContext = await executeBizCopilotAccountIntent(carolIntent, deps(OPERATOR));
    expect(parseContext(carolContext).result.moves[0].outcome).toBe("skipped-not-live");
  });

  it("a version move for a login with no account is refused before any write", async () => {
    const { deps } = await setup();
    const intent = parseBizCopilotAccountIntent(
      `Move ${ALICE} to current pricing`,
    ) as BizCopilotAccountIntent;
    const context = await executeBizCopilotAccountIntent(intent, deps(OPERATOR));
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_ERROR: ")).toBe(true);
    expect(parseContext(context).error.error).toContain("No commercial account");
  });
});

describe("runBizCopilotAccountBranch (#4516)", () => {
  it("runs on a BizCopilot turn and audits the execution", async () => {
    const { store, audit, deps } = await setup();
    await seedAccount(store, ALICE);
    const context = await runBizCopilotAccountBranch({
      sourceTab: "BizCopilot",
      userText: `Show account ${ALICE}`,
      env: deps(OPERATOR).env,
      userLogin: OPERATOR,
      getOrm: () => ({}) as DatabaseORM,
      audit,
    });
    expect(context.startsWith("BIZCOPILOT_ACCOUNT_RESULT: ")).toBe(true);
    expect(parseContext(context).pageUrl).toBe(BIZCOPILOT_ACCOUNTS_PAGE_URL);
    expect(auditTypes(audit)).toContain("bizcopilot.account_action_executed");
  });

  it("returns empty on a non-BizCopilot tab and on unrecognized text", async () => {
    const { deps, audit } = await setup();
    const branchDeps = (sourceTab: string, userText: string) => ({
      sourceTab,
      userText,
      env: deps(OPERATOR).env,
      userLogin: OPERATOR,
      getOrm: () => ({}) as DatabaseORM,
      audit,
    });
    expect(
      await runBizCopilotAccountBranch(
        branchDeps("Stock Copilot", `Show account ${ALICE}`),
      ),
    ).toBe("");
    expect(
      await runBizCopilotAccountBranch(branchDeps("BizCopilot", "Hello")),
    ).toBe("");
    expect(auditTypes(audit)).not.toContain("bizcopilot.account_action_executed");
  });
});
