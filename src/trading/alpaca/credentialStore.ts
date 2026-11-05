/**
 * Issue #3351 — Alpaca sign-in: the per-user credential record.
 *
 * Why this module exists: Alpaca authenticates with an API key pair, and until
 * this slice the pair was a *deployment* fact only (`ALPACA_PAPER_*` /
 * `ALPACA_LIVE_*`, mapped onto the generic names by `withAlpacaCredentials`).
 * So "Connect Alpaca" verified the operator's secrets and then reported the
 * result to whichever user happened to click, and `configured: true` on the
 * status read answered a deployment question while the panel asked a user one.
 * E*TRADE never had that gap: its OAuth tokens are per user, in the session
 * store, with renewal and revocation.
 *
 * What this module is NOT: a second credential system. The record lives in the
 * SAME SessionStore Durable Object that already holds E*TRADE access tokens
 * (`createStoreKv`, ADR 0022 — no store bypass), under its own namespace, with
 * the same protection. No new deployment secret is introduced, no D1 table is
 * added, and a deployment that sets nothing keeps working exactly as before.
 *
 * VERIFY-BEFORE-STORE is a named precondition, inherited from
 * `security/publicOAuth.ts`: `storeAlpacaCredentials` is called ONLY after the
 * caller has verified the pair against Alpaca's own `/v2/account` for the same
 * trading type. A pair that cannot read its own account is never stored — a
 * stored credential is a claim that it works.
 *
 * SECRETS NEVER LEAVE THE SERVER: `describeAlpacaCredential` is the only shape
 * any route or client may see — presence, trading type, key id's last four, and
 * when it was stored. There is deliberately no accessor that returns the secret
 * for display, logging, or an API payload.
 */
import type { Env } from "../../types";
import { createStoreKv, type DoNamespaceLike } from "../../data/durableKv";

/** What the user is doing, not what the deployment is set to (#3232). */
export type AlpacaCredentialSide = "paper" | "live";

/** The stored record. The secret is here because the adapter must use it. */
export interface AlpacaCredentialRecord {
  readonly userLogin: string;
  readonly side: AlpacaCredentialSide;
  readonly keyId: string;
  readonly secretKey: string;
  /** ISO timestamp of the verified sign-in that wrote this record. */
  readonly storedAt: string;
}

/** The only projection a route or a client may render. Never carries the secret. */
export interface AlpacaCredentialDescription {
  readonly side: AlpacaCredentialSide;
  readonly keyIdLast4: string;
  readonly storedAt: string;
}

/**
 * The SessionStore namespace for this record. Separate from `etrade` (OAuth
 * tokens) and `public` (MCP tokens) so a purge of one family can never touch
 * another, and so the key formula below cannot collide with either.
 */
export const ALPACA_CREDENTIAL_NAMESPACE = "alpaca";

/** Stored-key formula — CONTRACT: `alpaca:cred:<SIDE>:<login>`. */
export const ALPACA_CREDENTIAL_KEY_PREFIX = "alpaca:cred:";

/**
 * One key per (user, trading type). The trading type is part of the key on
 * purpose: a paper key and a live key are different credentials for different
 * hosts, and a single record would let one quietly answer for the other.
 */
export function alpacaCredentialKey(userLogin: string, side: AlpacaCredentialSide): string {
  return `${ALPACA_CREDENTIAL_KEY_PREFIX}${side.toUpperCase()}:${userLogin.toLowerCase()}`;
}

/** The two sides in the order the revoke path deletes them. */
export const ALPACA_CREDENTIAL_SIDES: readonly AlpacaCredentialSide[] = ["paper", "live"];

function isSide(value: unknown): value is AlpacaCredentialSide {
  return value === "paper" || value === "live";
}

/**
 * Parse-or-null. A record that is not shaped like a credential (a truncated
 * write, a value written by something else) reads as absent — it is never
 * coerced into a half-credential the adapter would then send upstream.
 */
export function parseAlpacaCredential(raw: string | null): AlpacaCredentialRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const keyId = typeof record.keyId === "string" ? record.keyId.trim() : "";
  const secretKey = typeof record.secretKey === "string" ? record.secretKey.trim() : "";
  const userLogin = typeof record.userLogin === "string" ? record.userLogin.trim() : "";
  const storedAt = typeof record.storedAt === "string" ? record.storedAt.trim() : "";
  if (!keyId || !secretKey || !userLogin || !storedAt) return null;
  if (!isSide(record.side)) return null;
  return { userLogin, side: record.side, keyId, secretKey, storedAt };
}

/** The redacted projection. Last four only; a three-character key id shows in full. */
export function describeAlpacaCredential(
  record: AlpacaCredentialRecord | null,
): AlpacaCredentialDescription | null {
  if (!record) return null;
  return {
    side: record.side,
    keyIdLast4: record.keyId.slice(-4),
    storedAt: record.storedAt,
  };
}

/** The SessionStore bucket for this family. `legacyFallback: false`: no KV. */
function bucket(env: Env) {
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: ALPACA_CREDENTIAL_NAMESPACE,
    legacyFallback: false,
  });
}

/**
 * A `put` through an unbound namespace is a silent no-op (`createStoreKv`
 * returns without a store and without an error), so storing through it would
 * report a sign-in that does not exist. Storage must therefore be present, and
 * its absence is a failure the caller surfaces — never a pretend success.
 */
function requireStore(env: Env) {
  if (!env.SESSION_STORE) {
    throw new Error(
      "Alpaca credential storage is unavailable: the SESSION_STORE binding is not configured.",
    );
  }
  return bucket(env);
}

/**
 * Store a VERIFIED pair (see the module header's precondition).
 *
 * The write is a single `put` of one record: there is no half-state to leave
 * behind, and no second key to keep in step.
 */
export async function storeAlpacaCredentials(
  env: Env,
  input: {
    userLogin: string;
    side: AlpacaCredentialSide;
    keyId: string;
    secretKey: string;
    storedAt?: string;
  },
): Promise<AlpacaCredentialRecord> {
  const record: AlpacaCredentialRecord = {
    userLogin: input.userLogin,
    side: input.side,
    keyId: input.keyId,
    secretKey: input.secretKey,
    storedAt: input.storedAt ?? new Date().toISOString(),
  };
  await requireStore(env).put(alpacaCredentialKey(input.userLogin, input.side), JSON.stringify(record));
  return record;
}

/** Read the pair for one user and trading type; null when nothing is stored. */
export async function getAlpacaCredentials(
  env: Env,
  userLogin: string,
  side: AlpacaCredentialSide,
): Promise<AlpacaCredentialRecord | null> {
  if (!userLogin) return null;
  return parseAlpacaCredential(await bucket(env).get(alpacaCredentialKey(userLogin, side)));
}

/**
 * Delete both trading types for one user. Idempotent by construction: deleting
 * an absent key is a no-op, so a double sign-out is not an error.
 *
 * Both sides are deleted on purpose — a user who signs out of paper while their
 * live pair is still stored has not signed out; the next live order would use a
 * credential they believe they removed.
 */
export async function revokeAlpacaCredentials(env: Env, userLogin: string): Promise<void> {
  if (!userLogin) return;
  const store = bucket(env);
  await Promise.all(
    ALPACA_CREDENTIAL_SIDES.map((side) => store.delete(alpacaCredentialKey(userLogin, side))),
  );
}
