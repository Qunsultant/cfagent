import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  consumeStoreKey,
  createStoreKv,
  listStoreEntries,
  type DoNamespaceLike,
} from "../src/data/durableKv";
import {
  recordStoreOp,
  setStoreOpSink,
  type StoreOpRecord,
} from "../src/security/storeMetrics";

/**
 * Issue #910 — SessionStore data-plane observability.
 *
 * Every store op must emit exactly one structured record (ns, op, outcome,
 * client-observed latency) so the #789 sharding triggers T1 (op rate) and T2
 * (failure rate) can be evaluated from Workers Logs. Emission is best-effort:
 * it must never change a return value or break the adapter's never-throws
 * contract — including when the metrics sink itself throws.
 */

type StoreMode = "ok" | "httpError" | "throw" | "hangUntilAbort";

function makeStore(mode: StoreMode = "ok") {
  const rows = new Map<string, string>();
  const namespace: DoNamespaceLike = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        if (mode === "httpError") {
          return new Response("overloaded", { status: 503 });
        }
        if (mode === "throw") {
          throw new Error("DO exploded");
        }
        if (mode === "hangUntilAbort") {
          // Never resolves on its own; rejects only when the client's
          // AbortSignal (the 2,000 ms budget in durableKv) fires.
          return await new Promise<Response>((_resolve, reject) => {
            const signal = request.signal;
            if (!signal) return;
            if (signal.aborted) {
              reject(signal.reason ?? new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () =>
              reject(signal.reason ?? new Error("aborted"))
            );
          });
        }
        const { op, ns, key, value } = (await request.json()) as {
          op: string;
          ns: string;
          key: string;
          value?: string;
        };
        const id = `${ns}:${key}`;
        if (op === "get") return Response.json({ value: rows.get(id) ?? null });
        if (op === "put") {
          rows.set(id, value as string);
          return Response.json({ ok: true });
        }
        if (op === "delete") {
          rows.delete(id);
          return Response.json({ ok: true });
        }
        if (op === "consume") {
          if (rows.has(id)) return Response.json({ consumed: false });
          rows.set(id, value ?? "");
          return Response.json({ consumed: true });
        }
        if (op === "list") {
          const entries = [...rows.entries()]
            .filter(([id]) => id.startsWith(`${ns}:${key}`))
            .map(([id, v]) => ({ key: id.slice(ns.length + 1), value: v }));
          return Response.json({ entries });
        }
        return Response.json({ ok: true });
      },
    }),
  };
  return { namespace, rows };
}

function makeLegacy() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
}

describe("SessionStore op metrics (#910)", () => {
  let records: StoreOpRecord[];

  beforeEach(() => {
    records = [];
    setStoreOpSink((record) => records.push(record));
  });

  afterEach(() => {
    setStoreOpSink(null);
    vi.restoreAllMocks();
  });

  it("emits one ok record for a successful get (hit)", async () => {
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });
    await kv.put("k", "v");
    records.length = 0;

    expect(await kv.get("k")).toBe("v");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "store_op",
      ns: "sessions",
      op: "get",
      instance: "kv",
      outcome: "ok",
    });
    expect(typeof records[0].latencyMs).toBe("number");
    expect(records[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof records[0].ts).toBe("number");
  });

  it("emits a miss record when the store answers with no value", async () => {
    const store = makeStore();
    const kv = createStoreKv({
      namespace: store.namespace,
      namespaceName: "etrade",
      legacyFallback: false,
    });

    expect(await kv.get("absent")).toBeNull();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ns: "etrade", op: "get", outcome: "miss" });
  });

  it("emits ok records for put, delete, consume and list", async () => {
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "api_keys" });

    await kv.put("k", "v");
    await kv.delete("k");
    const consumed = await consumeStoreKey({
      namespace: store.namespace,
      namespaceName: "payments",
      key: "x402tx:1",
      value: "claimed",
    });
    const entries = await listStoreEntries({
      namespace: store.namespace,
      namespaceName: "etrade",
      prefix: "etrade:token:",
    });

    expect(consumed).toBe("consumed");
    expect(entries).toEqual([]);
    expect(records.map((r) => [r.ns, r.op, r.outcome])).toEqual([
      ["api_keys", "put", "ok"],
      ["api_keys", "delete", "ok"],
      ["payments", "consume", "ok"],
      ["etrade", "list", "ok"],
    ]);
  });

  it("counts a duplicate consume as ok (the store answered) and keeps the return value", async () => {
    const store = makeStore();
    const options = {
      namespace: store.namespace,
      namespaceName: "payments",
      key: "x402tx:dup",
      value: "claimed",
    };

    expect(await consumeStoreKey(options)).toBe("consumed");
    expect(await consumeStoreKey(options)).toBe("duplicate");

    expect(records.map((r) => r.outcome)).toEqual(["ok", "ok"]);
  });

  it("emits a failed record on a non-200 store response and still resolves null", async () => {
    const store = makeStore("httpError");
    const kv = createStoreKv({
      namespace: store.namespace,
      namespaceName: "sessions",
      legacyFallback: false,
    });

    await expect(kv.get("k")).resolves.toBeNull();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op: "get", outcome: "failed", httpStatus: 503 });
  });

  it("emits a failed record when the store fetch throws", async () => {
    const store = makeStore("throw");
    const kv = createStoreKv({
      namespace: store.namespace,
      namespaceName: "sessions",
      legacyFallback: false,
    });

    await expect(kv.get("k")).resolves.toBeNull();
    await expect(kv.put("k", "v")).resolves.toBeUndefined();

    expect(records.map((r) => [r.op, r.outcome])).toEqual([
      ["get", "failed"],
      ["put", "failed"],
    ]);
  });

  it("emits a failed record when the store call times out", async () => {
    const store = makeStore("hangUntilAbort");
    const kv = createStoreKv({
      namespace: store.namespace,
      namespaceName: "sessions",
      legacyFallback: false,
    });

    await expect(kv.get("k")).resolves.toBeNull();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op: "get", outcome: "failed" });
    // The client budget is 2,000 ms; the recorded latency must reflect the wait.
    expect(records[0].latencyMs).toBeGreaterThanOrEqual(1_500);
  }, 10_000);

  it("emits an unavailable record when no store binding exists", async () => {
    const kv = createStoreKv({ namespace: null, namespaceName: "sessions" });

    await expect(kv.get("k")).resolves.toBeNull();

    expect(
      await consumeStoreKey({ namespace: null, namespaceName: "payments", key: "k", value: "v" })
    ).toBe("unavailable");

    expect(records.map((r) => [r.op, r.outcome])).toEqual([
      ["get", "unavailable"],
      ["consume", "unavailable"],
    ]);
  });

  it("records the legacy-migration put as its own op", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("old", "legacy-payload");
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    expect(await kv.get("old")).toBe("legacy-payload");

    expect(records.map((r) => [r.op, r.outcome])).toEqual([
      ["get", "miss"],
      ["put", "ok"],
    ]);
  });

  it("falls back to legacy on a failed put and records the failure exactly once", async () => {
    const store = makeStore("throw");
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await kv.put("k", "v");

    expect(legacy.data.get("k")).toBe("v");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op: "put", outcome: "failed" });
  });

  it("a throwing metrics sink cannot break an op or change its result", async () => {
    setStoreOpSink(() => {
      throw new Error("metrics exploded");
    });
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });

    await expect(kv.put("k", "v")).resolves.toBeUndefined();
    await expect(kv.get("k")).resolves.toBe("v");
    await expect(kv.get("absent")).resolves.toBeNull();
    await expect(kv.delete("k")).resolves.toBeUndefined();
    expect(
      await consumeStoreKey({
        namespace: store.namespace,
        namespaceName: "payments",
        key: "x402tx:sink",
        value: "claimed",
      })
    ).toBe("consumed");
  });

  it("recordStoreOp itself never throws, whatever the sink does", () => {
    setStoreOpSink(() => {
      throw new Error("boom");
    });
    expect(() =>
      recordStoreOp({
        event: "store_op",
        v: 1,
        ns: "sessions",
        op: "get",
        instance: "kv",
        outcome: "ok",
        latencyMs: 1,
        ts: Date.now(),
      })
    ).not.toThrow();
  });

  it("the default sink emits one parseable JSON line per op to console.log", async () => {
    setStoreOpSink(null); // back to the default sink
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });

    await kv.put("k", "v");

    const parsed = logged
      .map((line) => {
        try {
          return JSON.parse(line) as StoreOpRecord;
        } catch {
          return null;
        }
      })
      .filter((r) => r?.event === "store_op");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ ns: "sessions", op: "put", outcome: "ok" });
  });
});
