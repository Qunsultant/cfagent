import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../src/security/sessionStore";
import {
  createAtomicAuditStore,
  createWiredAuditStore,
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
import {
  computeEventHash,
  recordAuditAccess,
  recordAuditEvent,
  verifyChain,
  type AuditStore,
  type CreateIaaaAuditEventInput,
  type IaaaAuditEvent,
} from "../src/security/iaaaAudit";
import {
  AUDIT_PORTS_FLAG,
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_TABLE_KEY_PREFIX,
  isAuditPortsEnabled,
} from "../src/data/auditLogPorts";
import {
  createAuditPorts,
  createAuditPortsFromNamespace,
  createInMemoryAuditPorts,
} from "../src/data/createAuditPorts";
import { InMemoryAuditLogAdapter } from "../src/data/inMemoryAuditLogAdapter";
import { makeFakeSessionStore, type FakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

/**
 * Issue #2435 (#1976 step 5d) — AuditLog port conformance.
 *
 * The §9 5d characterization rows, run against BOTH compositions
 * of the audit family:
 *
 *  - flag-OFF: today's wiring — createWiredAuditStore returns the
 *    atomic client in security/iaaaAuditStore.ts, speaking the
 *    SessionStore DO's `audit-append` op directly;
 *  - flag-ON: createWiredAuditStore delegates to the family's
 *    composition root (src/data/createAuditPorts.ts) and the
 *    AuditLog port's DO adapter — the SAME op, the SAME DO, the
 *    SAME kv_store bytes (Q-1: the mechanism does not move);
 *  - the port's in-memory adapter, which mirrors the op's caps,
 *    clamps, rotation and storeFull signal over its own map.
 *
 * #3251 (O1): the flag-ON composition now writes the
 * append-only `iaaa_audit_events` TABLE in the same SessionStore
 * DO SQLite instead of segments. The two substrates hold the
 * same chain under different shapes: flag-OFF reads/writes
 * segment bytes, flag-ON reads/writes table rows, and migration
 * (lazy on first table append, or explicit via `audit-migrate`)
 * is the bridge between them — never a sync. The in-memory
 * adapter mirrors the table with its own `tableRows` array.
 *
 * Rows: genesis chaining; verifyChain(list()) across rotation
 * boundaries; boundary pins at liveMax-1 / liveMax / totalCap /
 * totalCap+1; cap refusal as AUDIT_STORE_FULL data writing
 * nothing; corrupt live/archive bytes failing loud and left
 * untouched; the F-18 concurrency pin (parallel recordAuditEvent
 * calls produce one unforked chain) on the DO adapter over the
 * REAL SessionStore; cross-composition reads (bytes written
 * flag-OFF verify flag-ON before migration and identically after
 * it; the two substrates diverge after cutover by design,
 * including segments seeded in the pre-slice legacy byte shape);
 * backend's append() refusing a caller-chained event; the
 * no-backend fail-visible parity; audit-access events recorded
 * through the port.
 *
 * #CDO-mha7
 */

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Real SessionStore DO over node:sqlite, serialized input gate
 *  (the audit_store_atomic_1760 harness shape). */
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
  return { namespace, doInstance: store };
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

/** Build events in the pre-#1760 legacy byte shape (plain chained
 *  JSON arrays, as the old Kv writer stored them). */
async function legacyChainedEvents(
  count: number,
  tsBase: number,
): Promise<IaaaAuditEvent[]> {
  const out: IaaaAuditEvent[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    const unsigned: Omit<IaaaAuditEvent, "eventHash"> = {
      ...auditInput(`legacy:${i}`, tsBase + i),
      id: `legacy-event-${i}`,
      correlationId: `corr-legacy:${i}`,
      previousEventHash: prev,
    };
    const event: IaaaAuditEvent = {
      ...unsigned,
      eventHash: await computeEventHash(unsigned),
    };
    out.push(event);
    prev = event.eventHash;
  }
  return out;
}

const CAPS = { liveMax: 5, segmentSize: 2, maxArchiveSegments: 2 }; // totalCap = 9

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

describe("AUDIT_PORTS_ENABLED flag (#2435, Q-2(b) #1169 semantics)", () => {
  it("the flag name is the Q-2(b) per-family name", () => {
    expect(AUDIT_PORTS_FLAG).toBe("AUDIT_PORTS_ENABLED");
  });

  it("parses 1/true/on (trimmed, case-insensitive) as on; everything else off", () => {
    for (const v of ["1", "true", "on", " ON ", "True"]) {
      expect(isAuditPortsEnabled({ AUDIT_PORTS_ENABLED: v })).toBe(true);
    }
    for (const v of ["0", "false", "off", "", "yes", "2"]) {
      expect(isAuditPortsEnabled({ AUDIT_PORTS_ENABLED: v })).toBe(false);
    }
    expect(isAuditPortsEnabled({})).toBe(false);
    expect(isAuditPortsEnabled(undefined)).toBe(false);
    expect(isAuditPortsEnabled(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dual-composition behaviour rows (fake DO namespace)
// ---------------------------------------------------------------------------

describe("audit log conformance — genesis and chaining (both compositions)", () => {
  it("the first event chains from null and the chain verifies", async () => {
    const compositions: Array<() => AuditStore> = [
      () => {
        const fake = makeFakeSessionStore();
        return createWiredAuditStore({
          SESSION_STORE: fake.namespace,
        } as unknown as Env);
      },
      () => {
        const fake = makeFakeSessionStore();
        return createWiredAuditStore({
          SESSION_STORE: fake.namespace,
          AUDIT_PORTS_ENABLED: "1",
        } as unknown as Env);
      },
      () => {
        const fake = makeFakeSessionStore();
        return createAuditPorts({
          SESSION_STORE: fake.namespace,
          AUDIT_PORTS_ENABLED: "1",
        } as unknown as Env);
      },
    ];
    for (const make of compositions) {
      const store = make();
      const first = await recordAuditEvent(store, auditInput("event:0", 1_000_000));
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.event.previousEventHash).toBeNull();
      await appendN(store, 3, 1, 1_000_001);
      const events = await store.list();
      expect(events).toHaveLength(4);
      expect(await verifyChain(events)).toBe(true);
    }
  });

  it("in-memory adapter: genesis, chaining, verifyChain", async () => {
    const store = createInMemoryAuditPorts();
    const first = await recordAuditEvent(store, auditInput("event:0", 1_100_000));
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.event.previousEventHash).toBeNull();
    await appendN(store, 4, 1, 1_100_001);
    const events = await store.list();
    expect(events).toHaveLength(5);
    expect(await verifyChain(events)).toBe(true);
  });
});

describe("audit log conformance — rotation and cap boundaries (both compositions)", () => {
  // #3251 (O1): the two substrates store the same chain under
  // different shapes. The segment substrate rotates into archive
  // keys; the table substrate has no rotation at all — it appends
  // rows, so the "rotation" checkpoints assert the table holds
  // exactly the events written and no segment bytes exist.
  async function boundaryRun(
    make: () => AuditStore,
    fake?: FakeSessionStore,
    substrate: "segments" | "table" = "segments",
  ) {
    const store = make();
    // liveMax-1 events: nothing has rotated.
    await appendN(store, CAPS.liveMax - 1, 0, 2_000_000);
    let events = await store.list();
    expect(events).toHaveLength(CAPS.liveMax - 1);
    expect(await verifyChain(events)).toBe(true);
    if (fake) {
      const archiveKeys = [...fake.store.keys()].filter((k) =>
        k.startsWith(`sessions:${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}`),
      );
      expect(archiveKeys).toHaveLength(0);
      if (substrate === "table") {
        expect(fake.auditTable).toHaveLength(CAPS.liveMax - 1);
        expect(
          [...fake.store.keys()].filter((k) =>
            k.startsWith(`sessions:${IAAA_AUDIT_KEY_PREFIX}`),
          ),
        ).toHaveLength(0);
      }
    }
    // liveMax events: still no rotation (rotation is past liveMax).
    await appendN(store, 1, 4, 2_000_004);
    events = await store.list();
    expect(events).toHaveLength(CAPS.liveMax);
    expect(await verifyChain(events)).toBe(true);
    if (fake) {
      const archiveKeys = [...fake.store.keys()].filter((k) =>
        k.startsWith(`sessions:${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}`),
      );
      expect(archiveKeys).toHaveLength(0);
      if (substrate === "table") {
        expect(fake.auditTable).toHaveLength(CAPS.liveMax);
      }
    }
    // Past liveMax: rotation preserves order and the chain.
    await appendN(store, 1, 5, 2_000_005);
    events = await store.list();
    expect(events).toHaveLength(CAPS.liveMax + 1);
    expect(events[0].action).toBe("event:0");
    expect(await verifyChain(events)).toBe(true);
    if (fake) {
      const archiveKeys = [...fake.store.keys()].filter((k) =>
        k.startsWith(`sessions:${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}`),
      );
      if (substrate === "segments") {
        expect(archiveKeys.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(archiveKeys).toHaveLength(0);
        expect(fake.auditTable).toHaveLength(CAPS.liveMax + 1);
      }
    }
    // Up to totalCap (9): every append succeeds, nothing deleted.
    await appendN(store, 3, 6, 2_000_006);
    events = await store.list();
    expect(events).toHaveLength(9);
    expect(events[0].action).toBe("event:0");
    expect(events[8].action).toBe("event:8");
    expect(await verifyChain(events)).toBe(true);
    // totalCap+1: refusal as AUDIT_STORE_FULL data; nothing written.
    const full = await recordAuditEvent(store, auditInput("event:9", 2_000_009));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe("AUDIT_STORE_FULL");
    const after = await store.list();
    expect(after).toHaveLength(9);
    expect(await verifyChain(after)).toBe(true);
  }

  // The wired factory takes no caps (production caps are the
  // defaults), so the boundary rows run against the two
  // compositions' cap-carrying factories: flag-OFF's
  // createAtomicAuditStore and flag-ON's composition root.
  it("flag-OFF composition — createAtomicAuditStore (fake DO)", async () => {
    const fake = makeFakeSessionStore();
    await boundaryRun(
      () => createAtomicAuditStore(fake.namespace as never, CAPS),
      fake,
    );
  });

  it("flag-ON composition — createAuditPortsFromNamespace (fake DO)", async () => {
    const fake = makeFakeSessionStore();
    await boundaryRun(
      () => createAuditPortsFromNamespace(fake.namespace as never, CAPS),
      fake,
      "table",
    );
  });

  it("in-memory adapter", async () => {
    const adapter = new InMemoryAuditLogAdapter(CAPS);
    await boundaryRun(() => adapter);
    // The adapter's raw seams show the same key layout as the DO.
    const seg = adapter.rawValue(`${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000000`);
    expect(seg).not.toBeNull();
    expect((JSON.parse(seg!) as unknown[]).length).toBe(CAPS.segmentSize);
  });
});

describe("audit log conformance — corruption fails loud, bytes untouched", () => {
  it("corrupt live bytes: append refused as data, list throws, bytes untouched (flag-ON)", async () => {
    const fake = makeFakeSessionStore();
    fake.seed("sessions", IAAA_AUDIT_LOG_KEY, "{not json");
    const store = createAuditPortsFromNamespace(fake.namespace as never);
    const result = await recordAuditEvent(store, auditInput("event:0", 3_000_000));
    expect(result.ok).toBe(false);
    await expect(store.list()).rejects.toThrow(/corrupt/);
    expect(fake.store.get(`sessions:${IAAA_AUDIT_LOG_KEY}`)).toBe("{not json");
  });

  // #3251 (O1): the flag-ON composition writes the table, never
  // segments — so a corrupt archive segment can only reach it
  // through a legacy segment store, seeded here through the
  // flag-OFF composition. The flag-ON append's lazy migration
  // must fail loud on the corrupt bytes before any row is written.
  it("corrupt archive segment: append refused, list throws, bytes untouched (flag-ON)", async () => {
    const fake = makeFakeSessionStore();
    const offStore = createAtomicAuditStore(fake.namespace as never, CAPS);
    await appendN(offStore, 7, 0, 3_100_000);
    const segKey = `sessions:${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000000`;
    expect(fake.store.has(segKey)).toBe(true);
    fake.store.set(segKey, "{corrupt segment");
    const store = createAuditPortsFromNamespace(fake.namespace as never, CAPS);
    const result = await recordAuditEvent(store, auditInput("event:7", 3_100_007));
    expect(result.ok).toBe(false);
    await expect(store.list()).rejects.toThrow(/corrupt/);
    expect(fake.store.get(segKey)).toBe("{corrupt segment");
    expect(fake.auditTable).toHaveLength(0);
  });

  it("corrupt archive segment: in-memory adapter fails loud too", async () => {
    const adapter = new InMemoryAuditLogAdapter(CAPS);
    await appendN(adapter, 7, 0, 3_200_000);
    adapter.seedRaw(`${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000000`, "{corrupt segment");
    const result = await recordAuditEvent(adapter, auditInput("event:7", 3_200_007));
    expect(result.ok).toBe(false);
    await expect(adapter.list()).rejects.toThrow(/corrupt/);
    expect(adapter.rawValue(`${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000000`)).toBe(
      "{corrupt segment",
    );
  });
});

describe("audit log conformance — append() can never store a caller-chained event", () => {
  it("the port store's append() throws and stores nothing", async () => {
    const fake = makeFakeSessionStore();
    const store = createAuditPortsFromNamespace(fake.namespace as never);
    const chained: IaaaAuditEvent = {
      ...auditInput("forged:0", 4_000_000),
      id: "forged-id",
      previousEventHash: null,
      eventHash: "forged-hash",
    };
    await expect(store.append(chained)).rejects.toThrow(/appendAtomic/);
    expect(await store.list()).toHaveLength(0);
    const mem = createInMemoryAuditPorts();
    await expect(mem.append(chained)).rejects.toThrow(/appendAtomic/);
    expect(await mem.list()).toHaveLength(0);
  });
});

describe("audit log conformance — cross-composition reads", () => {
  // #3251 (O1) — explicit migration of a SessionStore namespace
  // through the fake DO's `audit-migrate` op (the real DO's op
  // has the same shape).
  async function migrateAuditLog(namespace: FakeSessionStore["namespace"]): Promise<{
    ok: boolean;
    migrated: number;
    alreadyMigrated: boolean;
  }> {
    const res = await namespace.get("kv").fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "audit-migrate",
          ns: "sessions",
          key: IAAA_AUDIT_LOG_KEY,
        }),
      }),
    );
    return (await res.json()) as {
      ok: boolean;
      migrated: number;
      alreadyMigrated: boolean;
    };
  }

  // #3251 (O1): the two compositions now write DIFFERENT
  // substrates — flag-OFF writes segments, flag-ON writes the
  // table — so a flag-ON write is NOT visible flag-OFF, and vice
  // versa after migration. The bridge is migration: bytes
  // written flag-OFF verify flag-ON before migration (the table
  // is empty, so `audit-list` serves the segment entries), and
  // identically after it (the table holds the same chain,
  // byte-identical per event), while the old segment rows are
  // retained.
  it("bytes written flag-OFF verify flag-ON before migration, and identically after it", async () => {
    const fake = makeFakeSessionStore();
    const envOff = { SESSION_STORE: fake.namespace } as unknown as Env;
    const envOn = {
      SESSION_STORE: fake.namespace,
      AUDIT_PORTS_ENABLED: "1",
    } as unknown as Env;
    // Write 7 events through the flag-OFF composition (segments,
    // rotations included) with small caps.
    const offWriter = createAtomicAuditStore(fake.namespace as never, CAPS);
    await appendN(offWriter, 7, 0, 5_000_000);
    // Flag-ON reads the segment bytes pre-migration: full chain,
    // in order, verifies.
    const on = createWiredAuditStore(envOn);
    const events = await on.list();
    expect(events).toHaveLength(7);
    expect(events[0].action).toBe("event:0");
    expect(await verifyChain(events)).toBe(true);
    expect(fake.auditTable).toHaveLength(0);
    // Explicit migration: the table now holds the same chain,
    // byte-identical per event; the segment rows are retained.
    const migrated = await migrateAuditLog(fake.namespace);
    expect(migrated).toEqual({ ok: true, migrated: 7, alreadyMigrated: false });
    const after = await on.list();
    expect(after).toHaveLength(7);
    expect(after.map((e) => JSON.stringify(e))).toEqual(
      events.map((e) => JSON.stringify(e)),
    );
    expect(await verifyChain(after)).toBe(true);
    expect(fake.auditTable).toHaveLength(7);
    expect(fake.store.has(`sessions:${IAAA_AUDIT_LOG_KEY}`)).toBe(true);
    // A flag-ON append chains from the migrated tail...
    const more = await recordAuditEvent(on, auditInput("event:7", 5_000_007));
    expect(more.ok).toBe(true);
    if (more.ok) expect(more.event.previousEventHash).toBe(events[6].eventHash);
    // ...while the flag-OFF composition still reads only the
    // segment bytes: the two substrates diverge by design after
    // cutover; migration is the bridge, not a sync.
    const offAgain = createWiredAuditStore(envOff);
    const offEvents = await offAgain.list();
    expect(offEvents).toHaveLength(7);
    const onEvents = await on.list();
    expect(onEvents).toHaveLength(8);
    expect(await verifyChain(onEvents)).toBe(true);
    // Migration is idempotent: a second call migrates nothing.
    const again = await migrateAuditLog(fake.namespace);
    expect(again).toEqual({ ok: true, migrated: 0, alreadyMigrated: true });
  });

  it("pre-slice legacy-shape segments remain readable and verifiable (flag-ON)", async () => {
    const fake = makeFakeSessionStore();
    const legacy = await legacyChainedEvents(6, 5_500_000);
    fake.seed(
      "sessions",
      `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000000`,
      JSON.stringify(legacy.slice(0, 2)),
    );
    fake.seed(
      "sessions",
      `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}000001`,
      JSON.stringify(legacy.slice(2, 4)),
    );
    fake.seed("sessions", IAAA_AUDIT_LOG_KEY, JSON.stringify(legacy.slice(4)));
    const envOn = {
      SESSION_STORE: fake.namespace,
      AUDIT_PORTS_ENABLED: "1",
    } as unknown as Env;
    const store = createWiredAuditStore(envOn);
    const events = await store.list();
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.action)).toEqual(
      legacy.map((e) => e.action),
    );
    expect(await verifyChain(events)).toBe(true);
    // Appending onto the legacy tail chains from its true tail.
    const next = await recordAuditEvent(store, auditInput("event:next", 5_500_006));
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.event.previousEventHash).toBe(legacy[5].eventHash);
    }
  });
});

describe("audit log conformance — no backend fails visible (both compositions)", () => {
  it("flag-ON with no SESSION_STORE: append fails as data, list reads empty", async () => {
    const envOn = { AUDIT_PORTS_ENABLED: "1" } as unknown as Env;
    const store = createWiredAuditStore(envOn);
    const result = await recordAuditEvent(store, auditInput("event:0", 6_000_000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUDIT_WRITE_FAILED");
    expect(await store.list()).toEqual([]);
  });

  it("flag-OFF with no SESSION_STORE: identical outcomes", async () => {
    const envOff = {} as unknown as Env;
    const store = createWiredAuditStore(envOff);
    const result = await recordAuditEvent(store, auditInput("event:0", 6_000_000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUDIT_WRITE_FAILED");
    expect(await store.list()).toEqual([]);
  });
});

describe("audit log conformance — audit-access events through the port", () => {
  it("recordAuditAccess appends a chained access event (flag-ON)", async () => {
    const fake = makeFakeSessionStore();
    const envOn = {
      SESSION_STORE: fake.namespace,
      AUDIT_PORTS_ENABLED: "1",
    } as unknown as Env;
    const store = createWiredAuditStore(envOn);
    await appendN(store, 2, 0, 6_500_000);
    const access = await recordAuditAccess(store, {
      timestamp: 6_500_002,
      access: "audit.read",
      readerPrincipalId: "admin-1",
      actorType: "human",
      initiatingPrincipalId: "admin-1",
      tenantId: "tenant-1",
      correlationId: "corr-access-1",
    });
    expect(access.ok).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(3);
    expect(events[2].type).toBe("audit.read");
    expect(await verifyChain(events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-18 concurrency pin — the real SessionStore DO
// ---------------------------------------------------------------------------

describe("audit log conformance — F-18 concurrency (real DO, flag-ON composition)", () => {
  it("parallel recordAuditEvent calls produce one unforked chain", async () => {
    const { namespace } = makeRealDo();
    const envOn = {
      SESSION_STORE: namespace,
      AUDIT_PORTS_ENABLED: "1",
    } as unknown as Env;
    const store = createWiredAuditStore(envOn);
    const count = 40;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        recordAuditEvent(store, auditInput(`auth.login:${i}`, 7_000_000 + i)),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(count);
    expect(new Set(events.map((e) => e.id)).size).toBe(count);
    expect(new Set(events.map((e) => e.action)).size).toBe(count);
    expect(await verifyChain(events)).toBe(true);
  });

  it("rotation + total cap on the real DO through the port (small caps)", async () => {
    const { namespace, doInstance } = makeRealDo();
    const store = createAuditPortsFromNamespace(namespace as never, CAPS);
    await appendN(store, 9, 0, 7_500_000);
    const events = await store.list();
    expect(events).toHaveLength(9);
    expect(events[0].action).toBe("event:0");
    expect(await verifyChain(events)).toBe(true);
    const full = await recordAuditEvent(store, auditInput("event:9", 7_500_009));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe("AUDIT_STORE_FULL");
    // #3251 (O1): the table substrate writes rows, never segment
    // bytes. `audit-list` returns one row per event, table-keyed,
    // in chain order — and the live segment key was never written.
    const listedRaw = await doInstance.fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "audit-list",
          ns: "sessions",
          key: IAAA_AUDIT_LOG_KEY,
        }),
      }),
    );
    const listedReply = (await listedRaw.json()) as {
      entries: Array<{ key: string; value: string }>;
    };
    expect(listedReply.entries).toHaveLength(9);
    expect(
      listedReply.entries.every((e) =>
        e.key.startsWith(IAAA_AUDIT_TABLE_KEY_PREFIX),
      ),
    ).toBe(true);
    expect(
      listedReply.entries.map(
        (e) => (JSON.parse(e.value) as IaaaAuditEvent).action,
      ),
    ).toEqual(events.map((e) => e.action));
    const liveRaw = await doInstance.fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "get",
          ns: "sessions",
          key: IAAA_AUDIT_LOG_KEY,
        }),
      }),
    );
    const liveReply = (await liveRaw.json()) as { value: string | null };
    expect(liveReply.value).toBeNull();
  });
});

describe("audit log conformance — F-18 concurrency (in-memory adapter)", () => {
  it("parallel appends serialize into one unforked chain", async () => {
    const store = createInMemoryAuditPorts();
    const count = 40;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        recordAuditEvent(store, auditInput(`auth.login:${i}`, 8_000_000 + i)),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(count);
    expect(new Set(events.map((e) => e.id)).size).toBe(count);
    expect(await verifyChain(events)).toBe(true);
  });
});
