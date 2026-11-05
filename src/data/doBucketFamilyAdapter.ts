/**
 * Issue #2436 (#1976 step 5e) — the production (DO
 * wire-protocol) adapter for the residual bucket family. It
 * is a client of the funnel exactly as today's modules are:
 * the bucket KvLikes and the raw consume sender are built
 * by the composition root (createBucketPorts.ts) from
 * createStoreKv / createStoreSender over the SAME
 * SessionStore instance, `legacyFallback: false` — so wire
 * payloads and store_op metrics behaviour are identical to
 * the flag-off path by construction (same funnel, same
 * payload shapes).
 *
 * #CDO-mha7
 */
import {
  createBucketBackedFamily,
  type BucketFamilyBackend,
} from "./bucketFamilyKvImpl";
import type { BucketFamilyPorts, ClaimPort } from "./bucketPorts";
import type { KvLike } from "../security/kvResilience";

export class DoBucketFamilyAdapter implements BucketFamilyPorts {
  readonly legacyFallback = false as const;
  readonly claims: ClaimPort;
  private readonly family: BucketFamilyPorts;

  constructor(backend: BucketFamilyBackend) {
    this.family = createBucketBackedFamily(backend);
    this.claims = this.family.claims;
  }

  bucketKv(
    family: Parameters<BucketFamilyPorts["bucketKv"]>[0],
  ): KvLike {
    return this.family.bucketKv(family);
  }
}
