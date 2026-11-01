// @vitest-environment node
/**
 * Issue #1761 ([1717] Tenancy isolation: app-level WHERE-clause
 * leak class, SEC-006 / DATA-003) — fail-closed tenant scope,
 * TDD (Red first: the journal and lifecycle assertions below
 * fail against the pre-fix adapters, which read tenant-carrying
 * tables without predicating on tenant_id).
 *
 * What this suite proves, against BOTH the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter:
 *  - Binding: bindTenantScope throws on a missing/blank tenant —
 *    there is no unscoped query path through the mechanism.
 *  - Journal: getEntriesByRef(transactionRef, tenantId) returns
 *    only the bound tenant's entries; a replay post in another
 *    tenant throws (fail closed) instead of returning the first
 *    tenant's entries or silently dropping the write on the
 *    tenant-blind entry id (the pre-fix idempotency check read
 *    across tenants).
 *  - Lifecycle: getPreferences(userId, tenantId) returns the
 *    defaults — never another tenant's stored row — when the
 *    tenant does not match; setPreferences for a mismatched
 *    tenant throws instead of overwriting the other tenant's
 *    row (the pre-fix upsert conflicted on user_id alone).
 *
 * #CISO-bhdm
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  bindTenantScope,
  tenantScopeId,
  TenantScopeError,
} from "../src/data/tenantScope";
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import { InMemoryJournalAdapter } from "../src/data/inMemoryJournalAdapter";
import {
  mapChargeToJournalEntries,
  type JournalPort,
} from "../src/data/journalPorts";
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
} from "../src/data/d1LifecycleAdapter";
import { InMemoryLifecycleAdapter } from "../src/data/inMemoryLifecycleAdapter";
import type { LifecycleStore } from "../src/data/lifecyclePorts";

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
}

async function makeD1Journal(): Promise<JournalPort> {
  const mock = new MockD1Database();
  const db = createD1JournalDb(mock as any);
  await ensureJournalSchema(db);
  return new D1JournalAdapter(db);
}

async function makeD1Lifecycle(): Promise<LifecycleStore> {
  const mock = new MockD1Database();
  const db = createD1LifecycleDb(mock as unknown as D1Database);
  const adapter = new D1LifecycleAdapter(db);
  await ensureLifecycleSchema(db);
  return adapter;
}

describe("tenant scope binding (#1761)", () => {
  it("binds a non-empty tenant id", () => {
    const scope = bindTenantScope("tenant-a");
    expect(tenantScopeId(scope)).toBe("tenant-a");
  });

  it.each(["", "   ", undefined, null, 42])(
    "fails closed on an unbound tenant (%s): no scope, no query",
    (bad) => {
      expect(() => bindTenantScope(bad)).toThrow(TenantScopeError);
    },
  );
});

describe.each([
  { name: "Drizzle D1 adapter", makeJournal: makeD1Journal, makeLifecycle: makeD1Lifecycle },
  {
    name: "in-memory adapter",
    makeJournal: async () => new InMemoryJournalAdapter(),
    makeLifecycle: async () => new InMemoryLifecycleAdapter(),
  },
])("tenant-scoped reads (#1761) — $name", ({ makeJournal, makeLifecycle }) => {
  it("journal: a filter-omitted read cannot return another tenant's entries", async () => {
    const store = await makeJournal();
    await store.postEntries(
      mapChargeToJournalEntries({
        transactionRef: "run-1",
        tenantId: "tenant-a",
        runRequestId: "run-1",
        family: "goal",
        amountUSD: 0.1,
      }),
    );
    // Same transactionRef, wrong tenant: tenant-empty, never tenant-a rows.
    expect(await store.getEntriesByRef("run-1", "tenant-b")).toHaveLength(0);
    expect(await store.getEntriesByRef("run-1", "tenant-a")).toHaveLength(2);
  });

  it("journal: a replay post in another tenant fails closed instead of inheriting or clobbering the first tenant's entries", async () => {
    const store = await makeJournal();
    await store.postEntries(
      mapChargeToJournalEntries({
        transactionRef: "run-1",
        tenantId: "tenant-a",
        runRequestId: "run-1",
        family: "goal",
        amountUSD: 0.1,
      }),
    );
    // The entry id is tenant-blind (`ref:account`), so a
    // cross-tenant replay can neither write (D1 id conflict)
    // nor return the first tenant's rows (leak). Fail closed:
    // it throws, tenant-a's rows survive, tenant-b reads empty.
    await expect(
      store.postEntries(
        mapChargeToJournalEntries({
          transactionRef: "run-1",
          tenantId: "tenant-b",
          runRequestId: "run-1",
          family: "goal",
          amountUSD: 0.1,
        }),
      ),
    ).rejects.toThrow(TenantScopeError);
    expect(await store.getEntriesByRef("run-1", "tenant-a")).toHaveLength(2);
    expect(await store.getEntriesByRef("run-1", "tenant-b")).toHaveLength(0);
  });

  it("lifecycle: preferences for a mismatched tenant return defaults, never another tenant's row", async () => {
    const store = await makeLifecycle();
    await store.setPreferences({
      userId: "u1",
      tenantId: "tenant-a",
      digestEnabled: true,
      welcomeEnabled: false,
    });
    expect((await store.getPreferences("u1", "tenant-a")).digestEnabled).toBe(true);
    const other = await store.getPreferences("u1", "tenant-b");
    // Defaults: digest OFF / welcome ON — not tenant-a's stored values.
    expect(other.digestEnabled).toBe(false);
    expect(other.welcomeEnabled).toBe(true);
    expect(other.tenantId).toBe("tenant-b");
  });

  it("lifecycle: a write for a mismatched tenant throws instead of overwriting the other tenant's row", async () => {
    const store = await makeLifecycle();
    await store.setPreferences({
      userId: "u1",
      tenantId: "tenant-a",
      digestEnabled: true,
      welcomeEnabled: false,
    });
    await expect(
      store.setPreferences({
        userId: "u1",
        tenantId: "tenant-b",
        digestEnabled: false,
      }),
    ).rejects.toThrow(TenantScopeError);
    // Tenant-a's row survives untouched.
    const kept = await store.getPreferences("u1", "tenant-a");
    expect(kept.digestEnabled).toBe(true);
    expect(kept.welcomeEnabled).toBe(false);
  });
});
