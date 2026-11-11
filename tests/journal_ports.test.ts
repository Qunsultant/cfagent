// @vitest-environment node
/**
 * Issue #2155 ([Ledger] Minimal double-entry journal, sub-issue
 * of #2012) — port conformance + pins, TDD.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter. A
 * behavior that passes on one adapter and fails on the other is
 * a layer defect, not an application bug.
 *
 * Pinned contracts:
 *  - Balanced-post invariant: an unbalanced set throws before
 *    any write; a multi-tenant set throws; an unknown account
 *    throws; exactly one nonzero side per entry.
 *  - Idempotent replay: reposting a transactionRef is a no-op.
 *  - Tenant isolation: no unscoped read; one tenant's entries
 *    are invisible to another.
 *  - Minimal chart: 1000/2000/4000/5000 seeded; 5000 reserved
 *    (no mapping writes to it yet).
 *  - Migration 0009 owns the journal DDL; the Drizzle schema
 *    maps it (column parity pinned here).
 *  - Port modules never import a store client; mapping/posting
 *    modules never import drizzle-orm (structural grep pins).
 *  - Wiring: a throwing journal port never fails the ledger
 *    write (best-effort posting resolves).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import { InMemoryJournalAdapter } from "../src/data/inMemoryJournalAdapter";
import { MIGRATION_0009_JOURNAL, MIGRATION_0058_PRODUCT_VERSIONS } from "../src/data/migrationRunner";
import {
  agentJournalAccounts,
  agentJournalEntries,
} from "../src/data/drizzleSchema";
import {
  mapChargeToJournalEntries,
  mapFailureCreditToJournalEntries,
  mapRedemptionToJournalEntries,
  mapSubscriptionPurchaseToJournalEntries,
  mapTopUpToJournalEntries,
  reconcileJournal,
  trialBalance,
  type JournalPort,
} from "../src/data/journalPorts";
import { postJournalBestEffort } from "../src/services/journalPosting";

/** Minimal D1Database stand-in over node:sqlite (test-only). */
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
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
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
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

async function makeD1Store(): Promise<JournalPort> {
  const mock = new MockD1Database();
  const db = createD1JournalDb(mock as any);
  await ensureJournalSchema(db);
  return new D1JournalAdapter(db);
}

const makers: Array<{ name: string; make: () => Promise<JournalPort> }> = [
  { name: "Drizzle D1 adapter", make: makeD1Store },
  { name: "in-memory adapter", make: async () => new InMemoryJournalAdapter() },
];

describe.each(makers)("journal port conformance (#2155) — $name", ({ make }) => {
  it("posts a balanced charge pair and trial-balances", async () => {
    const store = await make();
    const entries = await store.postEntries(
      mapChargeToJournalEntries({
        transactionRef: "run-1",
        tenantId: "tenant-a",
        runRequestId: "run-1",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.accountCode).sort()).toEqual(["1000", "4000"]);
    const balance = await trialBalance(store, "tenant-a");
    expect(balance.balanced).toBe(true);
    expect(balance.totalDebits).toBe(0.1);
    expect(balance.totalCredits).toBe(0.1);
    expect(balance.accounts.find((a) => a.code === "1000")?.debitTotal).toBe(0.1);
    expect(balance.accounts.find((a) => a.code === "4000")?.creditTotal).toBe(0.1);
  });

  it("rejects an unbalanced post before writing anything", async () => {
    const store = await make();
    await expect(
      store.postEntries([
        {
          transactionRef: "run-bad",
          accountCode: "1000",
          debitUSD: 0.1,
          creditUSD: 0,
          currency: "USD",
          tenantId: "tenant-a",
          runRequestId: "run-bad",
          family: "goal",
        },
      ]),
    ).rejects.toThrow(/Unbalanced/);
    expect(await store.listEntries("tenant-a")).toHaveLength(0);
  });

  it("rejects a multi-tenant post and an unknown account", async () => {
    const store = await make();
    const base = mapChargeToJournalEntries({
      transactionRef: "run-mixed",
      tenantId: "tenant-a",
      runRequestId: "run-mixed",
      family: "goal",
      productId: "prod-per-run-goal",
      versionId: "cat-goal-default-v1",
      amountUSD: 0.1,
    });
    await expect(
      store.postEntries([{ ...base[1], tenantId: "tenant-b" }, base[0]]),
    ).rejects.toThrow(/exactly one tenant/);
    await expect(
      store.postEntries([
        { ...base[0], accountCode: "9999" },
        { ...base[1], accountCode: "9999" },
      ]),
    ).rejects.toThrow(/Unknown journal account/);
    expect(await store.listEntries("tenant-a")).toHaveLength(0);
  });

  it("replaying a transactionRef is a no-op", async () => {
    const store = await make();
    const input = mapChargeToJournalEntries({
      transactionRef: "run-replay",
      tenantId: "tenant-a",
      runRequestId: "run-replay",
      family: "stock",
      productId: "prod-per-run-stock",
      versionId: "cat-stock-default-v1",
      amountUSD: 0.02,
    });
    const first = await store.postEntries(input);
    const second = await store.postEntries(input);
    expect(second.map((e) => e.id).sort()).toEqual(first.map((e) => e.id).sort());
    expect(await store.listEntries("tenant-a")).toHaveLength(2);
  });

  it("isolates tenants: no unscoped read, no cross-tenant visibility", async () => {
    const store = await make();
    await store.postEntries(
      mapChargeToJournalEntries({
        transactionRef: "run-a",
        tenantId: "tenant-a",
        runRequestId: "run-a",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    expect(await store.listEntries("tenant-b")).toHaveLength(0);
    const balanceB = await trialBalance(store, "tenant-b");
    expect(balanceB.totalDebits).toBe(0);
    expect(balanceB.totalCredits).toBe(0);
    expect(balanceB.balanced).toBe(true);
  });

  it("trial-balances charge + failure credit + redemption", async () => {
    const store = await make();
    await store.postEntries(
      mapChargeToJournalEntries({
        transactionRef: "run-2",
        tenantId: "tenant-a",
        runRequestId: "run-2",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    await store.postEntries(
      mapFailureCreditToJournalEntries({
        transactionRef: "run-2:credit",
        tenantId: "tenant-a",
        runRequestId: "run-2",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    await store.postEntries(
      mapRedemptionToJournalEntries({
        transactionRef: "run-3",
        tenantId: "tenant-a",
        runRequestId: "run-3",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    const balance = await trialBalance(store, "tenant-a");
    expect(balance.balanced).toBe(true);
    expect(balance.totalDebits).toBe(0.3);
    expect(balance.totalCredits).toBe(0.3);
    expect(balance.accounts.find((a) => a.code === "1000")).toMatchObject({
      debitTotal: 0.1,
      creditTotal: 0,
    });
    expect(balance.accounts.find((a) => a.code === "2000")).toMatchObject({
      debitTotal: 0.1,
      creditTotal: 0.1,
    });
    expect(balance.accounts.find((a) => a.code === "4000")).toMatchObject({
      debitTotal: 0.1,
      creditTotal: 0.2,
    });
  });

  it("seeds the minimal chart including reserved 5000 and deferred-revenue 2100", async () => {
    const store = await make();
    const accounts = await store.listAccounts();
    expect(accounts.map((a) => a.code)).toEqual(["1000", "2000", "2100", "4000", "5000"]);
    expect(accounts.find((a) => a.code === "5000")?.name).toMatch(/Refunds/);
    expect(accounts.find((a) => a.code === "2100")).toMatchObject({
      name: "Deferred revenue",
      type: "liability",
    });
  });
});

describe("journal mappings (#2155)", () => {
  it("maps charge, failure credit, and redemption to exact pairs", () => {
    const input = {
      transactionRef: "run-x",
      tenantId: "tenant-a",
      runRequestId: "run-x",
      family: "options",
      productId: "prod-per-run-options",
      versionId: "cat-options-default-v1",
      amountUSD: 0.05,
    };
    const charge = mapChargeToJournalEntries(input);
    expect(charge.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["1000", 0.05, 0],
      ["4000", 0, 0.05],
    ]);
    // Issue #3289: every per-run entry records which product /
    // version / price applied (per-charge recording, §3.9).
    for (const e of charge) {
      expect(e.productId).toBe("prod-per-run-options");
      expect(e.versionId).toBe("cat-options-default-v1");
      expect(e.priceUSD).toBe(0.05);
    }
    const credit = mapFailureCreditToJournalEntries(input);
    expect(credit.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["4000", 0.05, 0],
      ["2000", 0, 0.05],
    ]);
    const redemption = mapRedemptionToJournalEntries(input);
    expect(redemption.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["2000", 0.05, 0],
      ["4000", 0, 0.05],
    ]);
    for (const e of [...credit, ...redemption]) {
      expect(e.productId).toBe("prod-per-run-options");
      expect(e.versionId).toBe("cat-options-default-v1");
      expect(e.priceUSD).toBe(0.05);
    }
    expect(() =>
      mapChargeToJournalEntries({ ...input, amountUSD: 0 }),
    ).toThrow(/positive finite/);
    // Issue #3289: the mapping refuses a new per-run event
    // without the product/version (fail-closed).
    expect(() =>
      mapChargeToJournalEntries({
        transactionRef: "run-x",
        tenantId: "tenant-a",
        runRequestId: "run-x",
        family: "options",
        amountUSD: 0.05,
      }),
    ).toThrow(/requires productId and versionId/);
  });
});

describe("journal subscription purchase mapping (#2155 follow-up)", () => {
  const input = {
    transactionRef: "sub-draft-1",
    tenantId: "tenant-a",
    subscriptionId: "sub-abc12345",
    amountUSD: 20,
    // Issue #3289: a subscription purchase records the version
    // that was bought — planId IS the version id.
    productId: "prod-sub-basic",
    versionId: "plan-basic-v1",
  };

  it("maps a purchase to Dr 1000 / Cr 2100, never to revenue", () => {
    const entries = mapSubscriptionPurchaseToJournalEntries(input);
    expect(entries.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["1000", 20, 0],
      ["2100", 0, 20],
    ]);
    for (const e of entries) {
      expect(e.transactionRef).toBe("sub-draft-1");
      expect(e.tenantId).toBe("tenant-a");
      expect(e.runRequestId).toBe("sub-abc12345");
      expect(e.family).toBe("subscription");
      expect(e.currency).toBe("USD");
      // Issue #3289: the purchase records the version bought.
      expect(e.productId).toBe("prod-sub-basic");
      expect(e.versionId).toBe("plan-basic-v1");
      expect(e.priceUSD).toBe(20);
    }
    expect(() => mapSubscriptionPurchaseToJournalEntries({ ...input, amountUSD: 0 })).toThrow(
      /positive finite/,
    );
    expect(() => mapSubscriptionPurchaseToJournalEntries({ ...input, subscriptionId: "" })).toThrow(
      /subscriptionId/,
    );
  });

  it("posts the pair on both adapters and shows deferred revenue as a liability in the trial balance", async () => {
    for (const make of makers) {
      const store = await make.make();
      const accounts = await store.listAccounts();
      const deferred = accounts.find((a) => a.code === "2100");
      expect(deferred).toMatchObject({ name: "Deferred revenue", type: "liability" });
      const posted = await store.postEntries(mapSubscriptionPurchaseToJournalEntries(input));
      expect(posted).toHaveLength(2);
      // Replay of the same purchase ref is a no-op, never a double post.
      const replayed = await store.postEntries(mapSubscriptionPurchaseToJournalEntries(input));
      expect(replayed).toHaveLength(2);
      expect(await store.listEntries("tenant-a")).toHaveLength(2);
      const balance = await trialBalance(store, "tenant-a");
      expect(balance.balanced).toBe(true);
      expect(balance.totalDebits).toBe(20);
      expect(balance.totalCredits).toBe(20);
      const row = balance.accounts.find((a) => a.code === "2100");
      expect(row).toMatchObject({ type: "liability", debitTotal: 0, creditTotal: 20 });
      expect(balance.accounts.find((a) => a.code === "4000")).toMatchObject({
        debitTotal: 0,
        creditTotal: 0,
      });
    }
  });

  it("a throwing journal port never fails the purchase (best-effort)", async () => {
    const throwingPort: JournalPort = {
      async postEntries() {
        throw new Error("D1 unavailable");
      },
      async listEntries() {
        return [];
      },
      async getEntriesByRef() {
        return [];
      },
      async listAccounts() {
        return [];
      },
    };
    // The purchase activation happens first and succeeds; the
    // journal post follows best-effort. The sequence resolves
    // with the purchase result intact, whatever the journal does.
    const purchase = { subscriptionId: "sub-abc12345", status: "active" };
    await expect(
      postJournalBestEffort(async () => throwingPort, mapSubscriptionPurchaseToJournalEntries(input)),
    ).resolves.toBeUndefined();
    expect(purchase.status).toBe("active");
  });
});

describe("journal top-up mapping (#3262)", () => {
  const input = {
    transactionRef: "topup-draft-1",
    tenantId: "tenant-a",
    amountUSD: 25,
  };

  it("maps a top-up to Dr 1000 / Cr 2100, never to revenue", () => {
    const entries = mapTopUpToJournalEntries(input);
    expect(entries.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["1000", 25, 0],
      ["2100", 0, 25],
    ]);
    for (const e of entries) {
      expect(e.transactionRef).toBe("topup-draft-1");
      expect(e.tenantId).toBe("tenant-a");
      expect(e.runRequestId).toBe("topup-draft-1");
      expect(e.family).toBe("top_up");
      expect(e.currency).toBe("USD");
    }
    expect(() => mapTopUpToJournalEntries({ ...input, amountUSD: 0 })).toThrow(/positive finite/);
    expect(() => mapTopUpToJournalEntries({ ...input, transactionRef: "" })).toThrow(/transactionRef/);
  });

  it("posts the pair on both adapters; replay of the same top-up ref is a no-op", async () => {
    for (const make of makers) {
      const store = await make.make();
      const posted = await store.postEntries(mapTopUpToJournalEntries(input));
      expect(posted).toHaveLength(2);
      const replayed = await store.postEntries(mapTopUpToJournalEntries(input));
      expect(replayed).toHaveLength(2);
      expect(await store.listEntries("tenant-a")).toHaveLength(2);
      const balance = await trialBalance(store, "tenant-a");
      expect(balance.balanced).toBe(true);
      expect(balance.totalDebits).toBe(25);
      expect(balance.totalCredits).toBe(25);
    }
  });
});

describe("journal reconcile (#2155)", () => {
  it("matches ledger refs, flags gaps, and treats balanced redemptions as informational", async () => {
    const store = new InMemoryJournalAdapter();
    await store.postEntries(
      mapChargeToJournalEntries({
        transactionRef: "run-1",
        tenantId: "tenant-a",
        runRequestId: "run-1",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    await store.postEntries(
      mapFailureCreditToJournalEntries({
        transactionRef: "run-1:credit",
        tenantId: "tenant-a",
        runRequestId: "run-1",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    await store.postEntries(
      mapRedemptionToJournalEntries({
        transactionRef: "run-2",
        tenantId: "tenant-a",
        runRequestId: "run-2",
        family: "goal",
        productId: "prod-per-run-goal",
        versionId: "cat-goal-default-v1",
        amountUSD: 0.1,
      }),
    );
    const entries = await store.listEntries("tenant-a");
    const report = reconcileJournal(
      [
        { transactionRef: "run-1", amountUSD: 0.1 },
        { transactionRef: "run-1:credit", amountUSD: 0.1 },
        { transactionRef: "run-missing", amountUSD: 0.1 },
      ],
      entries,
    );
    expect(report.matchedRefs).toEqual(["run-1", "run-1:credit"]);
    expect(report.journalOnlyBalancedRefs).toEqual(["run-2"]);
    expect(report.mismatched.map((m) => m.transactionRef)).toEqual(["run-missing"]);
    expect(report.balanced).toBe(false);
    expect(report.totalDebits).toBe(0.3);
    expect(report.totalCredits).toBe(0.3);
  });
});

describe("journal structural pins (#2155)", () => {
  function importLines(file: string): string[] {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
  }

  it("port and posting modules import no store client", () => {
    for (const file of ["data/journalPorts.ts", "services/journalPosting.ts"]) {
      const imports = importLines(file).join("\n");
      expect(imports).not.toContain("drizzle-orm");
      expect(imports).not.toContain("D1Database");
      expect(imports).not.toContain("d1JournalAdapter");
      expect(imports).not.toContain("inMemoryJournalAdapter");
    }
  });

  it("migration DDL and Drizzle schema agree on columns for both tables", () => {
    for (const [table, mapping] of [
      ["agent_journal_accounts", agentJournalAccounts],
      ["agent_journal_entries", agentJournalEntries],
    ] as const) {
      const rawColumns = getTableConfig(mapping).columns as any;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: any) => c.name as string)
        : Object.keys(rawColumns).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = MIGRATION_0009_JOURNAL.sql.split(
        `CREATE TABLE IF NOT EXISTS ${table} (`,
      )[1].split(");")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      // Issue #3289: migration 0058 adds the per-charge
      // recording columns to agent_journal_entries by ALTER.
      const alterColumns =
        table === "agent_journal_entries"
          ? [
              ...MIGRATION_0058_PRODUCT_VERSIONS.sql.matchAll(
                /ALTER TABLE agent_journal_entries ADD COLUMN (\w+)/g,
              ),
            ].map((m) => m[1])
          : [];
      expect([...ddlColumns, ...alterColumns].sort()).toEqual(schemaColumns.sort());
    }
  });
});

describe("journal best-effort wiring (#2155)", () => {
  it("a throwing journal port never fails the ledger write", async () => {
    const throwingPort: JournalPort = {
      async postEntries() {
        throw new Error("D1 unavailable");
      },
      async listEntries() {
        return [];
      },
      async getEntriesByRef() {
        return [];
      },
      async listAccounts() {
        return [];
      },
    };
    // The ledger write happens first and succeeds; the journal
    // post follows best-effort. The whole sequence must resolve
    // with the ledger result intact, whatever the journal does.
    const ledgerWrite = async () => ({ duplicate: false, rowId: "cfpay_abc123" });
    const ledger = await ledgerWrite();
    await expect(
      postJournalBestEffort(
        async () => throwingPort,
        mapChargeToJournalEntries({
          transactionRef: "run-1",
          tenantId: "tenant-a",
          runRequestId: "run-1",
          family: "goal",
          productId: "prod-per-run-goal",
          versionId: "cat-goal-default-v1",
          amountUSD: 0.1,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(ledger.rowId).toBe("cfpay_abc123");
  });

  it("a null adapter (unbound AGENT_DB) resolves, never throws", async () => {
    await expect(
      postJournalBestEffort(
        async () => null,
        mapChargeToJournalEntries({
          transactionRef: "run-1",
          tenantId: "tenant-a",
          runRequestId: "run-1",
          family: "goal",
          productId: "prod-per-run-goal",
          versionId: "cat-goal-default-v1",
          amountUSD: 0.1,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("a throwing setup closure resolves, never throws", async () => {
    await expect(
      postJournalBestEffort(async () => {
        throw new Error("ensure failed");
      }, []),
    ).resolves.toBeUndefined();
  });
});
