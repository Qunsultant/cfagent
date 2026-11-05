/**
 * Issue #2436 (#1976 step 5e) — the shared implementation
 * behind the residual bucket family's adapters. Both
 * adapters (DO wire-protocol and in-memory) run THIS code
 * over their backend handles, so the conformance suite
 * proves one semantics, not two copies.
 *
 * What lives here is deliberately thin — the residual
 * families' semantics live in their façade modules (the
 * step-5e Q-6 decision, recorded in bucketPorts.ts). This
 * implementation owns exactly two things:
 *
 *  1. The claim translation: the backend's raw consume
 *     reply (the DO wire reply's `consumed` flag, or null
 *     when the store could not be reached) becomes the
 *     ClaimPort's three outcomes, DISTINCT — null is
 *     "unavailable", false is "duplicate", true is
 *     "consumed". No outcome is ever substituted for
 *     another here; the sabotage pin for this slice mutates
 *     exactly this translation and the conformance suite
 *     goes red.
 *  2. The registry dispatch: bucketKv(family) resolves the
 *     family's REGISTERED bucket (bucketPorts.ts) — an
 *     unregistered family or claim bucket is refused loud
 *     (a thrown error at call time), never silently routed
 *     to a default bucket.
 *
 * #CDO-mha7
 */
import type { KvLike } from "../security/kvResilience";
import {
  CLAIM_BUCKETS,
  RESIDUAL_BUCKET_FAMILIES,
  type BucketFamilyPorts,
  type ClaimBucket,
  type ClaimOutcome,
  type ClaimPort,
  type ResidualBucketFamily,
} from "./bucketPorts";

/**
 * The backend handles the adapters supply: a per-bucket
 * KvLike factory and the raw consume operation. Raw consume
 * resolves to the store's consumed flag, or null when the
 * store could not be reached — the translation to the
 * three outcomes happens HERE, once.
 */
export interface BucketFamilyBackend {
  kvFor(bucket: string): KvLike;
  consume(
    bucket: string,
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<boolean | null>;
}

function assertClaimBucket(bucket: string): asserts bucket is ClaimBucket {
  if (!(CLAIM_BUCKETS as readonly string[]).includes(bucket)) {
    throw new Error(
      `ClaimPort: bucket "${bucket}" is not a registered claim bucket ` +
        `(${CLAIM_BUCKETS.join(", ")}); claims are a closed contract (issue #2436).`,
    );
  }
}

/** The one translation: raw reply → the three outcomes, never collapsed. */
function translateClaim(raw: boolean | null): ClaimOutcome {
  if (raw === null) return "unavailable";
  return raw ? "consumed" : "duplicate";
}

export function createBucketBackedFamily(
  backend: BucketFamilyBackend,
): BucketFamilyPorts {
  const claims: ClaimPort = {
    async consume(bucket, key, value, ttlSeconds) {
      assertClaimBucket(bucket);
      return translateClaim(
        await backend.consume(bucket, key, value, ttlSeconds),
      );
    },
    async release(bucket, key) {
      assertClaimBucket(bucket);
      await backend.kvFor(bucket).delete(key);
    },
  };

  return {
    claims,
    bucketKv(family: ResidualBucketFamily): KvLike {
      const registration = RESIDUAL_BUCKET_FAMILIES[family];
      if (!registration) {
        throw new Error(
          `ResidualBucketPort: family "${String(family)}" is not registered ` +
            `(registered: ${Object.keys(RESIDUAL_BUCKET_FAMILIES).join(", ")}); ` +
            `bucket access is a closed registry (issue #2436).`,
        );
      }
      return backend.kvFor(registration.bucket);
    },
    legacyFallback: false,
  };
}
