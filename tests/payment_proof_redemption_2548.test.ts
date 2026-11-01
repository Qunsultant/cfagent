// @vitest-environment node
/**
 * Issue #2548 — durable x402/payment proof redemption, TDD.
 *
 * The native gate's replay guard was per-instance in-memory
 * (byClaim), while the workflow builds a fresh gate per run and
 * confirm normally runs against a fresh gate after a durable
 * resume — so the same x402 proof could be redeemed by two
 * different runs, and the stateless confirm had no nonce binding
 * at all. Redemption is now recorded in a durable store keyed by
 * the claim/session/nonce+payer (and the proof payload hash), so
 * a proof redeems exactly once across gate instances and process
 * restarts; the nonce becomes part of that durable identity,
 * which is the binding the stateless path was missing.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1ProofRedemptionDb,
  D1ProofRedemptionAdapter,
  ensureProofRedemptionSchema,
} from "../src/data/d1ProofRedemptionAdapter";
import { InMemoryProofRedemptionAdapter } from "../src/data/inMemoryProofRedemptionAdapter";
import {
  claimRedemptionKey,
  x402NonceRedemptionKey,
  type ProofRedemptionStore,
} from "../src/data/proofRedemptionPorts";
import { MIGRATION_0029_PROOF_REDEMPTIONS } from "../src/data/migrationRunner";
import { agentPaymentProofRedemptions } from "../src/data/drizzleSchema";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { X402CheckoutAdapter } from "../src/services/x402CheckoutAdapter";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import type { CheckoutPorts } from "../src/services/checkoutPorts";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db.prepare(sql).all(...(params as any[])).map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function stores(): Promise<Array<{ name: string; store: ProofRedemptionStore; restart: () => Promise<ProofRedemptionStore> }>> {
  const mock = new MockD1Database();
  const db = createD1ProofRedemptionDb(mock as unknown as D1Database);
  await ensureProofRedemptionSchema(db);
  const mem = new InMemoryProofRedemptionAdapter();
  return [
    {
      name: "in-memory",
      store: mem,
      restart: async () => mem,
    },
    {
      name: "drizzle-d1",
      store: new D1ProofRedemptionAdapter(db),
      // A restart = a brand-new adapter over the same database.
      restart: async () => new D1ProofRedemptionAdapter(createD1ProofRedemptionDb(mock as unknown as D1Database)),
    },
  ];
}

function facilitatorStub(opts: { isValid: boolean }) {
  const fn = (async () => ({ ok: true, json: async () => ({ isValid: opts.isValid }) })) as unknown as typeof fetch;
  return fn;
}

async function approvedCatalogue(): Promise<InMemoryPriceCatalogueAdapter> {
  const catalogue = new InMemoryPriceCatalogueAdapter();
  // #2547 composition: seeded prices sit at 'proposed' until an
  // operator approves them, and the gate refuses unapproved prices
  // fail-closed — so approve the goal seed through the operator
  // API here, exactly as production requires.
  await catalogue.approvePrice({ family: "goal", approverId: "test-operator" });
  return catalogue;
}

async function x402Gate(store: ProofRedemptionStore): Promise<NativeMonetizationGate> {
  const ports: CheckoutPorts = {
    card: null,
    x402: new X402CheckoutAdapter({ recipientAddress: RECIPIENT, network: "base-sepolia", fetchFn: facilitatorStub({ isValid: true }) }),
  };
  return new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: await approvedCatalogue(),
    checkout: ports,
    proofRedemptions: store,
  });
}

function x402Proof(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ signature: "0xsig", payer: PAYER, ...fields })).toString("base64");
}

const RUN1 = { id: "run-1", userId: "u1", email: "u1@example.com", family: "goal" as const };
const RUN2 = { id: "run-2", userId: "u1", email: "u1@example.com", family: "goal" as const };

describe("proof redemption store (#2548)", () => {
  it("records once: a second record for another run is a duplicate naming the first run", async () => {
    for (const { store } of await stores()) {
      const key = x402NonceRedemptionKey("n_abc", PAYER);
      const first = await store.recordRedemption({ redemptionKey: key, runRequestId: "run-1", rail: "x402", payer: PAYER });
      expect(first.duplicate).toBe(false);
      expect(first.record.runRequestId).toBe("run-1");
      const second = await store.recordRedemption({ redemptionKey: key, runRequestId: "run-2", rail: "x402", payer: PAYER });
      expect(second.duplicate).toBe(true);
      expect(second.record.runRequestId).toBe("run-1");
      const found = await store.findRedemption(key);
      expect(found?.runRequestId).toBe("run-1");
      expect(await store.findRedemption(claimRedemptionKey("nope"))).toBeNull();
    }
  });

  it("migration DDL and Drizzle schema agree on columns", () => {
    const rawColumns = getTableConfig(agentPaymentProofRedemptions).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    const block = MIGRATION_0029_PROOF_REDEMPTIONS.sql.split(
      "CREATE TABLE IF NOT EXISTS agent_payment_proof_redemptions (",
    )[1].split(");")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
    expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
  });
});

describe("native gate durable redemption (#2548)", () => {
  it("the same x402 proof confirmed statelessly for two runs: the second is refused across gate instances", async () => {
    for (const { store } of await stores()) {
      const proof = x402Proof({ nonce: "n_run1_challenge" });
      const gateA = await x402Gate(store);
      const first = await gateA.confirmPaid(RUN1, { paymentProof: proof, payer: PAYER });
      expect(first).toMatchObject({ allowed: true, status: "paid", paidVia: "x402" });
      // A fresh gate (durable resume / a different run) shares only the store.
      const gateB = await x402Gate(store);
      await expect(gateB.confirmPaid(RUN2, { paymentProof: proof, payer: PAYER })).rejects.toThrow(/already redeemed for run run-1/);
    }
  });

  it("redemption survives a restart: a new adapter over the same store still refuses the replay", async () => {
    for (const { store, restart } of await stores()) {
      const proof = x402Proof({ nonce: "n_restart" });
      await (await x402Gate(store)).confirmPaid(RUN1, { paymentProof: proof, payer: PAYER });
      const gateAfterRestart = await x402Gate(await restart());
      await expect(gateAfterRestart.confirmPaid(RUN2, { paymentProof: proof, payer: PAYER })).rejects.toThrow(/already redeemed/);
    }
  });

  it("the nonce is part of the durable identity: a different proof carrying the redeemed nonce+payer is refused", async () => {
    for (const { store } of await stores()) {
      const gateA = await x402Gate(store);
      await gateA.confirmPaid(RUN1, { paymentProof: x402Proof({ nonce: "n_bound", signature: "0xaaa" }), payer: PAYER });
      const gateB = await x402Gate(store);
      // Same nonce + payer, different payload bytes (different signature).
      await expect(
        gateB.confirmPaid(RUN2, { paymentProof: x402Proof({ nonce: "n_bound", signature: "0xbbb" }), payer: PAYER }),
      ).rejects.toThrow(/already redeemed/);
    }
  });

  it("re-confirming the SAME run with the same proof stays idempotent (paid, not refused)", async () => {
    for (const { store } of await stores()) {
      const proof = x402Proof({ nonce: "n_idem" });
      await (await x402Gate(store)).confirmPaid(RUN1, { paymentProof: proof, payer: PAYER });
      const again = await (await x402Gate(store)).confirmPaid(RUN1, { paymentProof: proof, payer: PAYER });
      expect(again).toMatchObject({ allowed: true, status: "paid" });
    }
  });

  it("a stripe session redeemed by one run cannot confirm another run on a fresh gate", async () => {
    for (const { store } of await stores()) {
      const client: StripeCheckoutClient = {
        async createCheckout(params) {
          return { success: true, checkoutUrl: "https://checkout.example/x", gatewayRef: `cs_test_${params.draftId}` };
        },
        async retrieveSession(sessionId) {
          return { id: sessionId, status: "complete", payment_status: "paid", amount_total: 10, client_reference_id: "run-1", payment_intent: "pi_1" };
        },
      };
      const ports: CheckoutPorts = { card: new StripeCheckoutAdapter(client), x402: null };
      const mk = async () =>
        new NativeMonetizationGate({
          monetizationEnabled: true,
          priceCatalogue: await approvedCatalogue(),
          checkout: ports,
          proofRedemptions: store,
        });
      const first = await (await mk()).confirmPaid(RUN1, { sessionId: "cs_test_run-1" });
      expect(first).toMatchObject({ allowed: true, status: "paid" });
      await expect((await mk()).confirmPaid(RUN2, { sessionId: "cs_test_run-1" })).rejects.toThrow(/already redeemed for run run-1/);
    }
  });
});
