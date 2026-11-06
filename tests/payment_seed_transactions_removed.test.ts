/**
 * Issue #175: the orchestrator seeded two fabricated "default"
 * transactions into mas_transactions on first use (ensureTables, when the
 * table was empty): a $25.00 Stripe charge to "Enterprise Team" and a
 * $15.00 PayPal charge to "Acme Partner Corp", both status "completed",
 * stamped with the user's own DID as authorizer, and carrying invented
 * proof signatures and live-shaped gateway references (a `cs_live_…`
 * checkout ref/URL) — the same fabricated signature #151 removed from
 * the DID Proof modal, which had been copied from this seed data. The
 * payments ledger renders mas_transactions and derives its summary
 * (count, totalVolume, completedCount) from the rows, so every fresh
 * store opened with $40.00 of volume and 2 completed payments that
 * never happened.
 *
 * Outcome (a) — removal, decided on a reader trace:
 * - the ledger route (routes/payments.ts) renders the rows and inflates
 *   its summary — that is the bug's symptom, not a dependence;
 * - wallet status (agenticPayments.getWalletStatusSync) counts only
 *   x402/mpp rows — the stripe/paypal seeds never fed it;
 * - the confirm flow requires a draft in "previewed" state — the seeds
 *   were "completed", so nothing could act on them;
 * - no test pinned their existence (#156's tests merely tolerated them).
 *
 * The fix removes the seeding and purges exactly the two seed ids from
 * stores seeded earlier (real draft ids are `pay_` + 8 random hex
 * characters, so those ids can only ever be the seeds).
 *
 * Harness mirrors tests/payment_create_gateway_validation.test.ts
 * (#156): agent-SDK module mocks + MockSqlStorage, driving the real
 * agent's onRequest.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const SEED_ID_STRIPE = "pay_init_stripe";
const SEED_ID_PAYPAL = "pay_init_paypal";
// The fabricated literals that shipped inside the seed rows. They live
// in this test only as pin/fixture strings — never under src/ again.
const FABRICATED_SIG_1 = "sig_0x4b78a9c2e1f40d89e5a1b3c7d6e8f2a4";
const FABRICATED_SIG_2 = "sig_0x8f2d1e4c9b3a7f0e6d5c2a1b4e9f8a7d";
const FABRICATED_GATEWAY_REF = "cs_live_seed_compute_tokens";

const makeEnv = (): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  }) as Env;

const makeAgent = () => {
  const sql = new MockSqlStorage();
  const ctx = {
    id: { toString: () => "seed-removal-175" },
    storage: { sql },
    waitUntil: vi.fn(),
  };
  const agent = new OrchestratorAgent(ctx as any, makeEnv());
  return { agent, sql };
};

const getTransactions = (agent: OrchestratorAgent) =>
  agent.onRequest(new Request("https://agent.internal/payments/transactions", { method: "GET" }));

const allTx = (sql: MockSqlStorage) =>
  Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];

const INSERT_TX =
  "INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const seedRow = (
  sql: MockSqlStorage,
  id: string,
  gateway: string,
  gatewayRef: string,
  amount: number,
  proof: string
) =>
  sql.exec(
    INSERT_TX,
    id,
    "seed-session",
    "charge",
    amount,
    "USD",
    "Seed Customer",
    gateway,
    gatewayRef,
    "completed",
    "",
    "did:agent:payments",
    "did:user:seed",
    proof,
    "seeded before #175",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );

describe("seed transactions removed (#175)", () => {
  it("a fresh store gets NO seeded transactions, and the ledger summary is honestly zero", async () => {
    const { agent, sql } = makeAgent();
    const res = await getTransactions(agent);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.count).toBe(0);
    expect(json.transactions).toEqual([]);
    expect(json.summary.totalVolume).toBe(0);
    expect(json.summary.completedCount).toBe(0);
    expect(json.summary.pendingCount).toBe(0);
    expect(allTx(sql)).toHaveLength(0);
  });

  it("a store seeded before the fix is purged of exactly the seed rows; real rows and totals survive", async () => {
    const { agent, sql } = makeAgent();
    // Pre-populate as a pre-#175 store would look: the two fabricated
    // seeds plus one genuine completed charge.
    seedRow(sql, SEED_ID_STRIPE, "stripe", FABRICATED_GATEWAY_REF, 25.0, FABRICATED_SIG_1);
    seedRow(sql, SEED_ID_PAYPAL, "paypal", "ORDER-789012345", 15.0, FABRICATED_SIG_2);
    sql.exec(
      INSERT_TX,
      "pay_9f8e7d6c",
      "seed-session",
      "charge",
      7.5,
      "USD",
      "Real Customer",
      "stripe",
      "cs_real_9f8e7d6c",
      "completed",
      "",
      "did:agent:payments",
      "did:user:seed",
      "",
      "a genuine payment",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z"
    );
    expect(allTx(sql)).toHaveLength(3);

    const res = await getTransactions(agent);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const ids = (json.transactions as any[]).map((t) => t.id);
    expect(ids).toEqual(["pay_9f8e7d6c"]);
    expect(json.count).toBe(1);
    // Summary derives from the real row alone — no phantom $40.
    expect(json.summary.totalVolume).toBe(7.5);
    expect(json.summary.completedCount).toBe(1);
    expect(allTx(sql).map((r) => r.id)).toEqual(["pay_9f8e7d6c"]);

    // Idempotent: a second request keeps the store clean.
    const res2 = await getTransactions(agent);
    expect(res2.status).toBe(200);
    expect(allTx(sql)).toHaveLength(1);
  });

  it("no fabricated proof signatures or live-shaped seed gateway refs remain anywhere under src/", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
      });
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf8");
      for (const literal of [FABRICATED_SIG_1, FABRICATED_SIG_2, FABRICATED_GATEWAY_REF, "cs_live_seed"]) {
        if (text.includes(literal)) offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the seed ids survive in src/ only as the purge targets in orchestrator.ts", () => {
    // #2942: the purge moved with ensureTables into orchestrator/tableSchema.ts.
    const orchestrator = readFileSync("src/agents/orchestrator/tableSchema.ts", "utf8");
    expect(orchestrator).not.toContain("Seed default transactions");
    for (const id of [SEED_ID_STRIPE, SEED_ID_PAYPAL]) {
      const occurrences = orchestrator.split(id).length - 1;
      expect(occurrences, `${id} should appear exactly once (its DELETE) in orchestrator/tableSchema.ts`).toBe(1);
      // #2359 (#1976 step 4d) pin update: the purge serves
      // through step 3a's transactions port now — the seed id
      // survives as the port delete's argument instead of a
      // raw DELETE statement. The pin's intent is unchanged:
      // the ids exist only as purge targets, never as seeds.
      expect(orchestrator).toContain(`transactions.delete("${id}")`);
    }
    const samples = readFileSync("src/client/mcpEndpointsData.ts", "utf8");
    expect(samples).not.toContain(SEED_ID_STRIPE);
    expect(samples).not.toContain(SEED_ID_PAYPAL);
  });
});
