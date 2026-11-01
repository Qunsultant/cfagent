/**
 * Issue #2019 — unit tests for the durable cfpay ledger module.
 *
 * Builders, row predicates, reconciliation, and the SEARCH_AGENT client
 * against a fake stub. No worker runtime, no D1, no network, no key.
 * The orchestrator endpoint handler itself (agenticPayments.ts) is
 * covered by repo CI; its row construction is exactly these builders.
 */
import { describe, expect, it } from "vitest";
import {
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
  cfpayLedgerSessionId,
  findCfpayRowBySessionAndAction,
  isCfpayLedgerRow,
  listCfpayLedgerRows,
  recordCfpayAuditEvent,
  recordCfpayLedgerRow,
  reconcileCfpayRun,
} from "../src/services/cfpayLedger";
import type { Env, TransactionRecord } from "../src/types";

const chargeInput = {
  runRequestId: "run-1",
  userId: "u1",
  family: "goal",
  priceUSD: 0.1,
  checkoutId: "chk-1",
  claimTxHash: "0xabc",
  paymentIntentId: "pi-1",
};

describe("cfpay ledger builders (#2019)", () => {
  it("charge row carries the cfpay attribution, never the x402 one", () => {
    const tx = buildCfpayChargeTransaction(chargeInput, new Date("2026-10-28T00:00:00Z"));
    expect(tx.sessionId).toBe("screener-payment:run-1");
    expect(tx.action).toBe("charge");
    expect(tx.gateway).toBe("stripe");
    expect(tx.amount).toBe(0.1);
    expect(tx.currency).toBe("USD");
    expect(tx.customer).toBe("u1");
    expect(tx.gatewayRef).toBe("chk-1");
    expect(tx.status).toBe("completed");
    expect(tx.proofSignature).toBe("0xabc");
    expect(tx.note).toContain("goal run run-1");
    expect(tx.note).toContain("pi-1");
    expect(tx.createdAt).toBe("2026-10-28T00:00:00.000Z");
  });

  it("charge row falls back to the run id when no checkout id is known", () => {
    const tx = buildCfpayChargeTransaction({ ...chargeInput, checkoutId: undefined });
    expect(tx.gatewayRef).toBe("run-1");
  });

  it("credit row is a replacement grant, not a cash refund (#2549 wording)", () => {
    const tx = buildCfpayCreditTransaction({
      runRequestId: "run-1",
      userId: "u1",
      family: "goal",
      priceUSD: 0.1,
    });
    expect(tx.sessionId).toBe("screener-payment:run-1");
    expect(tx.action).toBe("credit");
    expect(tx.gateway).toBe("stripe");
    expect(tx.amount).toBe(0.1);
    expect(tx.status).toBe("completed");
    expect(tx.gatewayRef).toBe("credit:run-1");
    expect(tx.note).toContain("replacement-run credit");
    expect(tx.note).toContain("this credit is not a cash refund");
  });

  it("session predicate and per-kind lookup scope rows to one run", () => {
    const charge = buildCfpayChargeTransaction(chargeInput);
    const credit = buildCfpayCreditTransaction({ ...chargeInput });
    const other = buildCfpayChargeTransaction({ ...chargeInput, runRequestId: "run-2" });
    expect(isCfpayLedgerRow(charge)).toBe(true);
    expect(isCfpayLedgerRow({ ...charge, sessionId: "payments-agent:x" })).toBe(false);
    const rows = [charge, credit, other];
    expect(findCfpayRowBySessionAndAction(rows, "run-1", "charge")).toBe(charge);
    expect(findCfpayRowBySessionAndAction(rows, "run-1", "credit")).toBe(credit);
    expect(findCfpayRowBySessionAndAction(rows, "run-2", "credit")).toBeUndefined();
  });
});

describe("cfpay reconciliation (#2019)", () => {
  it("paid in cfpay and charged in the ledger matches", () => {
    const rows = [buildCfpayChargeTransaction(chargeInput)];
    const r = reconcileCfpayRun(rows, "run-1", "fulfilled");
    expect(r.matched).toBe(true);
    expect(r.chargePresent).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("paid in cfpay with no charge row mismatches", () => {
    const r = reconcileCfpayRun([], "run-1", "paid");
    expect(r.matched).toBe(false);
    expect(r.reasons[0]).toMatch(/no charge row/);
  });

  it("charged in the ledger with cfpay unpaid mismatches", () => {
    const rows = [buildCfpayChargeTransaction(chargeInput)];
    const r = reconcileCfpayRun(rows, "run-1", "pending");
    expect(r.matched).toBe(false);
    expect(r.reasons[0]).toMatch(/does not report paid/);
  });

  it("unpaid in both ledgers matches, and a credit does not change the match", () => {
    expect(reconcileCfpayRun([], "run-1", "pending").matched).toBe(true);
    const rows = [
      buildCfpayChargeTransaction(chargeInput),
      buildCfpayCreditTransaction({ ...chargeInput }),
    ];
    const r = reconcileCfpayRun(rows, "run-1", "fulfilled");
    expect(r.matched).toBe(true);
    expect(r.creditPresent).toBe(true);
  });
});

describe("cfpay ledger client (#2019)", () => {
  function fakeEnv(seen: Map<string, TransactionRecord>, auditBodies: Array<Record<string, unknown>> = []): Env {
    const stub = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        if (url.pathname.endsWith("/record-cfpay") && req.method === "POST") {
          const kind = body["kind"] as string;
          const runRequestId = body["runRequestId"] as string;
          const key = `${runRequestId}:${kind}`;
          const existing = seen.get(key);
          if (existing) return Response.json({ duplicate: true, record: existing }, { status: 409 });
          const tx = (
            kind === "charge"
              ? buildCfpayChargeTransaction(body as unknown as typeof chargeInput)
              : buildCfpayCreditTransaction(body as unknown as typeof chargeInput)
          ) as TransactionRecord;
          seen.set(key, tx);
          return Response.json({ duplicate: false, record: tx });
        }
        if (url.pathname.endsWith("/ledger/cfpay") && req.method === "GET") {
          const runRequestId = url.searchParams.get("runRequestId") ?? "";
          const rows = [...seen.values()].filter(
            (t) => t.sessionId === cfpayLedgerSessionId(runRequestId),
          );
          return Response.json({ runRequestId, count: rows.length, rows });
        }
        if (url.pathname.endsWith("/audit/event") && req.method === "POST") {
          auditBodies.push(body as Record<string, unknown>);
          return Response.json({ id: "evt-1" }, { status: 201 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    };
    return {
      SERVICE_USER_LOGIN: "svc-test",
      SEARCH_AGENT: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    } as unknown as Env;
  }

  it("records a charge, then dedupes a replayed write", async () => {
    const seen = new Map<string, TransactionRecord>();
    const env = fakeEnv(seen);
    const first = await recordCfpayLedgerRow(env, "charge", chargeInput);
    expect(first.duplicate).toBe(false);
    expect(first.record.sessionId).toBe("screener-payment:run-1");
    const replay = await recordCfpayLedgerRow(env, "charge", chargeInput);
    expect(replay.duplicate).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(seen.size).toBe(1);
  });

  it("records one credit per run and lists rows for reconciliation", async () => {
    const seen = new Map<string, TransactionRecord>();
    const env = fakeEnv(seen);
    await recordCfpayLedgerRow(env, "charge", chargeInput);
    const credit = await recordCfpayLedgerRow(env, "credit", { ...chargeInput });
    expect(credit.duplicate).toBe(false);
    expect(credit.record.action).toBe("credit");
    const replay = await recordCfpayLedgerRow(env, "credit", { ...chargeInput });
    expect(replay.duplicate).toBe(true);
    const rows = await listCfpayLedgerRows(env, "run-1");
    expect(rows).toHaveLength(2);
    expect(reconcileCfpayRun(rows, "run-1", "fulfilled").matched).toBe(true);
  });

  it("audit write returns true on success and false when the ledger is unreachable", async () => {
    const seen = new Map<string, TransactionRecord>();
    const env = fakeEnv(seen);
    const ok = await recordCfpayAuditEvent(env, {
      type: "payment.confirmed",
      runRequestId: "run-1",
      tenantId: "t1",
      priceUSD: 0.1,
    });
    expect(ok).toBe(true);
    const noBinding = await recordCfpayAuditEvent({} as Env, {
      type: "payment.confirmed",
      runRequestId: "run-1",
      tenantId: "t1",
    });
    expect(noBinding).toBe(false);
  });

  it("audit payload carries family and paidVia for the revenue report (#2022)", async () => {
    const seen = new Map<string, TransactionRecord>();
    const auditBodies: Array<Record<string, unknown>> = [];
    const env = fakeEnv(seen, auditBodies);
    await recordCfpayAuditEvent(env, {
      type: "payment.covered",
      runRequestId: "run-1",
      tenantId: "t1",
      priceUSD: 0.1,
      family: "goal",
      paidVia: "subscription_included",
    });
    expect(auditBodies).toHaveLength(1);
    const payload = auditBodies[0]["payload"] as Record<string, unknown>;
    expect(payload["family"]).toBe("goal");
    expect(payload["paidVia"]).toBe("subscription_included");
    expect(payload["runRequestId"]).toBe("run-1");
  });

  it("ledger writes throw loud when the binding or identity is missing", async () => {
    await expect(recordCfpayLedgerRow({} as Env, "charge", chargeInput)).rejects.toThrow(
      /not bound/,
    );
    const noIdentity = fakeEnv(new Map());
    delete (noIdentity as unknown as Record<string, unknown>)["SERVICE_USER_LOGIN"];
    await expect(recordCfpayLedgerRow(noIdentity, "charge", chargeInput)).rejects.toThrow(
      /service identity/,
    );
  });
});
