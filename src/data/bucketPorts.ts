/**
 * Issue #2436 (#1976 step 5e, ADR 0022 D-A.1 / D-I.5) — the
 * residual bucket family ports and the named ClaimPort: the
 * SessionStore buckets no earlier step-5 family claimed —
 * "api_keys", "service_tokens", "payments" and
 * "slack_principal_links" — plus the `consume` claim contract
 * (Q-6) wherever it is used (payments claims, Slack link
 * codes, the #1245 E*TRADE renewal single-flight lock).
 *
 * THE Q-6 SHAPE, decided from the audit evidence: step 5's
 * other families each had aggregate semantics the port had to
 * own (session lifecycle, token resolution, audit append).
 * These residual families' semantics live in their façade
 * modules and are pinned there (hash-only API-key records in
 * security/apiKeys.ts, never-throws draft-owner resolution in
 * payments/draftOwners.ts, single-use Slack link codes in
 * trading/channels/intake.ts) — at the STORE level they are
 * genuinely rule-free bucket records. The issue's Q-6
 * alternative therefore lands: ONE residual bucket port with
 * named, registered key families (RESIDUAL_BUCKET_FAMILIES —
 * a closed registry, not a free-form namespace string), plus
 * the one contract that IS a store-level rule of its own:
 *
 * THE CLAIM PORT (named, per Q-6) owns `consume`'s
 * three-outcome contract: "consumed" (this caller won the
 * claim), "duplicate" (a live claim already exists) and
 * "unavailable" (the store could not be reached). THE
 * OUTCOMES ARE NEVER COLLAPSED — above all, "unavailable"
 * must never be served as "duplicate" or as a win: the x402
 * replay guard's caller treats duplicate as "already used"
 * and unavailable as "refuse, with an isolate-local fallback
 * set" (services/agenticPayments.ts); the #1245 renewal
 * treats duplicate as "serve the tokens already read" and
 * unavailable as "fail OPEN to the pre-#1245 behaviour"
 * (security/etradeOAuth.ts); the draft-owner registry treats
 * unavailable as a loud routing failure (payments/
 * draftOwners.ts). Collapsing any pair silently rewrites one
 * of those money- or safety-adjacent decisions, so the
 * conformance suite pins the three outcomes as distinct on
 * every adapter, including the store-unreachable composition.
 * `release` is the claim's named inverse (delete the claim
 * record): the x402 path releases a claim whose downstream
 * receipt write failed, so a failed payment attempt does not
 * burn its transaction hash, and the renewal releases its
 * lock on completion.
 *
 * FLAG (Q-2(b), #1169 semantics): `BUCKET_PORTS_ENABLED` —
 * "1"/"true"/"on" (trimmed, case-insensitive) = ON; absence
 * or any other value = OFF. The var is deliberately NOT in
 * wrangler.jsonc; rollback is unsetting it. Flag-off
 * composition is today's funnel composition inside the
 * façade modules, byte-identical; flag-on composition is the
 * adapters in this family over the SAME SessionStore DO and
 * the SAME kv_store table — the flag switches the serving
 * code path only. No data migration, no dual-write, and NO
 * change to any stored key or value shape (pinned by the
 * conformance suite's cross-composition tests).
 *
 * FLAG END-STATE (decided in this slice, per the issue's
 * requirement — recorded here and on the PR): the per-family
 * step-5 flags (SESSION_PORTS_ENABLED, TOKEN_PORTS_ENABLED,
 * AUDIT_PORTS_ENABLED and this family's BUCKET_PORTS_ENABLED)
 * are RETAINED as permanent rollback levers. None of them
 * has ever been ON in production, so no soak period exists;
 * removing them now would delete the only rollback for code
 * paths never yet exercised live. A flag-on soak and any
 * later removal are separate future proposals.
 *
 * ADAPTER CONFIGURATION (declared, not incidental): the
 * production adapter declares `legacyFallback: false` for
 * every bucket — KV is not part of these stores at all (the
 * #604 migration window closed).
 *
 * THE FUNNEL'S HOME: since this slice, the client funnel
 * itself (src/data/durableKv.ts) lives inside the data
 * layer; this family's composition root builds the bucket
 * KvLikes and the claim sender from it there, over the same
 * SessionStore instance the flag-off factories use.
 *
 * A FIFTH FAMILY, recorded honestly: the issue named four
 * residual families from the step-5 audit's base. A fifth —
 * "service_tokens" (security/serviceTokens.ts, issue #2681)
 * — landed on main after the audit and composes the funnel
 * identically (it is a clone of the apiKeys template). It is
 * registered here so the step-5 census end-state is exact:
 * no silent remainder.
 *
 * #CDO-mha7
 */
import type { KvLike } from "../security/kvResilience";

export type { KvLike };

/** Q-2(b) flag name for this family. */
export const BUCKET_PORTS_FLAG = "BUCKET_PORTS_ENABLED";

/**
 * #1169 flag semantics: "1"/"true"/"on" (trimmed,
 * case-insensitive) = ON; absence = OFF; NOT in wrangler.
 */
export function isBucketPortsEnabled(
  env?: { BUCKET_PORTS_ENABLED?: string } | null,
): boolean {
  const v = env?.BUCKET_PORTS_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/**
 * The claim contract's three outcomes — never collapsed
 * (see the header). Identical in shape to the funnel's own
 * ConsumeOutcome (src/data/durableKv.ts); the port owns the
 * contract, the funnel is its wire mechanism.
 */
export type ClaimOutcome = "consumed" | "duplicate" | "unavailable";

/**
 * The buckets a claim may live in — a closed set. A claim in
 * any other bucket is a programming error, refused loud by
 * the implementation, never silently routed.
 */
export type ClaimBucket = "payments" | "slack_principal_links" | "etrade";

export const CLAIM_BUCKETS: readonly ClaimBucket[] = [
  "payments",
  "slack_principal_links",
  "etrade",
];

/**
 * The named ClaimPort (Q-6): the atomic `consume` claim and
 * its release, over the SessionStore DO's serialized consume
 * op — one DO request performs the check and the set, so two
 * concurrent claimants cannot both win.
 */
export interface ClaimPort {
  /**
   * Atomically claim `key` in `bucket` for `value`, with an
   * optional TTL (seconds). Returns exactly one of the three
   * outcomes; "unavailable" means the store could not be
   * reached and NO claim state is known — callers must not
   * treat it as "duplicate" or as a win.
   */
  consume(
    bucket: ClaimBucket,
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<ClaimOutcome>;
  /**
   * Release a claim (delete its record). The x402 path
   * releases when the downstream receipt write fails; the
   * renewal releases its lock when done. Releasing a key
   * that was never claimed is a no-op.
   */
  release(bucket: ClaimBucket, key: string): Promise<void>;
}

/**
 * The registered residual key families — the closed set the
 * bucket port serves. Each entry names the façade module
 * that owns the family's semantics and the bucket its
 * records live in.
 */
export type ResidualBucketFamily =
  | "apiKeys"
  | "serviceTokens"
  | "payments"
  | "slackLinks";

export const RESIDUAL_BUCKET_FAMILIES: Record<
  ResidualBucketFamily,
  { bucket: string; owner: string; keyFamilies: string }
> = {
  apiKeys: {
    bucket: "api_keys",
    owner: "src/security/apiKeys.ts",
    keyFamilies: "key:<keyId> · hash:<sha256> · user:<login>",
  },
  serviceTokens: {
    bucket: "service_tokens",
    owner: "src/security/serviceTokens.ts",
    keyFamilies: "token:<tokenId> · hash:<sha256> · subject:<id> · index:all",
  },
  payments: {
    bucket: "payments",
    owner: "src/services/agenticPayments.ts · src/payments/draftOwners.ts",
    keyFamilies: "x402tx:<txhash> · draftowner:<draftId>",
  },
  slackLinks: {
    bucket: "slack_principal_links",
    owner: "src/trading/channels/intake.ts",
    keyFamilies: "link:<teamId>:<userId> · code:<code> · code-claim:<code>",
  },
};

/**
 * The residual bucket port: per-family bucket access for the
 * registered families above. The families' semantics stay in
 * their façade modules (pinned by dual-run characterization
 * in both flag states); this port is the store-level
 * contract they compose when the flag is on.
 */
export interface ResidualBucketPort {
  /** The bucket KvLike for one registered family. */
  bucketKv(family: ResidualBucketFamily): KvLike;
}

/**
 * The family aggregate returned by the composition root
 * (createBucketPorts.ts).
 */
export interface BucketFamilyPorts {
  claims: ClaimPort;
  bucketKv(family: ResidualBucketFamily): KvLike;
  /** Declared adapter configuration: KV is never a fallback. */
  readonly legacyFallback: false;
}
