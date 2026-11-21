// @vitest-environment node
/**
 * Issue #3185 (bridge slice) — the D1 mirror of usage_events.
 *
 * Pins:
 *  - 3185-B01 migration 0077 creates the mirror table + both indexes;
 *    the migration registry stays well-formed (77 follows 76).
 *  - 3185-B02 the mirror adapter: INSERT OR IGNORE replay is a
 *    no-op; the NULL-tenant stamp fills NULL only, never a stamp.
 *  - 3185-B03 the projector: unbound AGENT_DB is a named skip;
 *    a projected row reads back; a replay is already-current.
 *  - 3185-B04 the live hook never throws (unbound env, failed
 *    store) and never fails the DO write.
 *  - 3185-B05 the backfill tenant ladder: deterministic (stamped
 *    transaction), approximate (current account), unattributed
 *    (anonymous / no account / no transaction). NULL is never
 *    invented, and a stamped row is never re-resolved.
 *  - 3185-B06 the reconcile sweep: oldest-first bounded drain,
 *    prune-before-project (365d, DO + mirror in one pass), second
 *    call reconciles zero new rows.
 *  - 3185-B07 the tenant readers: receipts by tenant beside the
 *    login read; the revenue coverage cut scopes by tenant while
 *    every other cut stays platform-wide; the MCP merge dedups
 *    DO + mirror rows by id.
 *  - 3185-B08 retention/DSAR: the DO prune + mirror prune delete
 *    the same 365d window; deleteByUser erases one login only.
 *  - 3185-B09 the backfill script's arg parsing + per-instance
 *    summary (no HTTP in the unit path).
 */
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import { d1MigrationSql } from "../src/data/schemaComponent/d1Catalogue";
import {
  createD1UsageEventMirrorDb,
  D1UsageEventMirrorAdapter,
  ensureUsageEventMirrorSchema,
  mergeMeterRows,
} from "../src/data/d1UsageEventMirrorAdapter";
import {
  createUsageEventMirrorAdapter,
  ensureUsageEventMirrorTables,
} from "../src/data/createUsageEventMirrorPorts";
import { createUsageEventProjector } from "../src/data/usageEventProjection";
import { postUsageEventBestEffort } from "../src/services/usageEventProjectionPosting";
import { projectUsageEventBestEffort } from "../src/services/usageEventProjectionHooks";
import {
  reconcileUsageEventsProjection,
  resolveBackfillTenant,
} from "../src/agents/orchestrator/usageEventsReconcile";
import { DoSqliteUsageEventStore } from "../src/data/doSqliteUsageEventAdapter";
import { InMemoryUsageEventStore } from "../src/data/inMemoryCanonicalReportStoreAdapters";
import {
  METER_RECEIPTS_BY_TENANT_SQL,
  METER_RECEIPTS_SQL,
  readMeterReceiptsByTenant,
  readMeterRows,
} from "../src/services/receiptSurface";
import { computeRevenueSummaryFromRows } from "../src/data/marketplacePorts";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import type { UsageEventDetailRow } from "../src/data/canonicalReportStorePorts";
import { createD1CommercialDb, D1CommercialAdapter, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import { parseArgs, summarizeInstance } from "../scripts/backfill-usage-events-mirror.mjs";

function meterRow(overrides: Partial<UsageEventDetailRow> = {}): UsageEventDetailRow {
  return {
    id: "use_r1",
    userLogin: "alice",
    runId: "r1",
    category: "research_run",
    createdAt: "2026-11-20T00:00:00.000Z",
    detailJson: JSON.stringify({ receiptId: "r1", priceUSD: 0.1, protocol: "x402" }),
    tenantId: "tenant-a",
    ...overrides,
  };
}

async function mirrorAdapter() {
  const mock = new MockD1Database();
  const adapter = new D1UsageEventMirrorAdapter(
    createD1UsageEventMirrorDb(mock as never),
  );
  await ensureUsageEventMirrorSchema(adapter.db);
  return { mock, adapter };
}

async function commercialEnv() {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as never);
  await ensureCommercialSchema(db);
  const store = new D1CommercialAdapter(db);
  return { mock, store };
}

describe("3185-B01 migration 0077 creates the mirror", () => {
  it("builds the CREATE TABLE + both indexes from the catalogue", () => {
    const sql = d1MigrationSql(77);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_usage_events");
    expect(sql).toContain("id TEXT PRIMARY KEY");
    expect(sql).toContain("tenant_id TEXT");
    expect(sql).toContain("source_instance TEXT");
    expect(sql).toContain("projected_at TEXT NOT NULL");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS agent_usage_events_tenant_idx");
    expect(sql).toContain("ON agent_usage_events (tenant_id, created_at DESC)");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS agent_usage_events_user_idx");
    expect(sql).toContain("ON agent_usage_events (user_login, created_at DESC)");
  });

  it("registers 0077 after 0076 in a well-formed registry", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(77);
    // #3189: only migration_registry.test.ts owns "latest" — this
    // test pins 0077's REGISTRATION (after 0076), not its
    // latest-ness, so it stays green when a later migration
    // (#5423 adds 0078) lands after it.
    expect(versions.indexOf(77)).toBe(versions.indexOf(76) + 1);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    const names = ALL_MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(ALL_MIGRATIONS.find((m) => m.version === 77)?.name).toBe(
      "0077_usage_events_mirror",
    );
  });
});

describe("3185-B02 the mirror adapter", () => {
  it("projects a row and replays as a no-op", async () => {
    const { adapter } = await mirrorAdapter();
    expect(await adapter.recordUsageEvent(meterRow(), { nowMs: 1000 })).toBe(true);
    expect(await adapter.recordUsageEvent(meterRow(), { nowMs: 2000 })).toBe(false);
    const read = await adapter.getUsageEvent("use_r1");
    expect(read?.tenantId).toBe("tenant-a");
    expect(read?.sourceInstance).toBeNull();
    expect(read?.projectedAt).toBe("1970-01-01T00:00:01.000Z");
  });

  it("the NULL-tenant stamp fills NULL only, never a stamp", async () => {
    const { adapter } = await mirrorAdapter();
    await adapter.recordUsageEvent(meterRow({ id: "use_null", tenantId: null }), {
      nowMs: 1000,
    });
    expect(await adapter.stampTenantIfUnattributed("use_null", "tenant-a")).toBe(true);
    expect((await adapter.getUsageEvent("use_null"))?.tenantId).toBe("tenant-a");
    expect(await adapter.stampTenantIfUnattributed("use_null", "tenant-b")).toBe(false);
    expect((await adapter.getUsageEvent("use_null"))?.tenantId).toBe("tenant-a");
    await adapter.recordUsageEvent(meterRow({ id: "use_stamped", tenantId: "tenant-a" }), {
      nowMs: 1000,
    });
    expect(await adapter.stampTenantIfUnattributed("use_stamped", "tenant-b")).toBe(false);
  });

  it("lists by tenant, newest first, and excludes NULL tenants", async () => {
    const { adapter } = await mirrorAdapter();
    await adapter.recordUsageEvent(meterRow({ id: "use_1", createdAt: "2026-11-20T00:00:00.000Z" }), { nowMs: 1 });
    await adapter.recordUsageEvent(
      meterRow({ id: "use_2", createdAt: "2026-11-21T00:00:00.000Z" }),
      { nowMs: 2 },
    );
    await adapter.recordUsageEvent(
      meterRow({ id: "use_3", userLogin: "bob", tenantId: "tenant-b", createdAt: "2026-11-22T00:00:00.000Z" }),
      { nowMs: 3 },
    );
    await adapter.recordUsageEvent(
      meterRow({ id: "use_4", userLogin: "carol", tenantId: null, createdAt: "2026-11-23T00:00:00.000Z" }),
      { nowMs: 4 },
    );
    expect((await adapter.listByTenant("tenant-a", 10)).map((r) => r.id)).toEqual([
      "use_2",
      "use_1",
    ]);
    expect((await adapter.listByTenant("tenant-b", 10)).map((r) => r.id)).toEqual(["use_3"]);
    expect(await adapter.listByTenant("tenant-none", 10)).toEqual([]);
  });

  it("prunes and erases by the same window/login as the DO side", async () => {
    const { adapter } = await mirrorAdapter();
    await adapter.recordUsageEvent(
      meterRow({ id: "use_old", createdAt: "2025-01-01T00:00:00.000Z" }),
      { nowMs: 1 },
    );
    await adapter.recordUsageEvent(
      meterRow({ id: "use_new", createdAt: "2026-11-20T00:00:00.000Z" }),
      { nowMs: 2 },
    );
    await adapter.recordUsageEvent(
      meterRow({ id: "use_bob", userLogin: "bob", createdAt: "2026-11-20T00:00:00.000Z" }),
      { nowMs: 3 },
    );
    expect(await adapter.pruneBefore("2025-11-20T00:00:00.000Z")).toBe(1);
    expect(await adapter.getUsageEvent("use_old")).toBeNull();
    expect(await adapter.countByUser("bob")).toBe(1);
    expect(await adapter.deleteByUser("bob")).toBe(1);
    expect(await adapter.countByUser("bob")).toBe(0);
    expect(await adapter.getUsageEvent("use_new")).not.toBeNull();
  });
});

describe("3185-B03 the projector", () => {
  it("an unbound store is a named skip, never a throw", async () => {
    const projector = createUsageEventProjector({ mirror: null });
    await expect(
      projector.projectUsageEvent(meterRow(), Date.now()),
    ).resolves.toEqual({ projected: false, skipped: "unbound" });
    expect(await projector.stampTenantIfUnattributed("use_r1", "tenant-a")).toBe(false);
  });

  it("projects once and reports the replay as already-current", async () => {
    const { mock, adapter } = await mirrorAdapter();
    const env = { AGENT_DB: mock as never };
    expect(createUsageEventMirrorAdapter({})).toBeNull();
    expect(createUsageEventMirrorAdapter(env)).not.toBeNull();
    const projector = createUsageEventProjector({ mirror: adapter });
    await expect(projector.projectUsageEvent(meterRow(), 1000)).resolves.toEqual({
      projected: true,
    });
    await expect(projector.projectUsageEvent(meterRow(), 2000)).resolves.toEqual({
      projected: false,
      skipped: "already-current",
    });
    expect(await adapter.listAll()).toHaveLength(1);
  });
});

describe("3185-B04 the live hook never throws", () => {
  it("unbound env posts nothing and resolves posted:false", async () => {
    await expect(
      postUsageEventBestEffort({}, meterRow(), 1000),
    ).resolves.toEqual({ posted: false, projected: false, skipped: "unbound" });
    await expect(projectUsageEventBestEffort({ env: undefined, row: meterRow() })).resolves.toEqual({
      posted: false,
      projected: false,
      skipped: "unbound",
    });
    await expect(projectUsageEventBestEffort({ env: {}, row: meterRow() })).resolves.toEqual({
      posted: false,
      projected: false,
      skipped: "unbound",
    });
  });

  it("a bound env posts the row", async () => {
    const { mock } = await mirrorAdapter();
    const posted = await postUsageEventBestEffort({ AGENT_DB: mock as never }, meterRow(), 1000);
    expect(posted.posted).toBe(true);
    expect(posted.projected).toBe(true);
    const adapter = createUsageEventMirrorAdapter({ AGENT_DB: mock as never });
    expect(await adapter?.getUsageEvent("use_r1")).not.toBeNull();
  });
});

describe("3185-B05 the backfill tenant ladder", () => {
  function doSqlWithTx() {
    const sql = new MockSqlStorage();
    // One stamped transaction (deterministic) + one unstamped
    // transaction whose customer has an account (approximate).
    sql.exec(
      "INSERT INTO mas_transactions (id, tenant_id, customer) VALUES (?, ?, ?)",
      "tx_r1",
      "tenant-tx",
      "alice",
    );
    sql.exec(
      "INSERT INTO mas_transactions (id, tenant_id, customer) VALUES (?, ?, ?)",
      "tx_r2",
      null,
      "bob",
    );
    return sql;
  }

  it("deterministic: the stamped transaction's tenant wins", async () => {
    const sql = doSqlWithTx();
    const { mock, store } = await commercialEnv();
    const env = { AGENT_DB: mock as never };
    const resolved = await resolveBackfillTenant({
      env,
      sql: sql as never,
      row: meterRow({ id: "use_r1", tenantId: null }),
    });
    expect(resolved).toEqual({ tenantId: "tenant-tx", tier: "deterministic" });
    void store;
  });

  it("approximate: an unstamped transaction falls back to the customer's current account", async () => {
    const sql = doSqlWithTx();
    const { mock, store } = await commercialEnv();
    await store.upsertAccount({ userId: "bob", tenantId: "tenant-bob", tier: "Free" });
    const resolved = await resolveBackfillTenant({
      env: { AGENT_DB: mock as never },
      sql: sql as never,
      row: meterRow({
        id: "use_r2",
        userLogin: "carol",
        runId: "r2",
        tenantId: null,
        detailJson: JSON.stringify({ receiptId: "r2", priceUSD: 0.2, protocol: "x402" }),
      }),
    });
    expect(resolved).toEqual({ tenantId: "tenant-bob", tier: "approximate" });
  });

  it("unattributed: anonymous payer rows and no-account logins stay NULL", async () => {
    const sql = doSqlWithTx();
    const { mock } = await commercialEnv();
    const env = { AGENT_DB: mock as never };
    const x402 = await resolveBackfillTenant({
      env,
      sql: sql as never,
      row: meterRow({
        id: "use_x",
        userLogin: "x402:0xabc",
        runId: "rx",
        tenantId: null,
        detailJson: JSON.stringify({ receiptId: "rx", priceUSD: 0.05, protocol: "x402" }),
      }),
    });
    expect(x402).toEqual({ tenantId: null, tier: "unattributed" });
    const noAccount = await resolveBackfillTenant({
      env,
      sql: sql as never,
      row: meterRow({ id: "use_n", userLogin: "nobody", runId: "rn", tenantId: null, detailJson: null }),
    });
    expect(noAccount).toEqual({ tenantId: null, tier: "unattributed" });
  });

  it("a stamped row is never re-resolved", async () => {
    const txSql = doSqlWithTx();
    const doSql = new MockSqlStorage();
    const store = new DoSqliteUsageEventStore(doSql as never);
    store.insertEvent({
      id: "use_r1",
      userLogin: "alice",
      runId: "r1",
      category: "research_run",
      createdAt: "2026-11-20T00:00:00.000Z",
      detailJson: JSON.stringify({ receiptId: "r1", priceUSD: 0.1, protocol: "x402" }),
      tenantId: "tenant-a",
    });
    // The transaction row tx_r1 is stamped tenant-tx in txSql —
    // but the reconcile reads transactions from the DO sql that
    // holds the meter rows, so seed the same tx row there.
    doSql.exec(
      "INSERT INTO mas_transactions (id, tenant_id, customer) VALUES (?, ?, ?)",
      "tx_r1",
      "tenant-tx",
      "alice",
    );
    const { mock, adapter } = await mirrorAdapter();
    const env = { AGENT_DB: mock as never };
    const result = await reconcileUsageEventsProjection({
      env,
      sql: doSql as never,
      sourceInstance: "test",
      nowMs: Date.parse("2026-11-20T00:00:00.000Z"),
    });
    expect(result.errors).toEqual([]);
    expect(result.reconciled).toBe(1);
    // The stamped transaction names tenant-tx, but the row's own
    // stamp (tenant-a) is authoritative and is never re-resolved.
    expect(result.tenantDeterministic).toBe(0);
    expect(result.tenantApproximate).toBe(0);
    expect(result.tenantUnattributed).toBe(0);
    expect((await adapter.getUsageEvent("use_r1"))?.tenantId).toBe("tenant-a");
    void txSql;
  });
});

describe("3185-B06 the reconcile sweep", () => {
  function seededDo() {
    const sql = new MockSqlStorage();
    const store = new DoSqliteUsageEventStore(sql as never);
    return { sql, store };
  }

  function seedRow(
    store: DoSqliteUsageEventStore,
    overrides: Partial<UsageEventDetailRow> & { id: string },
  ) {
    store.insertEvent({
      id: overrides.id,
      userLogin: overrides.userLogin ?? "alice",
      runId: overrides.runId ?? overrides.id,
      category: overrides.category ?? "research_run",
      createdAt: overrides.createdAt ?? "2026-11-20T00:00:00.000Z",
      detailJson: overrides.detailJson ?? null,
      tenantId: overrides.tenantId ?? null,
    });
  }

  it("drains oldest-first, then a second call reconciles zero new rows", async () => {
    const { sql, store } = seededDo();
    seedRow(store, { id: "use_1", createdAt: "2026-11-18T00:00:00.000Z" });
    seedRow(store, { id: "use_2", createdAt: "2026-11-19T00:00:00.000Z" });
    seedRow(store, { id: "use_3", createdAt: "2026-11-20T00:00:00.000Z" });
    const { mock } = await mirrorAdapter();
    const env = { AGENT_DB: mock as never };
    const nowMs = Date.parse("2026-11-20T00:00:00.000Z");
    const first = await reconcileUsageEventsProjection({
      env,
      sql: sql as never,
      sourceInstance: "test",
      limit: 2,
      nowMs,
    });
    expect(first.errors).toEqual([]);
    expect(first.checked).toBe(2);
    expect(first.reconciled).toBe(2);
    expect(first.tenantUnattributed).toBe(2);
    const second = await reconcileUsageEventsProjection({
      env,
      sql: sql as never,
      sourceInstance: "test",
      limit: 2,
      nowMs,
    });
    expect(second.checked).toBe(3);
    expect(second.reconciled).toBe(1);
    expect(second.alreadyCurrent).toBe(2);
    const third = await reconcileUsageEventsProjection({
      env,
      sql: sql as never,
      sourceInstance: "test",
      limit: 2,
      nowMs,
    });
    expect(third.checked).toBe(3);
    expect(third.reconciled).toBe(0);
    expect(third.alreadyCurrent).toBe(3);
  });

  it("prunes the 365d window in DO + mirror before projecting", async () => {
    const { sql, store } = seededDo();
    seedRow(store, { id: "use_old", createdAt: "2025-01-01T00:00:00.000Z" });
    seedRow(store, { id: "use_new", createdAt: "2026-11-20T00:00:00.000Z" });
    const { mock, adapter } = await mirrorAdapter();
    await adapter.recordUsageEvent(
      meterRow({ id: "use_mirror_old", createdAt: "2025-01-01T00:00:00.000Z" }),
      { nowMs: 1 },
    );
    const result = await reconcileUsageEventsProjection({
      env: { AGENT_DB: mock as never },
      sql: sql as never,
      sourceInstance: "test",
      nowMs: Date.parse("2026-11-20T00:00:00.000Z"),
    });
    expect(result.errors).toEqual([]);
    expect(result.prunedDo).toBe(1);
    expect(result.prunedMirror).toBe(1);
    expect(result.checked).toBe(1);
    expect(await adapter.getUsageEvent("use_mirror_old")).toBeNull();
    expect(store.listAllWithDetail().map((r) => r.id)).toEqual(["use_new"]);
  });

  it("an unbound AGENT_DB is a named refusal, never a silent zero", async () => {
    const { sql } = seededDo();
    const result = await reconcileUsageEventsProjection({
      env: {},
      sql: sql as never,
      sourceInstance: "test",
    });
    expect(result.refused).toMatch(/AGENT_DB unbound/);
    expect(result.checked).toBe(0);
    expect(result.reconciled).toBe(0);
  });
});

describe("3185-B07 the tenant readers", () => {
  it("METER_RECEIPTS_BY_TENANT_SQL searches the tenant index", () => {
    expect(METER_RECEIPTS_BY_TENANT_SQL).toContain("WHERE tenant_id = ?");
    expect(METER_RECEIPTS_BY_TENANT_SQL).not.toBe(METER_RECEIPTS_SQL);
  });

  it("reads one tenant's meter rows beside the login read", () => {
    const sql = new MockSqlStorage();
    const store = new DoSqliteUsageEventStore(sql as never);
    store.insertEvent({
      id: "use_1",
      userLogin: "alice",
      runId: "r1",
      category: "research_run",
      createdAt: "2026-11-20T00:00:00.000Z",
      detailJson: JSON.stringify({ receiptId: "r1", priceUSD: 0.1, tier: "Free", protocol: "x402" }),
      tenantId: "tenant-a",
    });
    store.insertEvent({
      id: "use_2",
      userLogin: "bob",
      runId: "r2",
      category: "research_run",
      createdAt: "2026-11-21T00:00:00.000Z",
      detailJson: JSON.stringify({ receiptId: "r2", priceUSD: 0.2, tier: "Free", protocol: "x402" }),
      tenantId: "tenant-b",
    });
    store.insertEvent({
      id: "use_3",
      userLogin: "carol",
      runId: "r3",
      category: "research_run",
      createdAt: "2026-11-22T00:00:00.000Z",
      detailJson: null,
      tenantId: null,
    });
    const byTenant = readMeterReceiptsByTenant(sql as never, "tenant-a", 10);
    expect(byTenant.map((r) => r.id)).toEqual(["use_1"]);
    expect(byTenant[0].priceUSD).toBe(0.1);
    expect(readMeterReceiptsByTenant(sql as never, "tenant-none", 10)).toEqual([]);
    // The login read is unchanged by the tenant read's presence.
    expect(readMeterRows(sql as never, "alice", 10).map((r) => r.id)).toEqual(["use_1"]);
  });

  it("the revenue coverage cut scopes by tenant; other cuts stay platform-wide", () => {
    const rows = {
      externalAds: [{ earnings: 100, impressions: 1000, clicks: 10 }],
      ads: [],
      transactions: [
        {
          id: "tx_1",
          sessionId: "s1",
          action: "charge",
          amount: 50,
          currency: "USD",
          customer: "alice",
          gateway: "stripe",
          status: "completed",
          proposerDid: "did:key:a",
          proofSignature: "sig",
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
          tenantId: "tenant-a",
        },
      ],
      referrals: [],
      usageEvents: [
        meterRow({ id: "use_a", tenantId: "tenant-a" }),
        meterRow({
          id: "use_b",
          userLogin: "bob",
          runId: "r2",
          tenantId: "tenant-b",
          detailJson: JSON.stringify({ receiptId: "r2", priceUSD: 0.2, protocol: "x402" }),
        }),
        meterRow({
          id: "use_null",
          userLogin: "carol",
          runId: "r3",
          tenantId: null,
          detailJson: JSON.stringify({ receiptId: "r3", priceUSD: 0.3, protocol: "x402" }),
        }),
      ],
    } as never;
    const platform = computeRevenueSummaryFromRows(rows);
    expect(platform.runRevenueByCoverage.find((c) => c.coverage === "paid")?.runs).toBe(3);
    const scoped = computeRevenueSummaryFromRows(rows, { tenantId: "tenant-a" });
    expect(scoped.runRevenueByCoverage.find((c) => c.coverage === "paid")?.runs).toBe(1);
    // The transaction-derived cuts do NOT move with the tenant scope.
    expect(scoped.grossRevenue).toBe(platform.grossRevenue);
    expect(scoped.subscriptionRevenue).toBe(platform.subscriptionRevenue);
    expect(scoped.payPerRunRevenue).toBe(platform.payPerRunRevenue);
  });

  it("the MCP merge dedups DO + mirror rows by id, DO row wins", () => {
    const doRows = [meterRow({ id: "use_1", tenantId: "tenant-a" })];
    const mirrorRows = [
      { ...meterRow({ id: "use_1", tenantId: "tenant-b" }), sourceInstance: "research:alice", projectedAt: "2026-11-20T00:00:00.000Z" },
      { ...meterRow({ id: "use_2", userLogin: "bob" }), sourceInstance: "shared_orchestrator", projectedAt: "2026-11-20T00:00:00.000Z" },
    ];
    const merged = mergeMeterRows(doRows, mirrorRows);
    expect(merged.map((r) => r.id)).toEqual(["use_1", "use_2"]);
    expect(merged[0].tenantId).toBe("tenant-a");
  });
});

describe("3185-B08 retention/DSAR on the DO side", () => {
  it("pruneBefore deletes the 365d window and counts exactly", () => {
    const sql = new MockSqlStorage();
    const store = new DoSqliteUsageEventStore(sql as never);
    store.insertEvent({
      id: "use_old",
      userLogin: "alice",
      runId: "r1",
      category: "research_run",
      createdAt: "2025-01-01T00:00:00.000Z",
      detailJson: null,
      tenantId: "tenant-a",
    });
    store.insertEvent({
      id: "use_new",
      userLogin: "alice",
      runId: "r2",
      category: "research_run",
      createdAt: "2026-11-20T00:00:00.000Z",
      detailJson: null,
      tenantId: "tenant-a",
    });
    expect(store.pruneBefore("2025-11-20T00:00:00.000Z")).toBe(1);
    expect(store.listAllWithDetail().map((r) => r.id)).toEqual(["use_new"]);
    expect(store.pruneBefore("2025-11-20T00:00:00.000Z")).toBe(0);
  });

  it("deleteByUser erases one login only (in-memory twin agrees)", () => {
    const sql = new MockSqlStorage();
    const store = new DoSqliteUsageEventStore(sql as never);
    const mem = new InMemoryUsageEventStore();
    for (const s of [store, mem]) {
      s.insertEvent({
        id: "use_a",
        userLogin: "alice",
        runId: "r1",
        category: "research_run",
        createdAt: "2026-11-20T00:00:00.000Z",
        detailJson: null,
        tenantId: "tenant-a",
      });
      s.insertEvent({
        id: "use_b",
        userLogin: "bob",
        runId: "r2",
        category: "research_run",
        createdAt: "2026-11-20T00:00:00.000Z",
        detailJson: null,
        tenantId: "tenant-b",
      });
    }
    expect(store.deleteByUser("alice")).toBe(1);
    expect(mem.deleteByUser("alice")).toBe(1);
    expect(store.countByUser("alice")).toBe(0);
    expect(store.countByUser("bob")).toBe(1);
    expect(mem.countByUser("bob")).toBe(1);
    expect(store.pruneBefore("2025-01-01T00:00:00.000Z")).toBe(0);
    expect(mem.pruneBefore("2025-01-01T00:00:00.000Z")).toBe(0);
  });
});

describe("3185-B09 the backfill script", () => {
  it("parses logins, limit, base, and cookie", () => {
    const args = parseArgs([
      "--cookie",
      "session=abc",
      "--login",
      "alice",
      "--login",
      "bob",
      "--limit",
      "50",
      "--base",
      "https://example.test/",
    ]);
    expect(args.base).toBe("https://example.test");
    expect(args.cookie).toBe("session=abc");
    expect(args.logins).toEqual(["alice", "bob"]);
    expect(args.limit).toBe(50);
  });

  it("requires a session cookie", () => {
    expect(() => parseArgs(["--login", "alice"])).toThrow(/session cookie/);
  });

  it("summarizes a clean reconcile, a refusal, and an errored reconcile", () => {
    const clean = summarizeInstance("shared_orchestrator", {
      status: 200,
      body: {
        checked: 3,
        reconciled: 1,
        alreadyCurrent: 2,
        tenantDeterministic: 1,
        tenantApproximate: 0,
        tenantUnattributed: 0,
        prunedDo: 0,
        prunedMirror: 0,
        errors: [],
      },
    });
    expect(clean.ok).toBe(true);
    expect(clean.detail).toContain("reconciled=1");
    const refused = summarizeInstance("shared_orchestrator", {
      status: 200,
      body: { refused: "AGENT_DB unbound" },
    });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("refused");
    const failed = summarizeInstance("alice", { status: 403, body: { error: "Forbidden" } });
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("HTTP 403");
  });
});
