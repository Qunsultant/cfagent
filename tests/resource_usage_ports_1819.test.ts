/**
 * Issue #1819 — ResourceUsagePort (measurement slice).
 *
 * RED tests: these import modules that do not exist yet
 * (`src/telemetry/resourceUsagePorts.ts` and its adapters). The port is pure:
 * no bindings, no I/O, no Cloudflare imports — so it can be unit-tested under
 * Node exactly as #1742's TelemetryPort is.
 *
 * Design constraints pinned here (owner instrument-first direction, aligned
 * shape): events carry rowsRead/rowsWritten/caller/trigger/statement
 * fingerprint and NEVER bindings, tokens, user data, or raw session ids;
 * the observability conversion must land inside #1743's landed event schema
 * (tenant/run/session scope, key-based redaction) as a new event type, not a
 * second schema; bucketTotals is the single aggregation definition so the
 * instrumented totals line up against the Cloudflare dashboard's hourly
 * curves in the same units (rows read/written per op).
 */
import { describe, it, expect, vi } from "vitest";
import {
  fingerprintSql,
  toObservabilityEvent,
  bucketTotals,
  type ResourceUsageEvent,
} from "../src/telemetry/resourceUsagePorts";
import { InMemoryResourceUsageAdapter } from "../src/telemetry/inMemoryResourceUsageAdapter";
import { createD1ResourceDb, D1ResourceUsageAdapter } from "../src/telemetry/d1ResourceUsageAdapter";
import { ObservabilityResourceUsageAdapter } from "../src/telemetry/resourceUsageObservabilityAdapter";

const SENSITIVE_KEY =
  /key|secret|token|password|authorization|cookie|session|credential|api[-_]?key/i;

function sampleEvent(overrides: Partial<ResourceUsageEvent> = {}): ResourceUsageEvent {
  return {
    ns: "sessions",
    op: "get",
    rowsRead: 1,
    rowsWritten: 0,
    caller: "requireAuth",
    trigger: "user",
    statement: "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?",
    timestampMs: 1_000,
    ...overrides,
  };
}

describe("fingerprintSql", () => {
  it("collapses whitespace and trims, preserving the parameterized template", () => {
    expect(
      fingerprintSql(`SELECT  value,  expires_at
        FROM kv_store WHERE ns = ? AND key = ?`)
    ).toBe("SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?");
  });

  it("never contains a bound value: templates use placeholders only", () => {
    const fp = fingerprintSql("SELECT value FROM kv_store WHERE ns = ? AND key = ?");
    expect(fp).not.toContain("sessions");
    expect(fp).toContain("?");
  });
});

describe("toObservabilityEvent (#1743 schema, new event type)", () => {
  it("maps a resource event onto the landed ObservabilityEvent shape", () => {
    const out = toObservabilityEvent(sampleEvent());
    expect(out.type).toBe("resource.sql_op");
    expect(out.operation).toBe("resource.sql_op");
    expect(out.level).toBe("info");
    expect(out.fields).toMatchObject({
      ns: "sessions",
      op: "get",
      rowsRead: 1,
      rowsWritten: 0,
      caller: "requireAuth",
      trigger: "user",
    });
    expect(out.timestampMs).toBe(1_000);
  });

  it("emits no sensitive field key (key-based redaction must have nothing to redact)", () => {
    const out = toObservabilityEvent(sampleEvent());
    for (const k of Object.keys(out.fields)) {
      expect(k).not.toMatch(SENSITIVE_KEY);
    }
  });

  it("carries sessionRef only when the caller passes an already-hashed ref — never a raw id", () => {
    expect(toObservabilityEvent(sampleEvent()).sessionRef).toBeNull();
    expect(toObservabilityEvent(sampleEvent({ sessionRef: "a1b2c3d4e5f6" })).sessionRef).toBe(
      "a1b2c3d4e5f6"
    );
  });

  it("defaults tenant/run scope to null (the #1743 'none' mapping happens at the AE adapter)", () => {
    const out = toObservabilityEvent(sampleEvent());
    expect(out.tenantId).toBeNull();
    expect(out.runId).toBeNull();
  });
});

describe("bucketTotals (dashboard-comparable aggregation)", () => {
  it("buckets by time and groups by ns/op/caller/trigger, summing rows", () => {
    const totals = bucketTotals(
      [
        sampleEvent({ timestampMs: 1_000 }),
        sampleEvent({ timestampMs: 2_000, rowsRead: 3 }),
        sampleEvent({ timestampMs: 3_700_000, caller: "renewAllStoredETradeTokens", trigger: "scheduled", op: "list", rowsRead: 42 }),
      ],
      3_600_000
    );
    expect(totals).toEqual([
      {
        bucketStartMs: 0,
        ns: "sessions",
        op: "get",
        caller: "requireAuth",
        trigger: "user",
        ops: 2,
        rowsRead: 4,
        rowsWritten: 0,
      },
      {
        bucketStartMs: 3_600_000,
        ns: "sessions",
        op: "list",
        caller: "renewAllStoredETradeTokens",
        trigger: "scheduled",
        ops: 1,
        rowsRead: 42,
        rowsWritten: 0,
      },
    ]);
  });

  it("labels absent caller/trigger as 'unknown' for aggregation only", () => {
    const totals = bucketTotals(
      [sampleEvent({ timestampMs: 500, caller: undefined, trigger: undefined })],
      3_600_000
    );
    expect(totals[0].caller).toBe("unknown");
    expect(totals[0].trigger).toBe("unknown");
  });
});

describe("InMemoryResourceUsageAdapter", () => {
  it("records events and returns bucketed totals", async () => {
    const adapter = new InMemoryResourceUsageAdapter();
    await adapter.record(sampleEvent({ timestampMs: 1_000 }));
    await adapter.record(sampleEvent({ timestampMs: 2_000, rowsRead: 2 }));
    const totals = await adapter.totals(0, 3_600_000, 3_600_000);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ ops: 2, rowsRead: 3 });
    expect(adapter.events()).toHaveLength(2);
  });
});

describe("D1ResourceUsageAdapter (fake D1, no migration-runner coupling)", () => {
  function makeFakeD1(totalsRows: Array<Record<string, unknown>> = []) {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              run: async () => {
                inserts.push({ sql, params });
                return { success: true };
              },
              all: async () => ({ results: totalsRows }),
              // drizzle-orm 0.45.4's select-with-fields path reads
              // array-mode rows via .raw(); the totals select lists
              // bucket, ns, op, caller, trigger, ops, rows_read,
              // rows_written in that order.
              raw: async () =>
                totalsRows.map((r) => [
                  r.bucket,
                  r.ns,
                  r.op,
                  r.caller,
                  r.trigger,
                  r.ops,
                  r.rows_read,
                  r.rows_written,
                ]),
            };
          },
        };
      },
    };
    return { db, inserts };
  }

  it("creates its table idempotently and inserts one row per event", async () => {
    const { db, inserts } = makeFakeD1();
    const adapter = new D1ResourceUsageAdapter(createD1ResourceDb(db as never));
    await adapter.record(sampleEvent());
    // #4282 P6a (#4384): the insert is built by the Drizzle
    // builder (catalogue entry), so its rendering is lowercase
    // with the table name quoted — match that, not the old raw
    // "INSERT INTO resource_sql_ops" text.
    const insert = inserts.find((i) => /insert into "resource_sql_ops"/i.test(i.sql));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain("sessions");
    expect(insert!.params).toContain(1); // rows_read
    expect(inserts.some((i) => i.sql.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
  });

  it("maps totals rows back to bucketed totals", async () => {
    const { db } = makeFakeD1([
      { bucket: 0, ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 5, rows_read: 5, rows_written: 0 },
    ]);
    const adapter = new D1ResourceUsageAdapter(createD1ResourceDb(db as never));
    const totals = await adapter.totals(0, 3_600_000, 3_600_000);
    expect(totals).toEqual([
      {
        bucketStartMs: 0,
        ns: "sessions",
        op: "get",
        caller: "requireAuth",
        trigger: "user",
        ops: 5,
        rowsRead: 5,
        rowsWritten: 0,
      },
    ]);
  });
});

describe("ObservabilityResourceUsageAdapter (#1743 transport)", () => {
  it("writes the converted event to the sink", async () => {
    const write = vi.fn();
    const adapter = new ObservabilityResourceUsageAdapter({ write } as never);
    await adapter.record(sampleEvent());
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].type).toBe("resource.sql_op");
  });

  it("never throws when the sink throws (measurement must not break the op path)", async () => {
    const adapter = new ObservabilityResourceUsageAdapter({
      write: () => {
        throw new Error("AE down");
      },
    } as never);
    await expect(adapter.record(sampleEvent())).resolves.toBeUndefined();
  });
});
