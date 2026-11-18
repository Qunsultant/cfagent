import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../src/security/sessionStore";
import { createAtomicAuditStore, createWiredAuditStore } from "../src/security/iaaaAuditStore";
import {
  recordAuditEvent,
  verifyChain,
  type AuditStore,
  type CreateIaaaAuditEventInput,
  type IaaaAuditEvent,
} from "../src/security/iaaaAudit";
import {
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_TABLE_KEY_PREFIX,
} from "../src/data/auditLogPorts";
import {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
import {
  createAuditPortsFromNamespace,
  createInMemoryAuditPorts,
} from "../src/data/createAuditPorts";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

/**
 * Issue #3251 (O1) — audit append-substrate pin: the append-only
 * table in the SAME SessionStore DO SQLite.
 *
 * What this pins, against the decision record's measurements
 * (decision-record-draft.md §3: every segment-substrate append
 * reads + JSON-parses the ENTIRE store — ~13.3 MB at the 22,000
 * cap, median 52.4 ms, p95 79.3 ms):
 *
 *  - a table append is O(1): tail point-read + COUNT(*) cap
 *    check + one row insert — exactly 3 rows read, 1 written,
 *    at ANY fill level (100 rows and 21,999 rows alike);
 *  - the segment append at full store still reads 1 + 10 rows
 *    (the old cost shape, pinned so a regression is visible);
 *  - migration (explicit `audit-migrate`, and lazy on first
 *    table append) preserves the chain: verifyChain(list())
 *    before AND after, per-event byte equality, old segment rows
 *    retained, list() identical;
 *  - the 22,000 cap is exact on the table (small caps prove the
 *    boundary; the production cap is unchanged);
 *  - F-18 concurrency holds on the in-memory table mirror.
 *
 * The table substrate is NOT a second store (S5 alignment, #5084):
 * same DO, same SQLite, same owner, same purpose — one row per
 * event instead of one JSON array per segment. Old segment rows
 * are RETAINED in this slice; their removal is a separate named
 * step after verification.
 */

const CAPS = { liveMax: 5, segmentSize: 2, maxArchiveSegments: 2 }; // totalCap = 9
const FULL_STORE = 21_999;
const TOTAL_CAP = 22_000;

function makeRealDo() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const stmt = db.prepare(sql);
          if (/^\s*SELECT/i.test(sql)) {
            const rows = stmt.all(...params);
            return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
          }
          const info = stmt.run(...params);
          return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
        },
      },
    },
  };
  const store = new SessionStore(ctx as never, {} as never);
  let queue: Promise<unknown> = Promise.resolve();
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (request: Request) => {
        const run = queue.then(() => store.fetch(request));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    }),
  };
  return { namespace, doInstance: store, db };
}

function auditInput(action: string, timestamp: number): CreateIaaaAuditEventInput {
  return {
    timestamp,
    type: "auth.login",
    actorPrincipalId: "user-1",
    actorType: "human",
    initiatingPrincipalId: "user-1",
    tenantId: "tenant-1",
    correlationId: `corr-${action}`,
    action,
    decision: "allow",
    policyVersion: "iaaa-audit-1",
    outcome: "succeeded",
  };
}

async function appendN(
  store: AuditStore,
  n: number,
  start: number,
  tsBase: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await recordAuditEvent(
      store,
      auditInput(`event:${start + i}`, tsBase + i),
    );
    expect(r.ok).toBe(true);
  }
}

/** One POST against the real DO's kv fetch, parsed as JSON. */
async function doPost(
  doInstance: SessionStore,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await doInstance.fetch(
    new Request("https://session-store.internal/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Seed one table row directly (bypasses the port: the rows'
 *  hashes are dummies — append never verifies them, and this
 *  test measures the op's read/write shape, not the chain). */
function seedTableRow(
  db: DatabaseSync,
  seq: number,
  eventHash: string,
): void {
  const event = {
    ...auditInput(`seed:${seq}`, 9_000_000 + seq),
    id: `seed-event-${seq}`,
    previousEventHash: seq > 1 ? `seed-hash-${seq - 1}` : null,
    eventHash,
  };
  db.prepare("INSERT INTO iaaa_audit_events (seq, event_json) VALUES (?, ?)").run(
    seq,
    JSON.stringify(event),
  );
}

describe("audit append table substrate (#3251 O1)", () => {
  it("a table append reads a constant 3 rows and writes 1, at any fill", async () => {
    const { namespace, doInstance, db } = makeRealDo();
    // First fetch runs ensureSchema (creates the table).
    await doPost(doInstance, { op: "get", ns: "sessions", key: "probe" });
    // Fill 1: 100 rows.
    for (let seq = 1; seq <= 100; seq++) seedTableRow(db, seq, `seed-hash-${seq}`);
    const at100 = await doPost(doInstance, {
      op: "audit-append",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
      value: JSON.stringify(auditInput("event:100", 9_100_000)),
      substrate: "table",
    });
    expect(at100.ok).toBe(true);
    expect(at100.rowsRead).toBe(3);
    expect(at100.rowsWritten).toBe(1);
    // Fill 2: the full store (21,999 rows) — the same 3/1.
    for (let seq = 102; seq <= FULL_STORE; seq++) {
      seedTableRow(db, seq, `seed-hash-${seq}`);
    }
    const atFull = await doPost(doInstance, {
      op: "audit-append",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
      value: JSON.stringify(auditInput("event:21999", 9_219_999)),
      substrate: "table",
    });
    expect(atFull.ok).toBe(true);
    expect(atFull.rowsRead).toBe(3);
    expect(atFull.rowsWritten).toBe(1);
    // The store now holds exactly the 22,000 cap, in chain
    // order, and the new event chained from the seeded tail.
    const on = createAuditPortsFromNamespace(namespace as never);
    const events = await on.list();
    expect(events).toHaveLength(TOTAL_CAP);
    expect(events[TOTAL_CAP - 1].action).toBe("event:21999");
    expect(events[TOTAL_CAP - 1].previousEventHash).toBe(
      `seed-hash-${FULL_STORE}`,
    );
    const listed = await doPost(doInstance, {
      op: "audit-list",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    const entries = listed.entries as Array<{ key: string; value: string }>;
    expect(entries).toHaveLength(TOTAL_CAP);
    expect(entries[TOTAL_CAP - 1].key).toBe(
      `${IAAA_AUDIT_TABLE_KEY_PREFIX}022000`,
    );
    // And the cap refuses the next append as data.
    const full = await recordAuditEvent(on, auditInput("event:22000", 9_220_000));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe("AUDIT_STORE_FULL");
  });

  it("a segment append at full store still reads 1 + 10 rows (the old cost shape)", async () => {
    const { doInstance } = makeRealDo();
    await doPost(doInstance, { op: "get", ns: "sessions", key: "probe" });
    // 10 archive segments of 2,000 events + a 1,999-event live
    // key: 21,999 events — one short of the 22,000 cap.
    const segment = (start: number, count: number): string =>
      JSON.stringify(
        Array.from({ length: count }, (_, i) => ({
          ...auditInput(`seed:${start + i}`, 9_000_000 + start + i),
          id: `seed-event-${start + i}`,
          previousEventHash: `seed-hash-${start + i - 1}`,
          eventHash: `seed-hash-${start + i}`,
        })),
      );
    for (let s = 0; s < 10; s++) {
      await doPost(doInstance, {
        op: "put",
        ns: "sessions",
        key: `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}${String(s).padStart(6, "0")}`,
        value: segment(s * 2000, 2000),
      });
    }
    await doPost(doInstance, {
      op: "put",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
      value: segment(20000, 1999),
    });
    const reply = await doPost(doInstance, {
      op: "audit-append",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
      value: JSON.stringify(auditInput("event:21999", 9_219_999)),
    });
    expect(reply.ok).toBe(true);
    // 1 live row + 10 archive rows read; the whole ~13 MB of
    // event JSON parsed behind those 11 rows. 1 row written
    // (live 1,999 -> 2,000: no rotation).
    expect(reply.rowsRead).toBe(11);
    expect(reply.rowsWritten).toBe(1);
  });

  it("migration on the real DO: verifyChain before AND after, byte-identical, segments retained", async () => {
    const { namespace, doInstance } = makeRealDo();
    const offStore = createAtomicAuditStore(namespace as never, CAPS);
    await appendN(offStore, 7, 0, 8_000_000);
    const on = createAuditPortsFromNamespace(namespace as never, CAPS);
    const before = await on.list();
    expect(before).toHaveLength(7);
    expect(await verifyChain(before)).toBe(true);
    const migrated = await doPost(doInstance, {
      op: "audit-migrate",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    expect(migrated.ok).toBe(true);
    expect(migrated.migrated).toBe(7);
    expect(migrated.alreadyMigrated).toBe(false);
    const after = await on.list();
    expect(after).toHaveLength(7);
    expect(after.map((e) => JSON.stringify(e))).toEqual(
      before.map((e) => JSON.stringify(e)),
    );
    expect(await verifyChain(after)).toBe(true);
    // Old segment rows retained: the live key still holds its bytes.
    const live = await doPost(doInstance, {
      op: "get",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    expect(typeof live.value).toBe("string");
    expect((JSON.parse(live.value as string) as unknown[]).length).toBe(5);
    // And the table now serves the list: every key table-prefixed.
    const listed = await doPost(doInstance, {
      op: "audit-list",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    const entries = listed.entries as Array<{ key: string; value: string }>;
    expect(entries).toHaveLength(7);
    expect(
      entries.every((e) => e.key.startsWith(IAAA_AUDIT_TABLE_KEY_PREFIX)),
    ).toBe(true);
    // Migration is idempotent.
    const again = await doPost(doInstance, {
      op: "audit-migrate",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    expect(again.ok).toBe(true);
    expect(again.migrated).toBe(0);
    expect(again.alreadyMigrated).toBe(true);
  });

  it("lazy migration chains from the segment tail without an explicit migrate", async () => {
    const { namespace, doInstance } = makeRealDo();
    const offStore = createAtomicAuditStore(namespace as never, CAPS);
    await appendN(offStore, 7, 0, 8_100_000);
    const on = createAuditPortsFromNamespace(namespace as never, CAPS);
    const before = await on.list();
    const next = await recordAuditEvent(on, auditInput("event:7", 8_100_007));
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.event.previousEventHash).toBe(before[6].eventHash);
    }
    const events = await on.list();
    expect(events).toHaveLength(8);
    expect(await verifyChain(events)).toBe(true);
    // The segment rows are still there underneath.
    const live = await doPost(doInstance, {
      op: "get",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    expect(typeof live.value).toBe("string");
  });

  it("cap exactness on the table (small caps), DO composition and in-memory mirror", async () => {
    const fake = makeFakeSessionStore();
    const on = createAuditPortsFromNamespace(fake.namespace as never, CAPS);
    await appendN(on, 9, 0, 8_200_000);
    const full = await recordAuditEvent(on, auditInput("event:9", 8_200_009));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe("AUDIT_STORE_FULL");
    const events = await on.list();
    expect(events).toHaveLength(9);
    expect(await verifyChain(events)).toBe(true);
    expect(fake.auditTable).toHaveLength(9);
    expect(
      [...fake.store.keys()].filter((k) =>
        k.startsWith(`sessions:${IAAA_AUDIT_KEY_PREFIX}`),
      ),
    ).toHaveLength(0);

    const mirror = createInMemoryAuditPorts({
      substrate: "table",
      ...CAPS,
    });
    await appendN(mirror, 9, 0, 8_300_000);
    const mirrorFull = await recordAuditEvent(
      mirror,
      auditInput("event:9", 8_300_009),
    );
    expect(mirrorFull.ok).toBe(false);
    if (!mirrorFull.ok) expect(mirrorFull.code).toBe("AUDIT_STORE_FULL");
    const mirrorEvents = await mirror.list();
    expect(mirrorEvents).toHaveLength(9);
    expect(await verifyChain(mirrorEvents)).toBe(true);
  });

  it("F-18 holds on the in-memory table mirror: parallel appends, one unforked chain", async () => {
    const mirror = createInMemoryAuditPorts({ substrate: "table" });
    const count = 40;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        recordAuditEvent(mirror, auditInput(`auth.login:${i}`, 8_400_000 + i)),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const events = await mirror.list();
    expect(events).toHaveLength(count);
    expect(new Set(events.map((e) => e.id)).size).toBe(count);
    expect(await verifyChain(events)).toBe(true);
    // The mirror's table holds the rows; no segment bytes exist.
    const adapter = mirror as unknown as {
      tableEvents: () => IaaaAuditEvent[];
      rawValue: (key: string) => string | null;
    };
    expect(adapter.tableEvents()).toHaveLength(count);
    expect(adapter.rawValue(IAAA_AUDIT_LOG_KEY)).toBeNull();
  });

  it("the env-shaped flag-ON composition writes the table (wired factory)", async () => {
    const fake = makeFakeSessionStore();
    const envOn = {
      SESSION_STORE: fake.namespace,
      AUDIT_PORTS_ENABLED: "1",
    } as unknown as Env;
    const store = createWiredAuditStore(envOn);
    await appendN(store, 3, 0, 8_500_000);
    const events = await store.list();
    expect(events).toHaveLength(3);
    expect(await verifyChain(events)).toBe(true);
    expect(fake.auditTable).toHaveLength(3);
  });
});
