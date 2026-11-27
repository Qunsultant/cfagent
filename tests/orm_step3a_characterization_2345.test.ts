// @vitest-environment node
/**
 * Issue #2345 (#1976 step 3a, ADR 0022 D-I step 3a) —
 * CHARACTERIZATION pins for the ORM core (the 13 mas_* tables
 * behind src/orm), written against the UNMODIFIED DatabaseORM
 * before the port cutover. They pin current behaviour through
 * the existing public surface (the same import path the cutover
 * turns into a §22 re-export shim over src/data):
 *
 *  - initializeSchema: the 13 tables, idempotent re-entry, the
 *    marketplace seed counts (categories 5 / external ads 4 /
 *    ads 2) landing exactly once;
 *  - generic Repository CRUD semantics as found: camelCase ↔
 *    snake_case mapping with boolean coercion, findMany
 *    order/limit/offset, findOne, count, create returning the
 *    passed record and throwing raw on a PK conflict, update's
 *    re-read (null for a missing id), upsert's check-then-act;
 *  - the audit chain (#2178): events.create links
 *    previousEventHash → eventHash and the stored chain
 *    verifies via verifyStoredAuditChain;
 *  - the aggregate helpers as found: revenue summary rates
 *    (external-ad earnings, $20 + $0.50/click marketplace,
 *    2.5% on settled charges, $10/signup referral payouts),
 *    watchlist symbol dedupe/upper-casing, options-chain
 *    cache TTL + upsert;
 *  - the reports repository's AS-FOUND stale read map: a row
 *    stored with user_login/body_r2_key reads back with those
 *    columns leaking through UNMAPPED (snake_case keys, no
 *    userLogin/bodyR2Key props) — the port cutover completes
 *    the map and the conformance suite pins the completed
 *    contract;
 *  - Repository.delete's AS-FOUND return: true even when the
 *    row does not exist (ADR 0022 D-E.2 violation — silently
 *    wrong for the retention counter that sums it). The
 *    cutover flips that one pin to the resolved contract
 *    (false when nothing was deleted), disclosed here and in
 *    the PR, mirroring step 2's divergence-flip practice.
 *
 * These pins must be green before the cutover and green after
 * it (modulo the one disclosed flip) — that is what makes the
 * cutover a behaviour-preserving move rather than a rewrite.
 *
 * DOUBLES: node:sqlite-backed SqlStorage (real SQLite
 * semantics), because the shared MockSqlStorage cannot execute
 * the chained-audit tail read or the revenue reads' shapes.
 * MockSqlStorage round-trips stay pinned by the pre-existing
 * suites.
 */
import { DatabaseSync } from "node:sqlite";
import { MockD1Database } from "./mock-d1";
import { describe, expect, it } from "vitest";
import {
  DatabaseORM,
  MissingOrmError,
  requireOrm,
  verifyStoredAuditChain,
} from "../src/orm";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
  transactionSync<T>(closure: (txn: { sql: SqliteTestStorage }) => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure({ sql: this });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

function freshOrm(): { orm: DatabaseORM; storage: SqliteTestStorage } {
  const storage = new SqliteTestStorage();
  const orm = new DatabaseORM(storage as never);
  orm.initializeSchema("sess-char");
  return { orm, storage };
}

describe("characterization: schema + seeds as found", () => {
  it("initializeSchema creates the 13 tables and is idempotent", () => {
    const { orm, storage } = freshOrm();
    const tables = Array.from(
      storage.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ) as Array<{ name: string }>,
    ).map((r) => r.name);
    for (const t of [
      "mas_messages", "mas_events", "mas_memory", "mas_watchlists",
      "mas_transactions", "mas_trades", "mas_categories",
      "mas_external_ads", "mas_ads", "mas_referrals",
      "webhook_replay_nonces", "mas_options_chain_cache", "mas_reports",
    ]) {
      expect(tables, t).toContain(t);
    }
    expect(() => orm.initializeSchema("sess-char")).not.toThrow();
    expect(orm.categories.count()).toBe(5);
    expect(orm.externalAds.count()).toBe(4);
    expect(orm.ads.count()).toBe(2);
  });

  it("listTables returns metadata for the 11 described tables by default", () => {
    const { orm } = freshOrm();
    const names = orm.listTables().map((t) => t.name);
    expect(names).toContain("mas_categories");
    expect(names).toContain("mas_reports");
    expect(names).toHaveLength(11);
    expect(orm.getTableData("mas_categories").total).toBe(5);
  });
});

describe("characterization: repository CRUD semantics as found", () => {
  it("maps booleans camelCase ↔ snake_case on categories", () => {
    const { orm, storage } = freshOrm();
    const created = orm.categories.create({
      id: "cat-x", name: "X", slug: "x", description: "d", icon: "i",
      isActive: false, sortOrder: 9,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(created.isActive).toBe(false);
    const raw = (storage.exec("SELECT is_active FROM mas_categories WHERE id = 'cat-x'") as Array<{ is_active: number }>)[0];
    expect(raw.is_active).toBe(0);
    expect(orm.categories.findById("cat-x")?.isActive).toBe(false);
    const updated = orm.categories.update("cat-x", { isActive: true });
    expect(updated?.isActive).toBe(true);
  });

  it("findMany honours where/orderBy/limit; findOne and count agree", () => {
    const { orm } = freshOrm();
    const active = orm.categories.findMany({ where: { isActive: true }, orderBy: "sort_order ASC" });
    expect(active.length).toBe(5);
    expect(active[0].sortOrder).toBeLessThanOrEqual(active[1].sortOrder);
    expect(orm.categories.findOne({ slug: "ai-dev-tools" })?.name).toBe("AI & Dev Tools");
    expect(orm.categories.findMany({ limit: 2 })).toHaveLength(2);
    expect(orm.categories.count({ isActive: true })).toBe(5);
  });

  it("update of a missing id returns null; create PK conflict throws raw", () => {
    const { orm } = freshOrm();
    expect(orm.categories.update("nope", { name: "Z" })).toBeNull();
    expect(() =>
      orm.categories.create({
        id: "cat_ai_dev", name: "Dup", slug: "dup", description: "d", icon: "i",
        isActive: true, sortOrder: 1,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("delete removes an existing row and returns true", () => {
    const { orm } = freshOrm();
    orm.memory.create({ key: "k1", value: "v1", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(orm.memory.delete("k1")).toBe(true);
    expect(orm.memory.findById("k1")).toBeNull();
  });

  // RESOLVED at the step-3a cutover (disclosed D-E.2 fix): the
  // pre-port implementation returned true even when no row
  // existed; the port contract returns false when nothing was
  // deleted. As-found behaviour is recorded in this file's
  // header.
  it("delete of a missing row returns false (D-E.2 resolved contract; was true as found)", () => {
    const { orm } = freshOrm();
    expect(orm.memory.delete("never-existed")).toBe(false);
  });

  it("upsert is check-then-act over the key id field (memory)", () => {
    const { orm } = freshOrm();
    orm.memory.upsert({ key: "k", value: "v1", updatedAt: "2026-01-01T00:00:00.000Z" });
    orm.memory.upsert({ key: "k", value: "v2", updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(orm.memory.count()).toBe(1);
    expect(orm.memory.findById("k")?.value).toBe("v2");
  });
});

describe("characterization: audit chain as found (#2178)", () => {
  it("events.create chains hashes and the stored chain verifies", () => {
    const { orm } = freshOrm();
    const e1 = orm.events.create({
      id: "ev1", sessionId: "s1", type: "login", agent: "orchestrator",
      payload: { ok: true }, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const e2 = orm.events.create({
      id: "ev2", sessionId: "s1", type: "trade", agent: "orchestrator",
      payload: { ok: true }, createdAt: "2026-01-01T00:01:00.000Z",
    });
    expect(e1.previousEventHash).toBeNull();
    expect(e2.previousEventHash).toBe(e1.eventHash);
    expect(e1.eventHash).toBeTruthy();
    expect(verifyStoredAuditChain(orm)).toBe(true);
  });
});

describe("characterization: aggregate helpers as found", () => {
  it("getRevenueSummary applies the as-found rates", () => {
    const { orm } = freshOrm();
    // Seeds as found: ext earnings 62.81 over 387 impressions /
    // 28 clicks; 2 marketplace ads.
    const seeded = orm.getRevenueSummary();
    expect(seeded.adNetworkRevenue).toBeCloseTo(62.81);
    expect(seeded.totalImpressions).toBe(387);
    expect(seeded.totalAdClicks).toBe(28);
    expect(seeded.marketplaceRevenue).toBeCloseTo(66); // 2×$20 + 52 clicks×$0.50
    orm.externalAds.create({
      id: "ext-x", name: "X", network: "n", placement: "p", title: "t",
      tagline: "tg", ctaText: "c", targetUrl: "https://x",
      impressions: 100, clicks: 5, earnings: 10, isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    orm.transactions.create({
      id: "tx-x", sessionId: "s", action: "charge", amount: 200, currency: "USD",
      customer: "c", gateway: "stripe", gatewayRef: "g", status: "completed",
      checkoutUrl: "", proposerDid: "did:x", authorizerDid: "did:y",
      proofSignature: "sig", note: "",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    orm.referrals.create({
      id: "ref-x", userLogin: "alice", title: "R", url: "https://x",
      category: "stocks", rewardText: "r", clicks: 3, signups: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const s = orm.getRevenueSummary();
    expect(s.adNetworkRevenue).toBeCloseTo(72.81);
    expect(s.paymentPlatformFees).toBeCloseTo(5); // 2.5% of the settled $200 charge
    expect(s.referralPayouts).toBeCloseTo(20); // 2 signups × $10
    expect(s.grossRevenue).toBeCloseTo(72.81 + 66 + 5);
    expect(s.netRevenue).toBeCloseTo(72.81 + 66 + 5 - 20);
  });

  it("watchlist helpers dedupe + uppercase symbols within a save", () => {
    const { orm } = freshOrm();
    const saved = orm.saveWatchlist({ name: "Main", userLogin: "alice", symbols: ["aapl", "AAPL", " msft "], items: [] });
    expect(JSON.parse(saved.symbolsJson)).toEqual(["AAPL", "MSFT"]);
    const lists = orm.getWatchlists("alice");
    expect(lists).toHaveLength(1);
    expect(orm.getWatchlistByName("main", "alice")?.id).toBe(saved.id);
    expect(orm.getWatchlists("bob")).toHaveLength(0);
  });

  it("options chain helpers: set/get round-trip and TTL expiry", () => {
    const { orm } = freshOrm();
    orm.setOptionsChain("aapl", [{ exp: "2026-01" }], [{ pairs: [{ call: { s: 1 }, put: { s: 2 } }] }], 600);
    const hit = orm.getOptionsChain("AAPL");
    expect(hit?.expirations).toEqual([{ exp: "2026-01" }]);
    expect(hit?.contractCount).toBe(2);
    orm.setOptionsChain("MSFT", [], [], -1);
    expect(orm.getOptionsChain("MSFT")).toBeNull();
    expect(orm.optionsChainCache.findById("AAPL")?.symbol).toBe("AAPL");
  });

  it("canonical report door is idempotent on generationId; reports repo reads the AS-FOUND stale map", async () => {
    const { orm } = freshOrm();
    const input = {
      runId: "run-1", generationId: "gen-1", userLogin: "alice",
      title: "T", source: "scheduler", summary: "S", body: "B",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    // #6101: the door is async now and lands in D1 (idempotent on
    // generation id via the D1 dedupe), so the door assertions
    // bind AGENT_DB and await.
    const d1 = new MockD1Database();
    const first = await orm.storeCanonicalReport(input as any, { AGENT_DB: d1 } as any);
    const second = await orm.storeCanonicalReport(input as any, { AGENT_DB: d1 } as any);
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    // The repo half still pins the DO repo's completed column map —
    // seeded through the repo itself (the door no longer writes DO).
    orm.reports.create({
      id: "rep-1",
      runId: "run-1",
      generationId: "gen-1",
      title: "T",
      source: "scheduler",
      summary: "S",
      body: "B",
      userLogin: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const rows = orm.reports.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "run-1", title: "T", generationId: "gen-1" });
    // COMPLETED at the step-3a cutover (disclosed V-5 fix): as
    // found, the ORM's reports map had no user_login/body_r2_key,
    // so the stored owner column leaked through unmapped under
    // its snake_case key and no userLogin prop existed. The
    // port's completed map returns userLogin mapped.
    expect((rows[0] as Record<string, unknown>).userLogin).toBe("alice");
    expect((rows[0] as Record<string, unknown>).user_login).toBeUndefined();
  });

  it("trades + webhook replay nonces round-trip", () => {
    const { orm } = freshOrm();
    orm.trades.create({
      id: "t1", sessionId: "s", symbol: "AAPL", action: "buy", orderType: "limit",
      quantity: 1, price: 10, totalValue: 10, status: "open", orderRef: "r1",
      proposerDid: "did:x", authorizerDid: "did:y", proofSignature: "sig",
      previewNotes: "", expirationScheduleId: "",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(orm.trades.findOne({ symbol: "AAPL" })?.id).toBe("t1");
    orm.webhookReplay.create({ nonce: "n1", source: "stripe", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    expect(orm.webhookReplay.findById("n1")?.source).toBe("stripe");
    expect(orm.webhookReplay.delete("n1")).toBe(true);
  });

  it("execQuery returns rows as found (passthrough pinned before retirement)", () => {
    const { orm } = freshOrm();
    const rows = orm.execQuery("SELECT COUNT(*) AS n FROM mas_categories");
    expect(rows[0].n).toBe(5);
  });

  it("requireOrm contract: value passes through, missing throws MissingOrmError naming the context", () => {
    const { orm } = freshOrm();
    expect(requireOrm(orm, "flow")).toBe(orm);
    expect(() => requireOrm(undefined, "MyFlow")).toThrow(MissingOrmError);
    expect(() => requireOrm(undefined, "MyFlow")).toThrow(/MyFlow requires a DatabaseORM/);
  });
});
