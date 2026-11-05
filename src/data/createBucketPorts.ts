/**
 * Issue #2436 (#1976 step 5e) — composition root for the
 * residual bucket family + ClaimPort. This is the ONLY
 * module that maps a host's storage handles to the family's
 * production implementation: consumers import this helper
 * and the port types, never a funnel client for these
 * buckets.
 *
 * The root is the family's funnel composition site: it
 * builds the per-bucket KvLikes and the raw consume sender
 * via createStoreKv / createStoreSender, all over the SAME
 * SessionStore instance the flag-off factories use, with
 * `legacyFallback: false` declared. Flag selection lives in
 * the façades (apiKeys' apiKeyStore, serviceTokens'
 * serviceTokenStore, draftOwners' register/resolve,
 * agenticPayments' claim/release, intake's link store
 * factory, etradeOAuth's renewal claim), which call this
 * root only when BUCKET_PORTS_ENABLED is on
 * (isBucketPortsEnabled in bucketPorts.ts, #1169 semantics).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from bucketPorts.ts (type-only), never this root.
 *
 * #CDO-mha7
 */
import {
  createStoreKv,
  createStoreSender,
  type DoNamespaceLike,
} from "./durableKv";
import type { KvLike } from "../security/kvResilience";
import type { Env } from "../types";
import type { BucketFamilyBackend } from "./bucketFamilyKvImpl";
import { DoBucketFamilyAdapter } from "./doBucketFamilyAdapter";
import {
  InMemoryBucketFamilyAdapter,
  type InMemoryBucketFamilyOptions,
} from "./inMemoryBucketFamilyAdapter";
import type { BucketFamilyPorts } from "./bucketPorts";

export type { BucketFamilyPorts };
export { isBucketPortsEnabled } from "./bucketPorts";

function doFamily(
  namespace: DoNamespaceLike | null | undefined,
): BucketFamilyPorts {
  const kvCache = new Map<string, KvLike>();
  const backend: BucketFamilyBackend = {
    kvFor: (bucket) => {
      let kv = kvCache.get(bucket);
      if (!kv) {
        kv = createStoreKv({
          namespace,
          namespaceName: bucket,
          legacyFallback: false,
        });
        kvCache.set(bucket, kv);
      }
      return kv;
    },
    consume: async (bucket, key, value, ttlSeconds) => {
      const send = createStoreSender(namespace, bucket, "kv");
      const reply = await send({
        op: "consume",
        ns: bucket,
        key,
        value,
        ttl: ttlSeconds,
      });
      return reply && typeof reply.consumed === "boolean"
        ? reply.consumed
        : null;
    },
  };
  return new DoBucketFamilyAdapter(backend);
}

/** Compose the family over an env's SessionStore binding. */
export function createBucketPorts(env: Env): BucketFamilyPorts {
  const namespace = env.SESSION_STORE as unknown as
    | DoNamespaceLike
    | undefined;
  return doFamily(namespace);
}

/** Compose the family over a DO namespace directly (test seams / fakes). */
export function createBucketPortsFromNamespace(
  namespace: DoNamespaceLike | null | undefined,
): BucketFamilyPorts {
  return doFamily(namespace);
}

/** Compose the in-memory family (conformance / test doubles). */
export function createInMemoryBucketPorts(
  options: InMemoryBucketFamilyOptions = {},
): BucketFamilyPorts {
  return new InMemoryBucketFamilyAdapter(options);
}
