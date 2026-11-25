/**
 * Issue #6102 — D1 audit-event adapter: write/read round-trip,
 * chain continuity (including a concurrent-append no-fork test),
 * envelope columns, retention selector, duplicate-id failure,
 * and the async blocking helper over the D1 port.
 *
 * The store runs over a MockD1Database (node:sqlite, so rowid +
 * conditional insert behave as on D1).
 */
import { describe, expect, it } from "vitest";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import { DML_CATALOGUE } from "../src/data/schemaComponent/dmlCatalogue";
import { executeDmlSql } from "../src/data/schemaComponent/dmlExecutor";
import {
  diagnoseAuditChain,
  recordBlockingAuditAsync,
} from "../src/security/auditChain";
import type { AuditEvent } from "../src/types";

function newStore(): D1AuditEventStore {
  const mock = new MockD1Database();
  const db = createD1AuditEventDb(mock as never);
  return new D1AuditEventStore(db);
}

function event(
  id: string,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    id,
    sessionId: "sess-1",
    type: "test.event",
    agent: "orchestrator",
    payload: { n: 1 },
    createdAt: new Date().toISOString(),
    ...overrides,
  } as AuditEvent;
}

describe("D1AuditEventStore (#6102)", () => {
  it("write/read round-trip: payload reads back as the stored JSON text", async () => {
    const store = newStore();
    const written = await store.create(event("evt_1"));
    expect(written.id).toBe("evt_1");
    expect(written.eventHash).toBeTruthy();
    expect(written.previousEventHash).toBeNull();

    const read = await store.findById("evt_1");
    expect(read).not.toBeNull();
    expect(read?.id).toBe("evt_1");
    expect(read?.type).toBe("test.event");
    expect(read?.agent).toBe("orchestrator");
    expect(read?.sessionId).toBe("sess-1");
    // The DO port's read contract: payload is the JSON TEXT string.
    expect(read?.payload as unknown as string).toBe('{"n":1}');
    expect(read?.createdAt).toBe(written.createdAt);
    expect(read?.eventHash).toBe(written.eventHash);
  });

  it("findMany filters by type/session and orders by created_at", async () => {
    const store = newStore();
    await store.create(event("evt_a1", { type: "a", createdAt: "2026-11-25T10:00:00.000Z" }));
    await store.create(event("evt_b1", { type: "b", createdAt: "2026-11-25T10:01:00.000Z" }));
    await store.create(event("evt_a2", { type: "a", createdAt: "2026-11-25T10:02:00.000Z" }));

    const aRows = await store.findMany({ where: { type: "a" } });
    expect(aRows.map((r) => r.id).sort()).toEqual(["evt_a1", "evt_a2"]);
    const descRows = await store.findMany({
      where: { type: "a" },
      orderBy: "created_at DESC",
    });
    expect(descRows.map((r) => r.id)).toEqual(["evt_a2", "evt_a1"]);
    const sessRows = await store.findMany({ where: { sessionId: "sess-1" } });
    expect(sessRows).toHaveLength(3);
    const none = await store.findMany({ where: { sessionId: "other" } });
    expect(none).toEqual([]);
    const limited = await store.findMany({ orderBy: "created_at ASC", limit: 2 });
    expect(limited.map((r) => r.id)).toEqual(["evt_a1", "evt_b1"]);
  });

  it("chain continuity: each row links onto the previous row's hash", async () => {
    const store = newStore();
    await store.create(event("evt_1"));
    await store.create(event("evt_2"));
    await store.create(event("evt_3"));

    const window = await store.readChainWindow(0);
    expect(window).toHaveLength(3);
    expect(window[0].previousEventHash).toBeNull();
    expect(window[1].previousEventHash).toBe(window[0].eventHash);
    expect(window[2].previousEventHash).toBe(window[1].eventHash);
    expect(window.map((r) => r.rowid)).toEqual([1, 2, 3]);
    const diagnosis = diagnoseAuditChain(window);
    expect(diagnosis.valid).toBe(true);
  });

  it("concurrent appends from two instances never fork the chain", async () => {
    const mock = new MockD1Database();
    const storeA = new D1AuditEventStore(createD1AuditEventDb(mock as never));
    const storeB = new D1AuditEventStore(createD1AuditEventDb(mock as never));
    const writers = Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? storeA : storeB).create(
        event(`evt_c${i}`, { createdAt: `2026-11-25T10:00:${String(i).padStart(2, "0")}.000Z` }),
      ),
    );
    const written = await Promise.all(writers);
    expect(written).toHaveLength(20);
    expect(new Set(written.map((r) => r.id)).size).toBe(20);

    const window = await storeA.readChainWindow(0);
    expect(window).toHaveLength(20);
    // No fork: exactly one genesis row, every other row's previous
    // hash is exactly one earlier row's hash.
    const genesis = window.filter((r) => r.previousEventHash === null);
    expect(genesis).toHaveLength(1);
    const hashes = new Set(window.map((r) => r.eventHash));
    expect(hashes.size).toBe(20);
    for (const row of window.slice(1)) {
      expect(hashes.has(row.previousEventHash as string)).toBe(true);
    }
    expect(diagnoseAuditChain(window).valid).toBe(true);
  });

  it("the conditional insert writes 0 rows on a stale tail (the cross-instance guard)", async () => {
    const mock = new MockD1Database();
    const db = createD1AuditEventDb(mock as never);
    const store = new D1AuditEventStore(db);
    await store.create(event("evt_1"));
    // A writer that read the tail before evt_1 landed: its
    // expected tail (null = genesis) is stale — the insert must
    // write nothing instead of forking the chain.
    const result = (await executeDmlSql(
      DML_CATALOGUE,
      db,
      "dml.d1.mas_events.insert_chained",
      {
        id: "evt_stale",
        sessionId: "sess-1",
        type: "test.event",
        agent: "orchestrator",
        payload: "{}",
        createdAt: new Date().toISOString(),
        previousEventHash: null,
        eventHash: "deadbeef",
        platformId: null,
        tenantId: null,
        principalId: null,
        correlationId: null,
        traceId: null,
        expectedTail: null,
      },
    )) as { meta?: { changes?: number } };
    expect(result?.meta?.changes).toBe(0);
    expect(await store.findById("evt_stale")).toBeNull();
    expect(diagnoseAuditChain(await store.readChainWindow(0)).valid).toBe(true);
  });

  it("envelope columns round-trip", async () => {
    const store = newStore();
    await store.create(
      event("evt_env", {
        platformId: "cf",
        tenantId: "tenant-1",
        principalId: "user-1",
        correlationId: "corr-1",
        traceId: "trace-1",
      }),
    );
    const read = await store.findById("evt_env");
    expect(read?.platformId).toBe("cf");
    expect(read?.tenantId).toBe("tenant-1");
    expect(read?.principalId).toBe("user-1");
    expect(read?.correlationId).toBe("corr-1");
    expect(read?.traceId).toBe("trace-1");
  });

  it("idsCreatedBefore + delete: the retention selector", async () => {
    const store = newStore();
    await store.create(event("evt_old", { createdAt: "2025-01-01T00:00:00.000Z" }));
    await store.create(event("evt_new", { createdAt: "2026-11-25T00:00:00.000Z" }));
    expect(await store.idsCreatedBefore("2026-01-01T00:00:00.000Z", 10)).toEqual([
      "evt_old",
    ]);
    expect(await store.delete("evt_old")).toBe(true);
    expect(await store.findById("evt_old")).toBeNull();
    expect(await store.delete("evt_old")).toBe(false);
    expect(await store.idsCreatedBefore("2026-01-01T00:00:00.000Z", 10)).toEqual([]);
  });

  it("duplicate id throws (PRIMARY KEY), never a silent no-op", async () => {
    const store = newStore();
    await store.create(event("evt_dup"));
    await expect(store.create(event("evt_dup"))).rejects.toThrow();
    expect(await store.findMany({})).toHaveLength(1);
  });

  it("recordBlockingAuditAsync writes through the port and throws on a null port", async () => {
    const store = newStore();
    const written = await recordBlockingAuditAsync(store, event("evt_block"));
    expect(written.id).toBe("evt_block");
    expect(await store.findById("evt_block")).not.toBeNull();
    await expect(
      recordBlockingAuditAsync(null, event("evt_noport")),
    ).rejects.toThrow(/AGENT_DB unbound/);
  });
});
