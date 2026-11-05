/**
 * Issue #3351 — Alpaca sign-in: which pair the adapter actually uses.
 *
 * Alpaca's key pair exists twice over after this slice: the deployment's
 * (`ALPACA_PAPER_*` / `ALPACA_LIVE_*`, mapped by `withAlpacaCredentials`) and a
 * user's own verified pair (`credentialStore`). Two sources, one adapter — so
 * the precedence has to be written down once, in one place, and be the same
 * answer for a quote, a chain, an order, and the status read. That is this
 * module. It is deliberately separate from `credentials.ts` (the deployment
 * mapping, #3292/#3330) and from `credentialStore.ts` (the store, #3351), so
 * neither has to know about the other.
 *
 * The rule:
 *   user pair for the selected trading type  >  deployment pair for that type  >  none
 *
 * `none` is a state, not an error, and it is never paper. A missing credential
 * must not silently become the paper host: a live selection with no live pair
 * has to say so.
 *
 * The result carries its provenance (`source`), because every honest surface in
 * this platform needs it: a status read that says `configured: true` without
 * saying whether *this user* signed in is the defect #3351 exists to end.
 */
import type { Env } from "../../types";
import type { AlpacaSide } from "./credentials";
import {
  getAlpacaCredentials,
  type AlpacaCredentialRecord,
  type AlpacaCredentialSide,
} from "./credentialStore";

/**
 * Where the pair came from. `none` means nothing is available for this trading
 * type — the caller must refuse or state the gap; it must never fall back.
 */
export type AlpacaCredentialSource = "user" | "deployment" | "none";

/** The resolved pair plus its provenance. Never rendered as-is. */
export interface AlpacaResolvedPair {
  readonly source: AlpacaCredentialSource;
  readonly keyId: string | null;
  readonly secretKey: string | null;
  readonly keyIdLast4: string | null;
}

/** The pair the deployment declares for this trading type (may be absent). */
function deploymentPair(
  env: Env,
  side: AlpacaSide,
): { keyId: string | null; secretKey: string | null } {
  const isLive = side === "live";
  const key =
    (isLive ? env.ALPACA_LIVE_API_KEY : env.ALPACA_PAPER_API_KEY) ||
    env.ALPACA_API_KEY ||
    env.ALPACA_API_KEY_ID;
  const secret =
    (isLive ? env.ALPACA_LIVE_SECRET_KEY : env.ALPACA_PAPER_SECRET_KEY) ||
    env.ALPACA_SECRET_KEY ||
    env.ALPACA_API_SECRET_KEY;
  return { keyId: key || null, secretKey: secret || null };
}

/**
 * Resolve the pair for one login and one trading type.
 *
 * A stored record is read for the side the caller asked for: the side is part
 * of the stored key, so a paper sign-in can never answer a live read.
 * A partial pair resolves to `none` — half a credential sent upstream turns a
 * configuration gap into an authentication mystery.
 */
export async function resolveAlpacaPair(
  env: Env,
  userLogin: string,
  side: AlpacaSide,
): Promise<AlpacaResolvedPair> {
  const stored: AlpacaCredentialRecord | null = userLogin
    ? await getAlpacaCredentials(env, userLogin, side as AlpacaCredentialSide)
    : null;
  if (stored) {
    return {
      source: "user",
      keyId: stored.keyId,
      secretKey: stored.secretKey,
      keyIdLast4: stored.keyId.slice(-4),
    };
  }

  const deployed = deploymentPair(env, side);
  if (!deployed.keyId || !deployed.secretKey) {
    return { source: "none", keyId: null, secretKey: null, keyIdLast4: null };
  }
  return {
    source: "deployment",
    keyId: deployed.keyId,
    secretKey: deployed.secretKey,
    keyIdLast4: deployed.keyId.slice(-4),
  };
}

/**
 * Overlay a resolved pair onto the generic names the adapter reads, keeping
 * every other environment value (base URL, data URL, feed) untouched. The input
 * env is never mutated, and an absent pair leaves the env exactly as given.
 */
export function applyAlpacaPair(env: Env, pair: AlpacaResolvedPair): Env {
  if (!pair.keyId || !pair.secretKey) return env;
  return { ...env, ALPACA_API_KEY: pair.keyId, ALPACA_SECRET_KEY: pair.secretKey } as Env;
}
