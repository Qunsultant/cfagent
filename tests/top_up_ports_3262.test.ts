/**
 * Issue #3262 — top-up draft port contract (D1 + in-memory).
 *
 * The draft is the replay guard and the amount binding for one
 * self-service top-up: minted at checkout, credited exactly once
 * on verified payment. Mirrors the cfpay channel draft port
 * (#2945): types only in topUpPorts.ts, Drizzle D1 + in-memory
 * adapters behind the interface, migration 0048 for the table.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertTopUpDraftStatus,
  assertTopUpRail,
  type TopUpDraft,
} from "../src/data/topUpPorts";
import {
  createD1TopUpDb,
  D1TopUpAdapter,
  ensureTopUpSchema,
} from "../src/data/d1TopUpAdapter";
import { InMemoryTopUpAdapter } from "../src/data/inMemoryTopUpAdapter";

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

const draft = (over: Partial<TopUpDraft> = {}): TopUpDraft => ({
  id: "topup-draft-1",
  userLogin: "u1",
  tenantId: "t1",
  email: "u1@example.com",
  amountUSD: 25,
  rail: "card",
  status: "minted",
  createdAtMs: 1_000,
  creditedAtMs: null,
  paymentIntentId: null,
  checkoutSessionId: null,
  challengeNonce: null,
  ...over,
});

describe("top-up draft validators", () => {
  it("accepts minted/credited and card/x402; rejects anything else", () => {
    expect(assertTopUpDraftStatus("minted")).toBe("minted");
    expect(assertTopUpDraftStatus("credited")).toBe("credited");
    expect(() => assertTopUpDraftStatus("fulfilled")).toThrow(/minted.*credited|status/);
    expect(() => assertTopUpDraftStatus("")).toThrow();
    expect(assertTopUpRail("card")).toBe("card");
    expect(assertTopUpRail("x402")).toBe("x402");
    expect(() => assertTopUpRail("cash")).toThrow(/rail/);
  });
});

describe.each([
  {
    name: "in-memory",
    make: async () => new InMemoryTopUpAdapter(),
  },
  {
    name: "Drizzle D1",
    make: async () => {
      const mock = new MockD1Database();
      const db = createD1TopUpDb(mock as unknown as D1Database);
      await ensureTopUpSchema(db);
      return new D1TopUpAdapter(db);
    },
  },
])("top-up draft store contract — $name", ({ make }) => {
  it("creates, reads, credits once, and lists by user", async () => {
    const store = await make();
    expect(await store.getDraft("topup-missing")).toBeNull();
    const created = await store.createDraft(draft());
    expect(created.status).toBe("minted");
    expect((await store.getDraft("topup-draft-1"))?.amountUSD).toBe(25);
    const credited = await store.markCredited("topup-draft-1", {
      creditedAtMs: 2_000,
      paymentIntentId: "pi_test_1",
      checkoutSessionId: "cs_test_1",
    });
    expect(credited.status).toBe("credited");
    expect(credited.creditedAtMs).toBe(2_000);
    expect(credited.paymentIntentId).toBe("pi_test_1");
    // A second credit of the same draft refuses: the draft is the replay guard.
    await expect(
      store.markCredited("topup-draft-1", {
        creditedAtMs: 3_000,
        paymentIntentId: "pi_test_1",
        checkoutSessionId: "cs_test_1",
      }),
    ).rejects.toThrow(/already credited/);
    await expect(
      store.markCredited("topup-missing", {
        creditedAtMs: 3_000,
        paymentIntentId: null,
        checkoutSessionId: null,
      }),
    ).rejects.toThrow(/Unknown top-up draft/);
    await store.createDraft(draft({ id: "topup-draft-2", userLogin: "u2", amountUSD: 10, rail: "x402" }));
    expect((await store.listByUser("u1")).map((d) => d.id)).toEqual(["topup-draft-1"]);
    expect((await store.listByUser("u2")).map((d) => d.id)).toEqual(["topup-draft-2"]);
  });
});
