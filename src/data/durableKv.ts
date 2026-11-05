import type { KvLike } from "../security/kvResilience";
import { recordStoreOp, type StoreOpOutcome } from "../security/storeMetrics";
import type {
  ResourceAttribution,
  ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";

/**
 * Durable Object-backed KV replacement (issue #329 follow-up).
 *
 * Why: Workers KV's free tier caps reads at 100k/day, and exhausting it took
 * the whole site down (every `getSession` threw). CORRECTION (issue #1819):
 * Durable Object SQLite on the free tier is NOT uncapped either (5M rows
 * read/day, 100k rows written/day) — the earlier "no equivalent daily read
 * cap" wording was wrong, and the 2026-10-26 rows-read exhaustion took
 * sign-in down the same way. Sessions, credentials and replay-guard state
 * still live here, and KV remains a one-time migration source; the cap
 * correction is what #1819's instrumentation exists to watch.
 *
 * Wire format is deliberately a tiny JSON protocol over `stub.fetch` rather
 * than RPC: it needs no `cloudflare:workers` import on the client side, which
 * keeps this module (and the fallback logic) unit-testable under Node.
 *
 * Issue #2436 (#1976 step 5e): this module's home is now the data
 * layer (src/data/) — it is the DO adapters' client: every
 * src/data/ family adapter (sessions 5b, tokens 5c, audit 5d,
 * residual buckets 5e) composes it from inside the layer, and the
 * only above-layer importers left are the family façades' flag-off
 * branches and the named admin-route compositions, pinned exactly
 * by the census (tests/global_dd_census_2356.test.ts, step-5e
 * section). The wire protocol, metrics and semantics are
 * unchanged by the move.
 */
export interface DoStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DoStubLike;
}

export interface StoreKvOptions {
  /** The DO namespace (env.SESSION_STORE). When absent, `legacy` is used alone. */
  namespace?: DoNamespaceLike | null;
  /** Legacy KV to read from on a DO miss (migration) and fall back to on failure. */
  legacy?: KvLike | null;
  /** Logical bucket inside the DO: "sessions", "etrade", "payments". */
  namespaceName: string;
  /** DO instance name; one instance holds every bucket. */
  instanceName?: string;
  /** Set false to stop consulting KV entirely (after migration). */
  legacyFallback?: boolean;
  /**
   * Explicit call-site attribution for store_op v2 (#1819). Passed only by
   * call sites that know their caller/trigger; never inferred. When absent,
   * the record simply omits caller/trigger.
   */
  attribution?: ResourceAttribution;
  /**
   * Resource sink for the #1743 stream (#1819). When wired, the funnel
   * forwards the measured event here in addition to the store_op v2 log
   * line; when absent, the log line is the only record. Forwarding never
   * throws and never adds a store round-trip.
   */
  resourceSink?: ResourceUsagePort;
}

const STORE_URL = "https://session-store.internal/kv";
const CALL_TIMEOUT_MS = 2_000;

export interface StoreReply {
  value?: string | null;
  ok?: boolean;
  consumed?: boolean;
  error?: string;
  entries?: Array<{ key: string; value: string }>;
  /** #1760: the chained event returned by the audit-append op. */
  event?: unknown;
  /** #1760: the audit-append op refused the event: the store is at its total cap. */
  storeFull?: boolean;
  /** Platform-measured rows for this op (#1819); absent from older replies. */
  rowsRead?: number;
  rowsWritten?: number;
  /** Parameterized statement template (#1819); absent from older replies. */
  statement?: string;
}

function timeoutSignal(): AbortSignal | undefined {
  // Workers and Node 18+ both expose AbortSignal.timeout; guard for safety.
  const anySignal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  return typeof anySignal.timeout === "function" ? anySignal.timeout(CALL_TIMEOUT_MS) : undefined;
}

/**
 * Classify a store reply for the op-metrics record (issue #910). The store
 * answered; whether that is an "ok" depends on the op's reply contract. A
 * `get` that finds nothing is a "miss", not a failure — T2's failure rate
 * must count only real failures or it cries wolf on every cold cache.
 */
function classifyStoreOutcome(op: string, reply: StoreReply): StoreOpOutcome {
  if (reply.error) return "failed";
  switch (op) {
    case "get":
      if (typeof reply.value === "string") return "ok";
      return reply.value == null ? "miss" : "failed";
    case "put":
    case "delete":
      return reply.ok === true ? "ok" : "failed";
    case "consume":
      return typeof reply.consumed === "boolean" ? "ok" : "failed";
    case "audit-append":
      // #1760: a storeFull refusal is a failed append, not a success
      // — counting it "ok" would hide cap exhaustion in the metrics.
      return reply.storeFull === true || reply.ok !== true ? "failed" : "ok";
    case "list":
      return Array.isArray(reply.entries) ? "ok" : "failed";
    default:
      return "ok";
  }
}

/**
 * #1760 — the raw DO-request sender, exported so the atomic audit
 * backend (iaaaAuditStore.ts) can speak the same store protocol
 * (same URL, timeout, metrics, and reply classification) without
 * going through the KvLike get/put surface, which cannot express
 * an atomic append. createStoreKv stays the KvLike adapter.
 */
export function createStoreSender(
  namespace: DoNamespaceLike | null | undefined,
  namespaceName: string,
  instanceName: string,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): (payload: Record<string, unknown>) => Promise<StoreReply | null> {
  return createStoreClient(namespace, namespaceName, instanceName, resource);
}

function createStoreClient(
  namespace: DoNamespaceLike | null | undefined,
  namespaceName: string,
  instanceName: string,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): (payload: Record<string, unknown>) => Promise<StoreReply | null> {
  return async (payload: Record<string, unknown>): Promise<StoreReply | null> => {
    // One metrics record per op, emitted on every exit path (issue #910).
    // recordStoreOp never throws and adds no store round-trip, so the
    // never-throws contract and every return value below are unchanged.
    // The T1/T2 aggregation over these records is documented in
    // docs/OBSERVABILITY.md §4. v2 (#1819) adds measured rows + explicit
    // attribution on the success path; failure paths carry no rows because
    // no reply was measured.
    const op = String(payload.op);
    if (!namespace) {
      recordStoreOp({
        event: "store_op",
        v: 2,
        ns: namespaceName,
        op,
        instance: instanceName,
        outcome: "unavailable",
        latencyMs: 0,
        ts: Date.now(),
      });
      return null;
    }
    const startedAt = Date.now();
    try {
      const stub = namespace.get(namespace.idFromName(instanceName));
      const response = await stub.fetch(
        new Request(STORE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: timeoutSignal(),
        })
      );
      if (!response.ok) {
        console.warn(`[store:${namespaceName}] ${String(payload.op)} failed: HTTP ${response.status}`);
        recordStoreOp({
          event: "store_op",
          v: 2,
          ns: namespaceName,
          op,
          instance: instanceName,
          outcome: "failed",
          latencyMs: Date.now() - startedAt,
          httpStatus: response.status,
          ts: Date.now(),
        });
        return null;
      }
      const reply = (await response.json()) as StoreReply;
      recordStoreOp({
        event: "store_op",
        v: 2,
        ns: namespaceName,
        op,
        instance: instanceName,
        outcome: classifyStoreOutcome(op, reply),
        latencyMs: Date.now() - startedAt,
        ts: Date.now(),
        ...(reply.rowsRead !== undefined ? { rowsRead: reply.rowsRead } : {}),
        ...(reply.rowsWritten !== undefined ? { rowsWritten: reply.rowsWritten } : {}),
        ...(resource?.attribution ? { caller: resource.attribution.caller } : {}),
        ...(resource?.attribution ? { trigger: resource.attribution.trigger } : {}),
        ...(reply.statement !== undefined ? { statement: reply.statement } : {}),
      });
      if (resource?.resourceSink && reply.rowsRead !== undefined) {
        try {
          await resource.resourceSink.record({
            ns: namespaceName,
            op,
            rowsRead: reply.rowsRead,
            rowsWritten: reply.rowsWritten ?? 0,
            ...(resource.attribution ? { caller: resource.attribution.caller } : {}),
            ...(resource.attribution ? { trigger: resource.attribution.trigger } : {}),
            ...(reply.statement !== undefined ? { statement: reply.statement } : {}),
            timestampMs: Date.now(),
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          console.warn(
            `[store:${namespaceName}] resource sink failed:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      return reply;
    } catch (error) {
      console.warn(
        `[store:${namespaceName}] ${String(payload.op)} failed:`,
        error instanceof Error ? error.message : String(error)
      );
      recordStoreOp({
        event: "store_op",
        v: 2,
        ns: namespaceName,
        op,
        instance: instanceName,
        outcome: "failed",
        latencyMs: Date.now() - startedAt,
        ts: Date.now(),
      });
      return null;
    }
  };
}

/**
 * A KV-like store whose reads come from the Durable Object and which falls back
 * to the legacy KV exactly once per key (copying the value into the DO as it
 * goes). No call throws: a DO failure degrades to the legacy backend, and a
 * legacy failure degrades to a miss — never to a 1101.
 */
export function createStoreKv(options: StoreKvOptions): KvLike {
  const { namespace, legacy, namespaceName, instanceName = "kv", legacyFallback = true } = options;
  // `legacyFallback: false` means "KV is not part of this store at all" - no
  // migration read, no write fallback, no delete. Gating only the read would
  // leave KV traffic that the flag is supposed to stop.
  const legacyStore = legacyFallback ? legacy : null;
  const send = createStoreClient(namespace, namespaceName, instanceName, {
    attribution: options.attribution,
    resourceSink: options.resourceSink,
  });

  return {
    async get(key: string): Promise<string | null> {
      const fromStore = await send({ op: "get", ns: namespaceName, key });
      if (fromStore && typeof fromStore.value === "string") return fromStore.value;

      // Miss (or store unavailable): consult the legacy KV once, then migrate.
      if (!legacyStore) return null;
      const legacyValue = await legacyStore.get(key);
      if (legacyValue === null) return null;

      // Copy through to the store so the next read is served from it. Awaited
      // (not fire-and-forget) so a cold isolate cannot drop the migration.
      await send({ op: "put", ns: namespaceName, key, value: legacyValue });
      return legacyValue;
    },

    async put(key: string, value: string, putOptions?: { expirationTtl?: number }): Promise<void> {
      const stored = await send({
        op: "put",
        ns: namespaceName,
        key,
        value,
        ttl: putOptions?.expirationTtl,
      });
      if (stored) return;
      // Store unavailable — keep the write somewhere durable rather than losing it.
      if (legacyStore) await legacyStore.put(key, value, putOptions);
    },

    /**
     * #1756 — atomic claim for KvLike.putIfAbsent, riding the DO's
     * existing atomic `consume` op (the same serialized
     * SELECT-then-INSERT the x402 replay guard uses): one DO request
     * performs the check and the set, so two concurrent claimants
     * cannot both win. No TTL: a genesis marker never expires, and
     * an expired row counts as absent by the consume op's rule.
     * Deliberately NO legacy fallback: legacy KV has no atomic op,
     * so a fallback write would silently reintroduce the race the
     * caller is trying to close. When the DO cannot be reached the
     * reply is null and this returns false — "not claimed" — so the
     * caller fails closed (genesis-closed path, no platform grant)
     * instead of granting on an unknown store state.
     */
    async putIfAbsent(key: string, value: string): Promise<boolean> {
      const reply = await send({
        op: "consume",
        ns: namespaceName,
        key,
        value,
      });
      if (!reply || typeof reply.consumed !== "boolean") return false;
      return reply.consumed;
    },

    async delete(key: string): Promise<void> {
      await send({ op: "delete", ns: namespaceName, key });
      if (legacyStore) await legacyStore.delete(key);
    },
  };
}

/** List entries in a Durable Object bucket by prefix for internal maintenance. */
export async function listStoreEntries(options: {
  namespace?: DoNamespaceLike | null;
  namespaceName: string;
  prefix: string;
  instanceName?: string;
}): Promise<Array<{ key: string; value: string }> | null> {
  const send = createStoreClient(options.namespace, options.namespaceName, options.instanceName ?? "kv");
  const reply = await send({ op: "list", ns: options.namespaceName, key: options.prefix });
  return Array.isArray(reply?.entries) ? reply.entries : null;
}

export type ConsumeOutcome = "consumed" | "duplicate" | "unavailable";

/**
 * Atomically claims `key` — the replay guard for x402 payments.
 *
 * The Durable Object handles one request at a time, so its
 * `SELECT`-then-`INSERT` cannot interleave with another consume. That is the
 * point: the previous KV guard was a `get`-then-`put` on an eventually
 * consistent store, so two requests carrying the same payment hash could both
 * pass in different colos.
 *
 * Returns `"unavailable"` when the DO cannot be reached; the caller decides how
 * to fail (it must not treat that as "fresh").
 */
export async function consumeStoreKey(options: {
  namespace?: DoNamespaceLike | null;
  namespaceName: string;
  instanceName?: string;
  key: string;
  value: string;
  ttlSeconds?: number;
}): Promise<ConsumeOutcome> {
  const send = createStoreClient(options.namespace, options.namespaceName, options.instanceName ?? "kv");
  const reply = await send({
    op: "consume",
    ns: options.namespaceName,
    key: options.key,
    value: options.value,
    ttl: options.ttlSeconds,
  });
  if (!reply || typeof reply.consumed !== "boolean") return "unavailable";
  return reply.consumed ? "consumed" : "duplicate";
}
