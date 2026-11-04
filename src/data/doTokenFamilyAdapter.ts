/**
 * Issue #2434 (#1976 step 5c) — the production (DO
 * wire-protocol) adapter for the token family. It is a
 * client of the existing funnel exactly as today's modules
 * are: the bucket KvLikes, the etrade lister, and the
 * per-call bucket factory are built by the composition root
 * (createTokenPorts.ts) from createStoreKv / listStoreEntries
 * over the SAME SessionStore instance, buckets "etrade" and
 * "public", `legacyFallback: false` — so wire payloads and
 * store_op metrics behaviour are byte-identical to the
 * flag-off path by construction (same funnel, same payload
 * shapes).
 *
 * #CDO-mha7
 */
import type { TokenFamilyPorts } from "./tokenPorts";
import {
  createKvBackedTokenFamily,
  type TokenFamilyBackend,
} from "./tokenFamilyKvImpl";
import type { EtradeTokenPort, PublicTokenPort } from "./tokenPorts";

export class DoTokenFamilyAdapter implements TokenFamilyPorts {
  readonly legacyFallback = false as const;
  readonly etrade: EtradeTokenPort;
  readonly public: PublicTokenPort;

  constructor(backend: TokenFamilyBackend) {
    const family = createKvBackedTokenFamily(backend);
    this.etrade = family.etrade;
    this.public = family.public;
  }
}
