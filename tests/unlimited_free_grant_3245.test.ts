// @vitest-environment node
/**
 * Issue #3245 (slice 1 of #3241) — unlimited-free grant for
 * approved accounts.
 *
 * An operator-granted, account-level grant: the gate checks it
 * FIRST (before price resolution, so an unapproved family price
 * can never fail a grant-covered run), the run is covered at
 * price 0 with no checkout and no credit/included-run deduction,
 * and the decision is audited through the existing covered path.
 * Covers all families x all kinds, including recurring runs (a
 * deliberate change to the recurring rule, stated in #3245).
 * Expiry lapses back to the normal gate. Operator writes only.
 * No real account is granted by this slice — mechanism + UI only.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  ALL_MIGRATIONS,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0040_UNLIMITED_FREE_GRANT,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { agentCommercialAccounts } from "../src/data/drizzleSchema";
import {
  assertUnlimitedFreeGrant,
  isUnlimitedFreeGrantActive,
  toCommercialAccount,
  type UnlimitedFreeGrant,
} from "../src/data/commercialPorts";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
  D1CommercialAdapter,
} from "../src/data/d1CommercialAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import {
  coverageForAccount,
  resolvePaidScreenAccount,
  resolvePaidScreenAction,
} from "../src/services/paidScreenSubmission";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";

const NOW = 1_790_000_000_000;

function grant(overrides: Partial<UnlimitedFreeGrant> = {}): UnlimitedFreeGrant {
  return {
    grantedBy: "op1",
    reason: "Owner-approved pilot account",
    expiresAtMs: null,
    ...overrides,
  };
}

function nativeAccount(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    ...overrides,
  };
}

describe("unlimited-free grant: port helpers (#3245)", () => {
  it("is active with no expiry, and while its expiry is in the future", () => {
    expect(isUnlimitedFreeGrantActive(grant(), NOW)).toBe(true);
    expect(isUnlimitedFreeGrantActive(grant({ expiresAtMs: NOW + 1000 }), NOW)).toBe(true);
  });

  it("is inactive when expired, at expiry, or absent", () => {
    expect(isUnlimitedFreeGrantActive(grant({ expiresAtMs: NOW - 1 }), NOW)).toBe(false);
    expect(isUnlimitedFreeGrantActive(grant({ expiresAtMs: NOW }), NOW)).toBe(false);
    expect(isUnlimitedFreeGrantActive(null, NOW)).toBe(false);
    expect(isUnlimitedFreeGrantActive(undefined, NOW)).toBe(false);
  });

  it("validates a grant: non-empty grantedBy/reason, null or finite positive expiry", () => {
    expect(assertUnlimitedFreeGrant(grant())).toEqual(grant());
    expect(assertUnlimitedFreeGrant(grant({ expiresAtMs: NOW + 1000 }))).toEqual(
      grant({ expiresAtMs: NOW + 1000 }),
    );
    expect(() => assertUnlimitedFreeGrant({ ...grant(), grantedBy: "" })).toThrow(/must be/);
    expect(() => assertUnlimitedFreeGrant({ ...grant(), grantedBy: 7 })).toThrow(/must be/);
    expect(() => assertUnlimitedFreeGrant({ ...grant(), reason: "  " })).toThrow(/must be/);
    expect(() => assertUnlimitedFreeGrant({ ...grant(), expiresAtMs: "soon" })).toThrow(/must be/);
    expect(() => assertUnlimitedFreeGrant({ ...grant(), expiresAtMs: -1 })).toThrow(/must be/);
    expect(() => assertUnlimitedFreeGrant(null)).toThrow(/must be/);
  });

  it("toCommercialAccount carries the grant onto the gate account", () => {
    const account = toCommercialAccount(
      "u1",
      {
        id: "u1",
        tenantId: "t1",
        tier: "Free",
        tierSource: null,
        creditsUSD: 0,
        includedRuns: 0,
        updatedAtMs: NOW,
        unlimitedFreeGrant: grant(),
      },
      "u1@example.com",
      "t1",
    );
    expect(account.unlimitedFreeGrant).toEqual(grant());
    expect(
      toCommercialAccount("u1", null, "u1@example.com", "t1").unlimitedFreeGrant,
    ).toBeUndefined();
  });
});

describe("unlimited-free grant: migration 0040 (#3245)", () => {
  it("is registered (position-independent containment, never 'latest')", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0040_UNLIMITED_FREE_GRANT);
    expect(MIGRATION_0040_UNLIMITED_FREE_GRANT.version).toBe(40);
    expect(MIGRATION_0040_UNLIMITED_FREE_GRANT.name).toBe("0040_unlimited_free_grant");
  });

  it("adds exactly the three grant columns to agent_commercial_accounts", () => {
    const sql = MIGRATION_0040_UNLIMITED_FREE_GRANT.sql;
    expect(sql).toContain("ALTER TABLE agent_commercial_accounts");
    for (const column of [
      "unlimited_free_granted_by",
      "unlimited_free_reason",
      "unlimited_free_expires_at_ms",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("drizzle mapping carries the same three columns (mapping <-> DDL parity)", () => {
    const columns = getTableColumns(agentCommercialAccounts);
    expect(Object.keys(columns)).toContain("unlimitedFreeGrantedBy");
    expect(Object.keys(columns)).toContain("unlimitedFreeReason");
    expect(Object.keys(columns)).toContain("unlimitedFreeExpiresAtMs");
  });
});

describe("unlimited-free grant: store adapters (#3245)", () => {
  it("in-memory upsert sets, preserves, and revokes the grant by explicit null", async () => {
    const store = new InMemoryCommercialAdapter();
    const set = await store.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: grant(),
    });
    expect(set.unlimitedFreeGrant).toEqual(grant());
    expect((await store.getAccount("u1"))?.unlimitedFreeGrant).toEqual(grant());
    // An upsert that omits the grant preserves it.
    const preserved = await store.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      creditsUSD: 3,
    });
    expect(preserved.unlimitedFreeGrant).toEqual(grant());
    expect(preserved.creditsUSD).toBe(3);
    // Explicit null revokes it.
    const revoked = await store.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: null,
    });
    expect(revoked.unlimitedFreeGrant).toBeNull();
    expect((await store.getAccount("u1"))?.unlimitedFreeGrant).toBeNull();
  });

  it("D1 upsert round-trips the grant through migration 0040", async () => {
    const mock = new MockD1Database();
    const db = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(db);
    // The tier_source column comes from migration 0008, applied
    // by the subscription ensure on the route path (same as the
    // commercial_routes harness); the direct adapter test applies
    // it explicitly so the Drizzle select sees the full row.
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0008_SUBSCRIPTIONS]);
    const store = new D1CommercialAdapter(db);
    await store.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: grant({ expiresAtMs: NOW + 86_400_000 }),
    });
    expect((await store.getAccount("u1"))?.unlimitedFreeGrant).toEqual(
      grant({ expiresAtMs: NOW + 86_400_000 }),
    );
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Free", unlimitedFreeGrant: null });
    expect((await store.getAccount("u1"))?.unlimitedFreeGrant).toBeNull();
  });
});

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

describe("unlimited-free grant: native gate (#3245)", () => {
  function gateWithNoCatalogue() {
    return new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: null,
      checkout: null,
    });
  }

  it("covers a manual run at price 0 with no catalogue and no checkout configured", async () => {
    const gate = gateWithNoCatalogue();
    const decision = await gate.check({
      id: "run-1",
      family: "goal",
      trigger: "manual",
      account: nativeAccount({ unlimitedFreeGrant: grant() }),
      nowMs: NOW,
    });
    expect(decision).toEqual({
      allowed: true,
      status: "paid",
      runRequestId: "run-1",
      priceUSD: 0,
      paidVia: "unlimited_free_grant",
    });
    // Confirmable through the existing confirmPaid path.
    expect(await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" })).toEqual({
      allowed: true,
      status: "already_paid",
      runRequestId: "run-1",
      priceUSD: 0,
      paidVia: "unlimited_free_grant",
    });
  });

  it("covers a recurring scheduled run too (deliberate #3245 change)", async () => {
    const gate = gateWithNoCatalogue();
    const decision = await gate.check({
      id: "run-2",
      family: "stock",
      trigger: "scheduled",
      scheduleKind: "recurring",
      account: nativeAccount({ unlimitedFreeGrant: grant() }),
      nowMs: NOW,
    });
    expect(decision.allowed).toBe(true);
    expect(decision).toMatchObject({ priceUSD: 0, paidVia: "unlimited_free_grant" });
  });

  it("covers a run even when the family price is unapproved (grant precedes price resolution)", async () => {
    const catalogue = new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" });
    // The seeded catalogue prices are PROPOSED, not approved.
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: catalogue,
      checkout: null,
    });
    const decision = await gate.check({
      id: "run-3",
      family: "strategy",
      trigger: "manual",
      account: nativeAccount({ unlimitedFreeGrant: grant() }),
      nowMs: NOW,
    });
    expect(decision.allowed).toBe(true);
    expect(decision).toMatchObject({ priceUSD: 0, paidVia: "unlimited_free_grant" });
  });

  it("does not consume credits or included runs on a grant run", async () => {
    const gate = gateWithNoCatalogue();
    const account = nativeAccount({
      tier: "Subscribed",
      creditsUSD: 5,
      includedRunsRemaining: 2,
      unlimitedFreeGrant: grant(),
    });
    await gate.check({ id: "run-4", family: "goal", trigger: "manual", account, nowMs: NOW });
    expect(account.creditsUSD).toBe(5);
    expect(account.includedRunsRemaining).toBe(2);
  });

  it("an expired grant lapses to the normal gate (fail-closed without a price)", async () => {
    const gate = gateWithNoCatalogue();
    await expect(
      gate.check({
        id: "run-5",
        family: "goal",
        trigger: "manual",
        account: nativeAccount({ unlimitedFreeGrant: grant({ expiresAtMs: NOW - 1 }) }),
        nowMs: NOW,
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("an unapproved account is unchanged (402 coverage_required for a recurring run)", async () => {
    const catalogue = new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" });
    await catalogue.setPrice({ family: "goal", priceUSD: 0.1 });
    await catalogue.approvePrice({ family: "goal", approverId: "test-operator" });
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: catalogue,
      checkout: null,
    });
    const decision = await gate.check({
      id: "run-6",
      family: "goal",
      trigger: "scheduled",
      scheduleKind: "recurring",
      account: nativeAccount(),
      nowMs: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ status: "coverage_required", httpStatus: 402 });
  });
});

describe("unlimited-free grant: submission seam (#3245)", () => {
  it("coverageForAccount reports the grant before subscription/credits", () => {
    const account = {
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
      tier: "Subscribed" as const,
      creditsUSD: 5,
      includedRunsRemaining: 2,
      unlimitedFreeGrant: grant(),
    };
    expect(coverageForAccount(account, 0.1, NOW)).toBe("unlimited_free_grant");
    expect(
      coverageForAccount({ ...account, unlimitedFreeGrant: grant({ expiresAtMs: NOW - 1 }) }, 0.1, NOW),
    ).toBe("subscription_included");
  });

  it("a grant-covered recurring scheduled run routes to the payment workflow, not a skip", () => {
    expect(
      resolvePaidScreenAction({
        monetizationOn: true,
        trigger: "scheduled",
        scheduleKind: "recurring",
        coverage: "unlimited_free_grant",
        priceUSD: 0,
      }),
    ).toEqual({
      action: "start_payment",
      reason: expect.stringContaining("unlimited-free grant"),
    });
  });

  it("resolvePaidScreenAccount carries the grant onto the resolved account", async () => {
    const commercial = new InMemoryCommercialAdapter();
    await commercial.upsertAccount({
      userId: "alice",
      tenantId: "tenant-1",
      tier: "Free",
      unlimitedFreeGrant: grant(),
    });
    const { account } = await resolvePaidScreenAccount(
      { commercial, subscriptions: new InMemorySubscriptionAdapter() },
      { userId: "alice", email: "alice@example.com", tenantId: "tenant-1", nowMs: NOW },
    );
    expect(account.unlimitedFreeGrant).toEqual(grant());
  });
});

describe("unlimited-free grant: operator route (#3245)", () => {
  async function setup() {
    const mock = new MockD1Database();
    const db = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(db);
    const env = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
    };
    const ctx = {
      env,
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    return { ctx, db };
  }

  const req = (method: string, path: string, login: string | null, body?: unknown) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const call = (
    ctx: AgenticPaymentsRouteContext,
    method: string,
    path: string,
    login: string | null,
    body?: unknown,
  ) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
  };

  it("operator grants (grantedBy is the session login), reads back, and revokes by null", async () => {
    const { ctx } = await setup();
    const granted = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: { reason: "Owner-approved pilot", expiresAtMs: null },
    });
    expect(granted?.status).toBe(200);
    const record = ((await granted?.json()) as { record: { unlimitedFreeGrant: UnlimitedFreeGrant } })
      .record.unlimitedFreeGrant;
    expect(record).toEqual({ grantedBy: "op1", reason: "Owner-approved pilot", expiresAtMs: null });
    const grantAudit = (ctx.audit as any).mock.calls.find(
      ([t]: [string]) => t === "commercial.account.unlimited_free_granted",
    );
    expect(grantAudit).toBeDefined();
    expect(grantAudit[2]).toMatchObject({ userId: "u1", grantedBy: "op1" });

    const read = await call(ctx, "GET", "/payments/agentic/commercial/account?userId=u1", "op1");
    expect(
      ((await read?.json()) as { record: { unlimitedFreeGrant: UnlimitedFreeGrant } }).record
        .unlimitedFreeGrant,
    ).toEqual(record);

    const revoked = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: null,
    });
    expect(revoked?.status).toBe(200);
    expect(
      ((await revoked?.json()) as { record: { unlimitedFreeGrant: UnlimitedFreeGrant | null } }).record
        .unlimitedFreeGrant,
    ).toBeNull();
    expect(
      (ctx.audit as any).mock.calls.find(
        ([t]: [string]) => t === "commercial.account.unlimited_free_revoked",
      ),
    ).toBeDefined();
  });

  it("non-operator grant writes are 403", async () => {
    const { ctx } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "u1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: { reason: "self-grant attempt", expiresAtMs: null },
    });
    expect(res?.status).toBe(403);
  });

  it("a grant write keeps the target row's tenant, never a client-supplied tenantId", async () => {
    const { ctx } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
    });
    const granted = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "tenant-from-client",
      tier: "Free",
      unlimitedFreeGrant: { reason: "Owner-approved pilot", expiresAtMs: null },
    });
    expect(granted?.status).toBe(200);
    expect(
      ((await granted?.json()) as { record: { tenantId: string } }).record.tenantId,
    ).toBe("t1");
  });

  it("an invalid grant (empty reason) is 400 and grants nothing", async () => {
    const { ctx } = await setup();
    await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      unlimitedFreeGrant: { reason: "", expiresAtMs: null },
    });
    expect(res?.status).toBe(400);
    const read = await call(ctx, "GET", "/payments/agentic/commercial/account?userId=u1", "op1");
    expect(
      ((await read?.json()) as { record: { unlimitedFreeGrant: UnlimitedFreeGrant | null } }).record
        .unlimitedFreeGrant,
    ).toBeNull();
  });
});
