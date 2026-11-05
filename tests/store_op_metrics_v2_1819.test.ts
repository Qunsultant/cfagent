/**
 * Issue #1819 — store_op v2 funnel (RED).
 *
 * The v1 record (ns/op/outcome/latencyMs) can count ops but cannot attribute
 * rows: it has no rowsRead, no caller, no trigger. These tests pin v2:
 * the funnel carries the DO reply's measured rows + statement into the log
 * record, attaches caller/trigger only where the call site passes attribution
 * explicitly (never inferred), and forwards the same event to a resource sink
 * (#1743 stream) when one is wired — without ever failing the op.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createStoreKv, type DoNamespaceLike } from "../src/data/durableKv";
import { setStoreOpSink, type StoreOpRecord } from "../src/security/storeMetrics";

function makeNamespace(reply: Record<string, unknown>) {
  const namespace: DoNamespaceLike = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => Response.json(reply),
    }),
  };
  return namespace;
}

let captured: StoreOpRecord[] = [];
afterEach(() => {
  setStoreOpSink(null);
  captured = [];
});

describe("store_op v2 (#1819)", () => {
  it("carries reply rows + statement and explicit attribution in the record", async () => {
    setStoreOpSink((r) => {
      captured.push(r);
    });
    const kv = createStoreKv({
      namespace: makeNamespace({
        value: "sess",
        rowsRead: 1,
        rowsWritten: 0,
        statement: "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?",
      }),
      namespaceName: "sessions",
      legacyFallback: false,
      attribution: { caller: "requireAuth", trigger: "user" },
    });
    await expect(kv.get("abc")).resolves.toBe("sess");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      event: "store_op",
      v: 2,
      ns: "sessions",
      op: "get",
      rowsRead: 1,
      rowsWritten: 0,
      caller: "requireAuth",
      trigger: "user",
      statement: "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?",
    });
  });

  it("omits caller/trigger when no attribution is passed (never inferred)", async () => {
    setStoreOpSink((r) => {
      captured.push(r);
    });
    const kv = createStoreKv({
      namespace: makeNamespace({ value: "sess", rowsRead: 1, rowsWritten: 0 }),
      namespaceName: "sessions",
      legacyFallback: false,
    });
    await kv.get("abc");
    expect(captured[0].caller).toBeUndefined();
    expect(captured[0].trigger).toBeUndefined();
  });

  it("forwards the measured event to a wired resource sink, and a throwing sink never fails the op", async () => {
    const record = vi.fn(() => {
      throw new Error("sink down");
    });
    const kv = createStoreKv({
      namespace: makeNamespace({ value: "sess", rowsRead: 1, rowsWritten: 0 }),
      namespaceName: "sessions",
      legacyFallback: false,
      attribution: { caller: "requireAuth", trigger: "user" },
      resourceSink: { record } as never,
    });
    await expect(kv.get("abc")).resolves.toBe("sess");
    expect(record).toHaveBeenCalledTimes(1);
    const event = record.mock.calls[0][0];
    expect(event).toMatchObject({
      ns: "sessions",
      op: "get",
      rowsRead: 1,
      rowsWritten: 0,
      caller: "requireAuth",
      trigger: "user",
    });
    expect(typeof event.timestampMs).toBe("number");
  });
});
