import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { consumeStoreKey, createStoreKv, type DoNamespaceLike } from "../src/data/durableKv";
import { createResilientKv } from "../src/security/kvResilience";

/**
 * Issue #329 — sessions and credentials moved off KV onto the SessionStore
 * Durable Object. These tests model the DO protocol in memory and pin the
 * migration path: the DO is authoritative, the legacy KV is consulted only on a
 * miss (and then written through), and neither backend failure throws.
 */
interface Row {
  value: string;
  expiresAt: number | null;
}

function makeStore(options: { fail?: boolean } = {}) {
  const rows = new Map<string, Row>();

  const namespace: DoNamespaceLike = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        if (options.fail) throw new Error("DO unavailable");
        const { op, ns, key, value, ttl } = (await request.json()) as {
          op: string;
          ns: string;
          key: string;
          value?: string;
          ttl?: number;
        };
        const id = `${ns}:${key}`;

        if (op === "get") {
          const row = rows.get(id);
          if (!row) return Response.json({ value: null });
          if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
            rows.delete(id);
            return Response.json({ value: null });
          }
          return Response.json({ value: row.value });
        }
        if (op === "put") {
          rows.set(id, { value: value as string, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
          return Response.json({ ok: true });
        }
        if (op === "consume") {
          // The DO handles one request at a time, so this read-then-write is
          // atomic. The fake mirrors that by not awaiting between the two.
          const row = rows.get(id);
          if (row && (row.expiresAt === null || row.expiresAt > Date.now())) {
            return Response.json({ consumed: false });
          }
          rows.set(id, { value: value ?? "", expiresAt: ttl ? Date.now() + ttl * 1000 : null });
          return Response.json({ consumed: true });
        }
        rows.delete(id);
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

describe("Durable Object backed store (#329)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves reads from the store without touching KV", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await kv.put("session-1", "payload");

    expect(await kv.get("session-1")).toBe("payload");
    expect(legacy.get).not.toHaveBeenCalled();
    expect(store.rows.get("sessions:session-1")?.value).toBe("payload");
  });

  it("migrates a legacy value on first read, then stops consulting KV", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("old-session", "legacy-payload");
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    expect(await kv.get("old-session")).toBe("legacy-payload");
    expect(legacy.get).toHaveBeenCalledTimes(1);
    expect(store.rows.get("sessions:old-session")?.value).toBe("legacy-payload");

    expect(await kv.get("old-session")).toBe("legacy-payload");
    expect(legacy.get).toHaveBeenCalledTimes(1);
  });

  it("honours the TTL it was given", async () => {
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });

    await kv.put("short", "payload", { expirationTtl: 60 });
    expect(await kv.get("short")).toBe("payload");

    vi.advanceTimersByTime(61_000);
    expect(await kv.get("short")).toBeNull();
  });

  it("skips KV entirely when the fallback is off", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("old-session", "legacy-payload");
    const kv = createStoreKv({
      namespace: store.namespace,
      legacy,
      namespaceName: "sessions",
      legacyFallback: false,
    });

    // No migration read...
    expect(await kv.get("old-session")).toBeNull();
    expect(legacy.get).not.toHaveBeenCalled();

    // ...and no write or delete fallback either: the flag means "KV is not part
    // of this store", not just "do not read the legacy key".
    await kv.put("new-session", "payload");
    await kv.delete("new-session");
    await kv.delete("old-session");

    expect(legacy.put).not.toHaveBeenCalled();
    expect(legacy.delete).not.toHaveBeenCalled();
    expect(legacy.data.has("old-session")).toBe(true);
  });

  it("keeps working from KV when the store is unavailable", async () => {
    const store = makeStore({ fail: true });
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await kv.put("k", "v");
    expect(legacy.data.get("k")).toBe("v");
    expect(await kv.get("k")).toBe("v");
  });

  it("still writes to KV when the store is absent (local dev)", async () => {
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: null, legacy, namespaceName: "sessions" });

    await kv.put("k", "v");
    expect(await kv.get("k")).toBe("v");
  });

  it("deletes from both backends so logout cannot leave a stale copy", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("k", "legacy");
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });
    await kv.put("k", "v");

    await kv.delete("k");

    expect(store.rows.has("sessions:k")).toBe(false);
    expect(legacy.data.has("k")).toBe(false);
  });

  it("claims a replay key exactly once", async () => {
    const store = makeStore();

    const first = await consumeStoreKey({
      namespace: store.namespace,
      namespaceName: "payments",
      key: "x402tx:0xabc",
      value: "claimed",
      ttlSeconds: 60,
    });
    const second = await consumeStoreKey({
      namespace: store.namespace,
      namespaceName: "payments",
      key: "x402tx:0xabc",
      value: "claimed",
      ttlSeconds: 60,
    });

    expect(first).toBe("consumed");
    expect(second).toBe("duplicate");
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const store = makeStore();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        consumeStoreKey({
          namespace: store.namespace,
          namespaceName: "payments",
          key: "x402tx:race",
          value: "claimed",
          ttlSeconds: 60,
        })
      )
    );

    expect(outcomes.filter((entry) => entry === "consumed")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry === "duplicate")).toHaveLength(4);
  });

  it("releases the key once its claim TTL lapses", async () => {
    const store = makeStore();
    const options = {
      namespace: store.namespace,
      namespaceName: "payments",
      key: "x402tx:ttl",
      value: "claimed",
      ttlSeconds: 60,
    };

    expect(await consumeStoreKey(options)).toBe("consumed");
    expect(await consumeStoreKey(options)).toBe("duplicate");

    vi.advanceTimersByTime(61_000);
    expect(await consumeStoreKey(options)).toBe("consumed");
  });

  it("reports the store as unavailable instead of claiming", async () => {
    expect(
      await consumeStoreKey({ namespace: null, namespaceName: "payments", key: "k", value: "v" })
    ).toBe("unavailable");
  });

  it("putIfAbsent claims a key exactly once via the atomic consume op (#1756)", async () => {
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });

    expect(await kv.putIfAbsent?.("genesis:primary", "winner")).toBe(true);
    expect(await kv.putIfAbsent?.("genesis:primary", "loser")).toBe(false);
    expect(await kv.get("genesis:primary")).toBe("winner");
  });

  it("putIfAbsent fails closed when the store is unavailable (#1756)", async () => {
    const store = makeStore({ fail: true });
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });

    // Not a throw, not a claim: false means "not claimed by this
    // caller", so the genesis path takes the closed branch instead
    // of granting on an unknown store state.
    expect(await kv.putIfAbsent?.("genesis:primary", "winner")).toBe(false);
  });

  it("the resilient wrapper forwards putIfAbsent and keeps it absent when the backend lacks it (#1756)", async () => {
    const map = new Map<string, string>();
    const backing = {
      get: async (key: string) => map.get(key) ?? null,
      put: async (key: string, value: string) => {
        map.set(key, value);
      },
      delete: async (key: string) => {
        map.delete(key);
      },
    };
    const withClaim = createResilientKv(
      {
        ...backing,
        putIfAbsent: async (key: string, value: string) => {
          if (map.has(key)) return false;
          map.set(key, value);
          return true;
        },
      },
      "claim-test",
    );
    expect(await withClaim.putIfAbsent?.("k", "v")).toBe(true);
    expect(await withClaim.putIfAbsent?.("k", "v2")).toBe(false);
    expect(map.get("k")).toBe("v");

    const withoutClaim = createResilientKv(backing, "noclaim-test");
    expect(withoutClaim.putIfAbsent).toBeUndefined();
  });

  it("does not throw when both backends fail", async () => {
    const store = makeStore({ fail: true });
    const legacy = createResilientKv(
      {
        get: async () => {
          throw new Error("KV get() limit exceeded for the day.");
        },
        put: async () => undefined,
        delete: async () => undefined,
      },
      "sessions-test"
    );
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await expect(kv.get("k")).resolves.toBeNull();
    await expect(kv.put("k", "v")).resolves.toBeUndefined();
    await expect(kv.delete("k")).resolves.toBeUndefined();
  });
});
