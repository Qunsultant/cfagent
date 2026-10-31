/**
 * Issue #2543 (Monetization Phase 1.4): receipts/ledger surfacing.
 *
 * Pins:
 * - GET /api/payments/receipts requires a signed-in session (x-user-login);
 *   without it the route refuses with a typed 401, never an asserted identity.
 * - The caller reads back ONLY their own rows: meter rows by user_login
 *   (with detail_json price/tier/protocol), tier-decision audit rows by
 *   sessionId=userLogin, gateway rows joined by receiptId (tx_<id>) and
 *   customer=login — never the unscoped transactions list, never another
 *   identity key's rows (anonymous x402:<payer> rows are recorded but not
 *   returned to session callers).
 * - Provenance is derived, never asserted: meter rows real (verified
 *   protocol); gateway rows simulated iff the SIMULATED markers say so
 *   (status "simulated", SIMULATED note, or the unsigned-proof
 *   signature), else real with the gateway named; tier decisions audit.
 * - The mas_events receipt query SEARCHes the new session index.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("agents", () => {
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handlePaymentsRoutes } from "../src/agents/routes/payments";
import { createCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import { ensureSharedTable } from "../src/data/ormSchema";
import { ensureMasRetentionIndexes } from "../src/data/masRetentionIndexSchema";
import {
  buildReceipts,
  readReceipts,
  resolveGatewayProvenance,
  resolveMeterProvenance,
  METER_RECEIPTS_SQL,
  TIER_DECISIONS_SQL,
  SIMULATED_PROOF_SIGNATURE,
} from "../src/services/receiptSurface";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OWNER = "owner-login";
const OTHER = "other-login";

function makeStore() {
  const sql = new MockSqlStorage() as any;
  const orm = new DatabaseORM(sql);
  ensureSharedTable(sql, "mas_events");
  ensureSharedTable(sql, "mas_transactions");
  createCanonicalReportStorePorts(sql).usage.ensureSchema();
  ensureMasRetentionIndexes(sql);
  return { sql, orm };
}

function seedMeter(
  sql: any,
  row: { id: string; userLogin: string; runId: string; category: string; createdAt: string; detail: unknown },
) {
  sql.exec(
    "INSERT INTO usage_events (id, user_login, run_id, category, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
    row.id,
    row.userLogin,
    row.runId,
    row.category,
    row.createdAt,
    typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail),
  );
}

function seedTier(orm: any, row: { id: string; sessionId: string; payload: Record<string, unknown>; createdAt: string }) {
  orm.events.create({
    id: row.id,
    sessionId: row.sessionId,
    type: "commercial.tier.decision",
    agent: "payments",
    payload: row.payload,
    createdAt: row.createdAt,
  });
}

function seedTx(orm: any, row: Record<string, unknown>) {
  orm.transactions.create({
    id: row.id,
    sessionId: row.sessionId ?? "session-1",
    action: row.action ?? "charge",
    amount: row.amount ?? 0.05,
    currency: "USD",
    customer: row.customer ?? OWNER,
    gateway: row.gateway ?? "stripe",
    gatewayRef: row.gatewayRef ?? "",
    status: row.status ?? "completed",
    checkoutUrl: "",
    proposerDid: "did:agent:openaimp:payments",
    authorizerDid: undefined,
    proofSignature: row.proofSignature ?? "0xsig",
    note: row.note ?? "",
    createdAt: row.createdAt ?? "2026-10-31T10:00:00.000Z",
    updatedAt: row.createdAt ?? "2026-10-31T10:00:00.000Z",
  });
}

async function callReceipts(
  store: ReturnType<typeof makeStore>,
  headers: Record<string, string>,
  query = "",
) {
  const url = new URL(`https://worker.test/api/payments/receipts${query}`);
  const req = new Request(url, { headers });
  const res = await handlePaymentsRoutes(req, url, url.pathname, "session-1", {
    env: {},
    ensureTables: () => store.sql,
    getOrm: () => store.orm,
    audit: () => {},
  } as any);
  return res;
}

describe("receipts route auth (#2543)", () => {
  it("refuses without a session login (typed 401, never an asserted identity)", async () => {
    const store = makeStore();
    const res = await callReceipts(store, {});
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json();
    expect(body.error).toBe("ReceiptsLoginRequired");
    expect(body.statusCode).toBe(401);
  });

  it("rejects an invalid kind and a non-integer limit with typed 400s", async () => {
    const store = makeStore();
    const badKind = await callReceipts(store, { "x-user-login": OWNER }, "?kind=nope");
    expect(badKind!.status).toBe(400);
    expect((await badKind!.json()).error).toBe("ReceiptsInvalidKind");
    const badLimit = await callReceipts(store, { "x-user-login": OWNER }, "?limit=abc");
    expect(badLimit!.status).toBe(400);
    expect((await badLimit!.json()).error).toBe("ReceiptsInvalidLimit");
  });
});

describe("receipts read-back (#2543)", () => {
  it("returns only the caller's meter rows, WITH detail (price/tier/protocol)", async () => {
    const store = makeStore();
    seedMeter(store.sql, {
      id: "use_rcpt_1", userLogin: OWNER, runId: "rcpt_1", category: "options_screener",
      createdAt: "2026-10-31T10:00:00.000Z",
      detail: { receiptId: "rcpt_1", priceUSD: 0.05, tier: "PayPerUse", protocol: "x402" },
    });
    seedMeter(store.sql, {
      id: "use_rcpt_2", userLogin: OWNER, runId: "rcpt_2", category: "stock_signals",
      createdAt: "2026-10-31T11:00:00.000Z",
      detail: { receiptId: "rcpt_2", priceUSD: 0.02, tier: "Free", protocol: "mpp" },
    });
    seedMeter(store.sql, {
      id: "use_rcpt_9", userLogin: OTHER, runId: "rcpt_9", category: "options_screener",
      createdAt: "2026-10-31T12:00:00.000Z",
      detail: { receiptId: "rcpt_9", priceUSD: 0.05, tier: "Subscribed", protocol: "x402" },
    });
    const res = await callReceipts(store, { "x-user-login": OWNER }, "?kind=meter");
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.userLogin).toBe(OWNER);
    expect(body.receipts).toHaveLength(2);
    expect(body.receipts.map((r: any) => r.receiptId).sort()).toEqual(["rcpt_1", "rcpt_2"]);
    const first = body.receipts.find((r: any) => r.receiptId === "rcpt_1");
    expect(first.amountUSD).toBe(0.05);
    expect(first.tier).toBe("PayPerUse");
    expect(first.protocol).toBe("x402");
    expect(first.provenance).toBe("real");
    expect(body.counts.meter).toBe(2);
  });

  it("returns only the caller's tier decisions (sessionId=userLogin), not other sessions or types", async () => {
    const store = makeStore();
    seedTier(store.orm, {
      id: "e1", sessionId: OWNER,
      payload: { userLogin: OWNER, tier: "PayPerUse", receiptId: "rcpt_1", category: "options_screener", priceUSD: 0.05, protocol: "x402" },
      createdAt: "2026-10-31T10:00:00.000Z",
    });
    seedTier(store.orm, {
      id: "e2", sessionId: "some-session-key",
      payload: { userLogin: OWNER, tier: "Subscribed", receiptId: "rcpt_2", category: "stock_signals", priceUSD: 0.02, protocol: "mpp" },
      createdAt: "2026-10-31T11:00:00.000Z",
    });
    store.orm.events.create({
      id: "e3", sessionId: OWNER, type: "commercial.subscription.activated", agent: "payments",
      payload: { userId: OWNER }, createdAt: "2026-10-31T12:00:00.000Z",
    });
    const res = await callReceipts(store, { "x-user-login": OWNER }, "?kind=tier");
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0].receiptId).toBe("rcpt_1");
    expect(body.receipts[0].provenance).toBe("audit");
    expect(body.counts.tier).toBe(1);
  });

  it("joins gateway rows by receiptId and by customer, and excludes other users' rows", async () => {
    const store = makeStore();
    seedMeter(store.sql, {
      id: "use_rcpt_1", userLogin: OWNER, runId: "rcpt_1", category: "options_screener",
      createdAt: "2026-10-31T10:00:00.000Z",
      detail: { receiptId: "rcpt_1", priceUSD: 0.05, tier: "PayPerUse", protocol: "x402" },
    });
    seedTx(store.orm, { id: "tx_rcpt_1", gateway: "x402", gatewayRef: "0xtxhash", status: "completed", customer: "0xPayerAddress" });
    seedTx(store.orm, { id: "tx_stripe_1", gateway: "stripe", status: "completed", customer: OWNER, amount: 5 });
    seedTx(store.orm, { id: "tx_other_1", gateway: "stripe", status: "completed", customer: OTHER, amount: 9 });
    const res = await callReceipts(store, { "x-user-login": OWNER }, "?kind=transaction");
    expect(res!.status).toBe(200);
    const body = await res!.json();
    const ids = body.receipts.map((r: any) => r.id).sort();
    expect(ids).toEqual(["tx_rcpt_1", "tx_stripe_1"]);
    expect(body.counts.transaction).toBe(2);
  });

  it("caps limit at 100 and defaults to 50", async () => {
    const store = makeStore();
    const res = await callReceipts(store, { "x-user-login": OWNER }, "?limit=500");
    const body = await res!.json();
    expect(body.limit).toBe(100);
    const res2 = await callReceipts(store, { "x-user-login": OWNER });
    expect((await res2!.json()).limit).toBe(50);
  });

  it("unified list is newest-first and counts by kind and provenance", async () => {
    const store = makeStore();
    seedMeter(store.sql, {
      id: "use_rcpt_1", userLogin: OWNER, runId: "rcpt_1", category: "options_screener",
      createdAt: "2026-10-31T10:00:00.000Z",
      detail: { receiptId: "rcpt_1", priceUSD: 0.05, tier: "Free", protocol: "x402" },
    });
    seedTier(store.orm, {
      id: "e1", sessionId: OWNER,
      payload: { userLogin: OWNER, tier: "Free", receiptId: "rcpt_1", category: "options_screener", priceUSD: 0.05, protocol: "x402" },
      createdAt: "2026-10-31T10:05:00.000Z",
    });
    seedTx(store.orm, { id: "tx_sim_1", gateway: "stripe", status: "simulated", customer: OWNER, note: "Local record of a SIMULATED outbound payment. [Simulated local payment record — no real payment was made or verified.]", createdAt: "2026-10-31T09:00:00.000Z" });
    const res = await callReceipts(store, { "x-user-login": OWNER });
    const body = await res!.json();
    expect(body.receipts.map((r: any) => r.kind)).toEqual(["tier", "meter", "transaction"]);
    expect(body.counts).toEqual({ meter: 1, tier: 1, transaction: 1, real: 1, simulated: 1, audit: 1 });
    const sim = body.receipts.find((r: any) => r.kind === "transaction");
    expect(sim.provenance).toBe("simulated");
  });
});

describe("receipt provenance (#2543)", () => {
  it("meter rows are real for both verified protocols", () => {
    expect(resolveMeterProvenance("x402").provenance).toBe("real");
    expect(resolveMeterProvenance("mpp").provenance).toBe("real");
  });

  it("gateway rows are simulated iff the SIMULATED markers say so", () => {
    expect(resolveGatewayProvenance({ status: "simulated", note: "", proofSignature: "0xsig" }).provenance).toBe("simulated");
    expect(resolveGatewayProvenance({ status: "completed", note: "Local record of a SIMULATED outbound payment.", proofSignature: "0xsig" }).provenance).toBe("simulated");
    expect(resolveGatewayProvenance({ status: "completed", note: "", proofSignature: SIMULATED_PROOF_SIGNATURE }).provenance).toBe("simulated");
    expect(resolveGatewayProvenance({ status: "completed", note: "", proofSignature: "0xsig" }).provenance).toBe("real");
    expect(resolveGatewayProvenance({ status: "awaiting_confirmation", note: "", proofSignature: "0xsig" }).provenance).toBe("real");
  });

  it("buildReceipts sorts newest-first and caps at limit", () => {
    const out = buildReceipts({
      userLogin: OWNER,
      meterRows: [
        { id: "use_a", runId: "a", category: "c", createdAt: "2026-10-31T10:00:00.000Z", receiptId: "a", priceUSD: 0.05, tier: "Free", protocol: "x402", detailAvailable: true },
        { id: "use_b", runId: "b", category: "c", createdAt: "2026-10-31T11:00:00.000Z", receiptId: "b", priceUSD: 0.02, tier: "Free", protocol: "mpp", detailAvailable: true },
      ],
      tierRows: [],
      gatewayRows: [],
      limit: 1,
    });
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].receiptId).toBe("b");
    expect(out.limit).toBe(1);
  });
});

describe("receipt readers (#2543)", () => {
  it("readReceipts returns meter rows with detail over the sql seam", () => {
    const store = makeStore();
    seedMeter(store.sql, {
      id: "use_rcpt_1", userLogin: OWNER, runId: "rcpt_1", category: "options_screener",
      createdAt: "2026-10-31T10:00:00.000Z",
      detail: { receiptId: "rcpt_1", priceUSD: 0.05, tier: "PayPerUse", protocol: "x402" },
    });
    const out = readReceipts({ sql: store.sql, orm: store.orm }, OWNER, { limit: 50, kind: "meter" });
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].amountUSD).toBe(0.05);
    expect(out.receipts[0].tier).toBe("PayPerUse");
  });

  it("corrupt meter detail keeps the row (existence proves a served call) with nulls", () => {
    const store = makeStore();
    seedMeter(store.sql, {
      id: "use_rcpt_1", userLogin: OWNER, runId: "rcpt_1", category: "options_screener",
      createdAt: "2026-10-31T10:00:00.000Z",
      detail: "{not-json",
    });
    const out = readReceipts({ sql: store.sql, orm: store.orm }, OWNER, { limit: 50, kind: "meter" });
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].amountUSD).toBeNull();
    expect(out.receipts[0].provenance).toBe("real");
  });
});

describe("mas_events session index (#2543)", () => {
  function makeSql(db: DatabaseSync) {
    return {
      exec: (query: string, ...args: unknown[]) => {
        const stmt = db.prepare(query);
        if (/^\s*(SELECT|EXPLAIN|PRAGMA|WITH)\b/i.test(query)) {
          return stmt.all(...(args as any[])) as unknown[];
        }
        stmt.run(...(args as any[]));
        return [];
      },
    };
  }

  it("the receipt tier query SEARCHes idx_mas_events_session_type after ensure", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE IF NOT EXISTS mas_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      previous_event_hash TEXT, event_hash TEXT)`);
    db.prepare("INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("e1", OWNER, "commercial.tier.decision", "payments", "{}", "2026-10-31T10:00:00.000Z");
    // ensureMasRetentionIndexes also indexes mas_messages; the table must exist first.
    ensureSharedTable(makeSql(db) as any, "mas_messages");
    ensureMasRetentionIndexes(makeSql(db) as any);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${TIER_DECISIONS_SQL}`).all(OWNER, "commercial.tier.decision", 50) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(" | ");
    expect(text).toContain("SEARCH mas_events USING INDEX idx_mas_events_session_type");
    expect(text).not.toContain("SCAN");
  });

  it("the receipt meter query SEARCHes the usage_events user index", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY, user_login TEXT NOT NULL, run_id TEXT NOT NULL,
      category TEXT NOT NULL, created_at TEXT NOT NULL, detail_json TEXT)`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events (user_login, created_at DESC)");
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${METER_RECEIPTS_SQL}`).all(OWNER, 50) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(" | ");
    expect(text).toContain("SEARCH usage_events USING INDEX idx_usage_events_user");
    expect(text).not.toContain("SCAN");
  });
});
