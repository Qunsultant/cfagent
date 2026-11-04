/**
 * Issue #2434 (#1976 step 5c) — the in-memory adapter for
 * the token family (conformance / test doubles). Its
 * KvLikes honour TTLs the way the DO does at the contract
 * level: an expired row reads as absent and is deleted by
 * that read (the §3.1 lazy-expiry shape, at this backend's
 * level). Buckets are separate maps, as the DO's namespaces
 * are separate key spaces; the credential-reference seam's
 * arbitrary namespaces get a map on first use. All family
 * semantics run through the shared Kv-backed implementation,
 * so this adapter and the DO adapter differ ONLY in the
 * backend handles.
 *
 * The default host resolves environments as
 * `(override ?? "TEST").toUpperCase()` and knows no aliases;
 * `setAlias` is the test seam for the alias leg of the
 * resolution contract. `seedRaw` / `rawValue` / `deleteRaw`
 * are test seams for seeding/inspecting stored bytes (e.g.
 * corrupt candidates) — they are on the class, not on the
 * port contract.
 *
 * #CDO-mha7
 */
import type { KvLike } from "../security/kvResilience";
import {
  createKvBackedTokenFamily,
  type TokenFamilyBackend,
} from "./tokenFamilyKvImpl";
import type {
  EtradeTokenPort,
  PublicTokenPort,
  TokenFamilyHost,
  TokenFamilyPorts,
} from "./tokenPorts";

interface Row {
  value: string;
  expiresAtMs: number | null;
}

export class InMemoryTokenFamilyAdapter implements TokenFamilyPorts {
  readonly legacyFallback = false as const;
  readonly etrade: EtradeTokenPort;
  readonly public: PublicTokenPort;
  private readonly buckets = new Map<string, Map<string, Row>>();
  private readonly aliases = new Map<string, string>();

  constructor() {
    const bucketKv = (ns: string): KvLike => this.kvFor(ns);
    const backend: TokenFamilyBackend = {
      etradeKv: bucketKv("etrade"),
      publicKv: bucketKv("public"),
      listEtrade: async (prefix) => {
        const rows = this.buckets.get("etrade");
        if (!rows) return [];
        const out: Array<{ key: string; value: string }> = [];
        for (const [key, row] of rows) {
          if (row.expiresAtMs !== null && row.expiresAtMs <= Date.now()) continue;
          if (key.startsWith(prefix)) out.push({ key, value: row.value });
        }
        out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return out;
      },
      bucketKv,
      host: {
        envName: (overrideEnv) =>
          overrideEnv ? overrideEnv.toUpperCase() : "TEST",
        aliasLogin: async (internalUserId) =>
          this.aliases.get(internalUserId) ?? null,
      } satisfies TokenFamilyHost,
    };
    const family = createKvBackedTokenFamily(backend);
    this.etrade = family.etrade;
    this.public = family.public;
  }

  private kvFor(ns: string): KvLike {
    let rows = this.buckets.get(ns);
    if (!rows) {
      rows = new Map<string, Row>();
      this.buckets.set(ns, rows);
    }
    const map = rows;
    return {
      async get(key) {
        const row = map.get(key);
        if (!row) return null;
        if (row.expiresAtMs !== null && row.expiresAtMs <= Date.now()) {
          map.delete(key);
          return null;
        }
        return row.value;
      },
      async put(key, value, options) {
        map.set(key, {
          value,
          expiresAtMs:
            typeof options?.expirationTtl === "number"
              ? Date.now() + options.expirationTtl * 1000
              : null,
        });
      },
      async putIfAbsent(key, value) {
        const existing = map.get(key);
        if (
          existing &&
          (existing.expiresAtMs === null || existing.expiresAtMs > Date.now())
        ) {
          return false;
        }
        map.set(key, { value, expiresAtMs: null });
        return true;
      },
      async delete(key) {
        map.delete(key);
      },
    };
  }

  /** Test seam: register an alias login for an internal user id. */
  setAlias(internalUserId: string, aliasLogin: string): void {
    this.aliases.set(internalUserId, aliasLogin);
  }

  /** Test seam: write raw stored bytes (no TTL), any bucket. */
  seedRaw(bucket: string, key: string, value: string): void {
    let rows = this.buckets.get(bucket);
    if (!rows) {
      rows = new Map<string, Row>();
      this.buckets.set(bucket, rows);
    }
    rows.set(key, { value, expiresAtMs: null });
  }

  /** Test seam: read raw stored bytes, or null when absent/expired. */
  rawValue(bucket: string, key: string): string | null {
    const row = this.buckets.get(bucket)?.get(key);
    if (!row) return null;
    if (row.expiresAtMs !== null && row.expiresAtMs <= Date.now()) return null;
    return row.value;
  }

  /** Test seam: delete raw stored bytes, any bucket. */
  deleteRaw(bucket: string, key: string): void {
    this.buckets.get(bucket)?.delete(key);
  }
}
