// @vitest-environment node
/**
 * Issue #3247 (sub-issue of #3241), slice 1 — free-access
 * grants: the port asserts, the pure active predicate, the
 * in-memory adapter, and the D1 adapter over node:sqlite, plus
 * migration 0064 (agent_free_access_grants).
 *
 * A grant is the durable, revocable record of free ACCESS for
 * one login: no tier, no included runs, no free runs. One
 * active grant per login; granting replaces the active grant
 * (the old row is revoked, kept as history). Expiry and
 * revocation are filters, not deletions.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import { agentFreeAccessGrants } from "../src/data/drizzleSchema";
import {
  createD1FreeAccessGrantDb,
  D1FreeAccessGrantAdapter,
  ensureFreeAccessGrantSchema,
} from "../src/data/d1FreeAccessGrantAdapter";
import { InMemoryFreeAccessGrantAdapter } from "../src/data/inMemoryFreeAccessGrantAdapter";
import {
  assertFreeAccessGrantInput,
  assertFreeAccessGrantKind,
  isFreeAccessGrantActive,
  type FreeAccessGrantPort,
  type FreeAccessGrantRecord,
} from "../src/data/freeAccessGrantPorts";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const LATER = NOW + 86_400_000;

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

async function makeD1(): Promise<FreeAccessGrantPort> {
  const mock = new MockD1Database();
  const db = createD1FreeAccessGrantDb(mock as unknown as D1Database);
  await ensureFreeAccessGrantSchema(db);
  return new D1FreeAccessGrantAdapter(db);
}

/** One fresh adapter of each implementation, for parity tests. */
async function adapters(): Promise<Array<{ name: string; port: FreeAccessGrantPort }>> {
  return [
    { name: "in-memory", port: new InMemoryFreeAccessGrantAdapter() },
    { name: "D1", port: await makeD1() },
  ];
}

function grantInput(overrides: Record<string, unknown> = {}) {
  return {
    login: "u1",
    kind: "lifetime",
    expiresAtMs: null,
    reason: "Owner-approved pilot account",
    grantedBy: "op1",
    nowMs: NOW,
    ...overrides,
  } as {
    login: string;
    kind: FreeAccessGrantRecord["kind"];
    expiresAtMs: number | null;
    reason: string;
    grantedBy: string;
    nowMs: number;
  };
}

describe("free-access grant validators (#3247)", () => {
  it("accepts a lifetime grant with no expiry and a limited grant with a future expiry", () => {
    expect(assertFreeAccessGrantInput(grantInput(), NOW)).toMatchObject({
      login: "u1",
      kind: "lifetime",
      expiresAtMs: null,
    });
    expect(
      assertFreeAccessGrantInput(grantInput({ kind: "limited", expiresAtMs: LATER }), NOW),
    ).toMatchObject({ kind: "limited", expiresAtMs: LATER });
  });

  it("rejects an unknown kind", () => {
    expect(() => assertFreeAccessGrantKind("forever")).toThrow(/must be "lifetime" or "limited"/);
    expect(() => assertFreeAccessGrantInput(grantInput({ kind: "forever" }), NOW)).toThrow(
      /must be "lifetime" or "limited"/,
    );
  });

  it("a lifetime grant forbids expiresAtMs", () => {
    expect(() => assertFreeAccessGrantInput(grantInput({ expiresAtMs: LATER }), NOW)).toThrow(
      /must be null for a lifetime grant/,
    );
  });

  it("a limited grant requires a future integer expiry", () => {
    expect(() => assertFreeAccessGrantInput(grantInput({ kind: "limited" }), NOW)).toThrow(
      /must be an epoch-ms integer in the future/,
    );
    expect(() =>
      assertFreeAccessGrantInput(grantInput({ kind: "limited", expiresAtMs: NOW - 1 }), NOW),
    ).toThrow(/must be an epoch-ms integer in the future/);
    expect(() =>
      assertFreeAccessGrantInput(grantInput({ kind: "limited", expiresAtMs: NOW }), NOW),
    ).toThrow(/must be an epoch-ms integer in the future/);
    expect(() =>
      assertFreeAccessGrantInput(grantInput({ kind: "limited", expiresAtMs: NOW + 0.5 }), NOW),
    ).toThrow(/must be an epoch-ms integer in the future/);
  });

  it("rejects a blank login, grantedBy, or reason (trimmed, no length cap — the #3245 shape)", () => {
    expect(() => assertFreeAccessGrantInput(grantInput({ login: "  " }), NOW)).toThrow(
      /login must be a non-empty string/,
    );
    expect(() => assertFreeAccessGrantInput(grantInput({ grantedBy: "" }), NOW)).toThrow(
      /grantedBy must be a non-empty string/,
    );
    expect(() => assertFreeAccessGrantInput(grantInput({ reason: "   " }), NOW)).toThrow(
      /reason must be a non-empty string/,
    );
    expect(assertFreeAccessGrantInput(grantInput({ reason: "  Pilot  " }), NOW).reason).toBe("Pilot");
  });

  it("isFreeAccessGrantActive: null, revoked, and expired are inactive; unrevoked unexpired is active", () => {
    expect(isFreeAccessGrantActive(null, NOW)).toBe(false);
    expect(isFreeAccessGrantActive(undefined, NOW)).toBe(false);
    const base: FreeAccessGrantRecord = {
      id: "freeaccess-1",
      login: "u1",
      kind: "lifetime",
      grantedBy: "op1",
      grantedAtMs: NOW,
      expiresAtMs: null,
      revokedAtMs: null,
      reason: "Pilot",
    };
    expect(isFreeAccessGrantActive(base, NOW)).toBe(true);
    expect(isFreeAccessGrantActive({ ...base, revokedAtMs: NOW }, NOW)).toBe(false);
    expect(isFreeAccessGrantActive({ ...base, kind: "limited", expiresAtMs: LATER }, NOW)).toBe(true);
    expect(isFreeAccessGrantActive({ ...base, kind: "limited", expiresAtMs: LATER }, LATER)).toBe(false);
    expect(isFreeAccessGrantActive({ ...base, kind: "limited", expiresAtMs: NOW - 1 }, NOW)).toBe(false);
  });
});

describe("free-access grant port parity (#3247)", () => {
  it("absent reads as null, and a grant round-trips on both adapters", async () => {
    for (const { name, port } of await adapters()) {
      expect(await port.getActiveGrant("u1", NOW), name).toBeNull();
      expect(await port.listGrants("u1"), name).toEqual([]);
      const { granted, replaced } = await port.grant(grantInput());
      expect(replaced, name).toBeNull();
      expect(granted, name).toMatchObject({
        login: "u1",
        kind: "lifetime",
        grantedBy: "op1",
        grantedAtMs: NOW,
        expiresAtMs: null,
        revokedAtMs: null,
        reason: "Owner-approved pilot account",
      });
      expect(granted.id.startsWith("freeaccess-"), name).toBe(true);
      expect(await port.getActiveGrant("u1", NOW), name).toEqual(granted);
      expect(await port.listGrants("u1"), name).toEqual([granted]);
    }
  });

  it("granting replaces the active grant: the old row is revoked and kept as history", async () => {
    for (const { name, port } of await adapters()) {
      const first = (await port.grant(grantInput())).granted;
      const { granted, replaced } = await port.grant(
        grantInput({ kind: "limited", expiresAtMs: LATER, reason: "Corrected window", nowMs: NOW + 1000 }),
      );
      expect(replaced, name).toEqual({ ...first, revokedAtMs: NOW + 1000 });
      expect(granted.kind, name).toBe("limited");
      expect(await port.getActiveGrant("u1", NOW + 1000), name).toEqual(granted);
      const history = await port.listGrants("u1");
      expect(history, name).toHaveLength(2);
      expect(history[0], name).toEqual(granted);
      expect(history[1], name).toEqual({ ...first, revokedAtMs: NOW + 1000 });
    }
  });

  it("an expired grant is inactive but stays in history; a new grant does not revoke it", async () => {
    for (const { name, port } of await adapters()) {
      const expired = (
        await port.grant(grantInput({ kind: "limited", expiresAtMs: NOW + 1000 }))
      ).granted;
      expect(await port.getActiveGrant("u1", LATER), name).toBeNull();
      expect(await port.listGrants("u1"), name).toEqual([expired]);
      // Granting over an expired (inactive) row replaces nothing.
      const { replaced } = await port.grant(grantInput({ nowMs: LATER }));
      expect(replaced, name).toBeNull();
      const history = await port.listGrants("u1");
      expect(history, name).toHaveLength(2);
      expect(history[1], name).toEqual(expired);
      expect(history[1].revokedAtMs, name).toBeNull();
    }
  });

  it("revokeActive revokes the active grant once; a second revoke returns null", async () => {
    for (const { name, port } of await adapters()) {
      expect(await port.revokeActive("u1", NOW), name).toBeNull();
      const granted = (await port.grant(grantInput())).granted;
      const revoked = await port.revokeActive("u1", NOW + 500);
      expect(revoked, name).toEqual({ ...granted, revokedAtMs: NOW + 500 });
      expect(await port.getActiveGrant("u1", NOW + 500), name).toBeNull();
      expect(await port.revokeActive("u1", NOW + 600), name).toBeNull();
      expect(await port.listGrants("u1"), name).toEqual([{ ...granted, revokedAtMs: NOW + 500 }]);
    }
  });

  it("revokeActive does not revoke an expired-only row", async () => {
    for (const { name, port } of await adapters()) {
      const expired = (
        await port.grant(grantInput({ kind: "limited", expiresAtMs: NOW + 1000 }))
      ).granted;
      expect(await port.revokeActive("u1", LATER), name).toBeNull();
      expect(await port.listGrants("u1"), name).toEqual([expired]);
    }
  });

  it("grants are isolated per login", async () => {
    for (const { name, port } of await adapters()) {
      await port.grant(grantInput());
      await port.grant(grantInput({ login: "u2", reason: "Second account" }));
      expect((await port.getActiveGrant("u1", NOW))?.reason, name).toBe("Owner-approved pilot account");
      expect((await port.getActiveGrant("u2", NOW))?.reason, name).toBe("Second account");
      expect(await port.listGrants("u1"), name).toHaveLength(1);
      expect(await port.listGrants("u2"), name).toHaveLength(1);
      expect(await port.getActiveGrant("u3", NOW), name).toBeNull();
    }
  });

  it("the adapters refuse an invalid grant before any write", async () => {
    for (const { name, port } of await adapters()) {
      await expect(port.grant(grantInput({ kind: "limited" })), name).rejects.toThrow(
        /must be an epoch-ms integer in the future/,
      );
      expect(await port.listGrants("u1"), name).toEqual([]);
    }
  });
});

describe("migration 0064 — free-access grants (#3247)", () => {
  it("is registered with its zero-padded name and creates the table plus the login index", () => {
    const migration = ALL_MIGRATIONS.find((m) => m.version === 64);
    expect(migration).toBeDefined();
    expect(migration!.name).toBe("0064_free_access_grants");
    expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS agent_free_access_grants");
    expect(migration!.sql).toContain("login TEXT NOT NULL");
    expect(migration!.sql).toContain("kind TEXT NOT NULL");
    expect(migration!.sql).toContain("granted_by TEXT NOT NULL");
    expect(migration!.sql).toContain("CREATE INDEX IF NOT EXISTS agent_free_access_grants_login_idx");
  });

  it("DDL and the Drizzle schema agree on the table and columns", () => {
    const columns = Object.keys(getTableColumns(agentFreeAccessGrants));
    expect(columns).toEqual([
      "id",
      "login",
      "kind",
      "grantedBy",
      "grantedAtMs",
      "expiresAtMs",
      "revokedAtMs",
      "reason",
    ]);
  });

  it("ensureFreeAccessGrantSchema alone on an empty store applies 0064, and is idempotent", async () => {
    const mock = new MockD1Database();
    const db = createD1FreeAccessGrantDb(mock as unknown as D1Database);
    const applied = await ensureFreeAccessGrantSchema(db);
    expect(applied).toContain(64);
    const tables = mock.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_free_access_grants'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    // Second ensure: no throw, nothing re-applied.
    await expect(ensureFreeAccessGrantSchema(db)).resolves.toEqual([]);
  });
});
