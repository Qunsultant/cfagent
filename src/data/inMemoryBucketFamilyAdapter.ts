/**
 * Issue #2436 (#1976 step 5e) — the in-memory adapter for
 * the residual bucket family (conformance / test doubles).
 *
 * Buckets are separate maps, as the DO's namespaces are
 * separate key spaces. Rows honour TTLs the way the DO does
 * at the contract level: an expired row reads as absent and
 * is deleted by that read (the §3.1 lazy-expiry shape), and
 * a TTL-less claim never expires (the draft-owner registry's
 * first-owner-stands rule depends on it).
 *
 * The `available: false` mode models the store-unreachable
 * composition: bucket reads are null, writes are dropped,
 * genesis claims fail closed (false), and consume resolves
 * to the raw null the shared implementation translates to
 * "unavailable" — the outcome the x402 and draft-owner
 * callers must never see collapsed into "duplicate".
 *
 * `seedRaw` / `rawValue` / `deleteRaw` are test seams for
 * seeding/inspecting stored bytes — they are on the class,
 * not on the port contract.
 *
 * #CDO-mha7
 */
import type { KvLike } from "../security/kvResilience";
import {
  createBucketBackedFamily,
  type BucketFamilyBackend,
} from "./bucketFamilyKvImpl";
import type { BucketFamilyPorts, ClaimPort } from "./bucketPorts";

interface Row {
  value: string;
  expiresAtMs: number | null;
}

export interface InMemoryBucketFamilyOptions {
  /** Default true. False models the store-unreachable composition. */
  available?: boolean;
}

export class InMemoryBucketFamilyAdapter implements BucketFamilyPorts {
  readonly legacyFallback = false as const;
  readonly claims: ClaimPort;
  private readonly family: BucketFamilyPorts;
  private readonly buckets = new Map<string, Map<string, Row>>();
  private readonly available: boolean;

  constructor(options: InMemoryBucketFamilyOptions = {}) {
    this.available = options.available ?? true;
    const backend: BucketFamilyBackend = {
      kvFor: (bucket) => this.kvFor(bucket),
      consume: async (bucket, key, value, ttlSeconds) => {
        if (!this.available) return null;
        const rows = this.rowsFor(bucket);
        const existing = rows.get(key);
        if (
          existing &&
          (existing.expiresAtMs === null || existing.expiresAtMs > Date.now())
        ) {
          return false;
        }
        rows.set(key, {
          value,
          expiresAtMs:
            typeof ttlSeconds === "number"
              ? Date.now() + ttlSeconds * 1000
              : null,
        });
        return true;
      },
    };
    this.family = createBucketBackedFamily(backend);
    this.claims = this.family.claims;
  }

  bucketKv(
    family: Parameters<BucketFamilyPorts["bucketKv"]>[0],
  ): KvLike {
    return this.family.bucketKv(family);
  }

  private rowsFor(bucket: string): Map<string, Row> {
    let rows = this.buckets.get(bucket);
    if (!rows) {
      rows = new Map<string, Row>();
      this.buckets.set(bucket, rows);
    }
    return rows;
  }

  private liveRow(bucket: string, key: string): Row | undefined {
    const rows = this.rowsFor(bucket);
    const row = rows.get(key);
    if (!row) return undefined;
    if (row.expiresAtMs !== null && row.expiresAtMs <= Date.now()) {
      rows.delete(key);
      return undefined;
    }
    return row;
  }

  private kvFor(bucket: string): KvLike {
    return {
      get: async (key) => {
        if (!this.available) return null;
        return this.liveRow(bucket, key)?.value ?? null;
      },
      put: async (key, value, options) => {
        if (!this.available) return;
        this.rowsFor(bucket).set(key, {
          value,
          expiresAtMs:
            typeof options?.expirationTtl === "number"
              ? Date.now() + options.expirationTtl * 1000
              : null,
        });
      },
      delete: async (key) => {
        if (!this.available) return;
        this.rowsFor(bucket).delete(key);
      },
      putIfAbsent: async (key, value) => {
        if (!this.available) return false;
        if (this.liveRow(bucket, key)) return false;
        this.rowsFor(bucket).set(key, { value, expiresAtMs: null });
        return true;
      },
    };
  }

  /* ------------------------- test seams ------------------------- */

  seedRaw(bucket: string, key: string, value: string): void {
    this.rowsFor(bucket).set(key, { value, expiresAtMs: null });
  }

  rawValue(bucket: string, key: string): string | null {
    return this.liveRow(bucket, key)?.value ?? null;
  }

  deleteRaw(bucket: string, key: string): void {
    this.rowsFor(bucket).delete(key);
  }
}
