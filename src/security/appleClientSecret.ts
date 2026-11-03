/**
 * #2686 — Sign in with Apple's client-secret JWT (ES256).
 *
 * Apple does not accept a static client secret: the token endpoint
 * requires a JWT signed ES256 with the developer account's .p8 key,
 * with iss = Team ID, sub = Service ID (client_id), aud =
 * https://appleid.apple.com, and an expiry at most 6 months out.
 * This module mints that JWT on demand, at exchange time, from the
 * owner-set env (APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY,
 * APPLE_CLIENT_ID — Cloudflare dashboard or `wrangler secret put`,
 * never committed).
 *
 * Why mint on demand instead of storing a minted secret: a stored
 * secret silently expires (the exact failure this issue forbids).
 * A per-exchange mint with a short lifetime (default 1 day, far
 * below Apple's 6-month maximum) has no stored secret to expire:
 * rotation means replacing the .p8 private key (Apple Developer →
 * update APPLE_PRIVATE_KEY → deploy), never rotating a live
 * secret under traffic, and a bad key fails the exchange closed
 * instead of serving a stale secret. The .p8 key itself does not
 * expire; only minted JWTs do.
 *
 * The expiry detector below covers the other direction: an
 * operator who pre-mints a secret (e.g. for a non-Worker caller)
 * can check it before use. It decodes the payload only — it never
 * verifies a signature, because expiry detection is about the
 * operator's own secret, not about trusting a third party.
 *
 * No secret, key, or token is ever logged here.
 */

export const APPLE_AUDIENCE = "https://appleid.apple.com";
export const APPLE_CLIENT_SECRET_MAX_TTL_SECONDS = 6 * 30 * 24 * 60 * 60;
export const APPLE_CLIENT_SECRET_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const APPLE_CLIENT_SECRET_EXPIRING_SOON_DAYS = 30;

export interface MintAppleClientSecretInput {
  teamId: string;
  keyId: string;
  /** PEM-encoded PKCS#8 .p8 private key (owner-set secret). */
  privateKeyPem: string;
  /** Service ID — the OAuth client_id. */
  clientId: string;
  nowMs: number;
  /** Seconds until expiry. Default 1 day; clamped to Apple's 6-month maximum. */
  ttlSeconds?: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Copy a Uint8Array view into a fresh ArrayBuffer (the ECDSA subtle overloads demand one). */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (body === "") throw new Error("Apple private key PEM is empty");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

/**
 * Mint an Apple client-secret JWT. Throws on a missing input or an
 * unimportable key — callers treat a throw as "not configured" and
 * fail the login closed (see the resolver in providers.ts).
 */
export async function mintAppleClientSecret(input: MintAppleClientSecretInput): Promise<string> {
  const { teamId, keyId, privateKeyPem, clientId, nowMs } = input;
  if (!teamId || !keyId || !privateKeyPem || !clientId) {
    throw new Error("Apple client-secret inputs are incomplete");
  }
  const ttl = Math.min(
    Math.max(Math.floor(input.ttlSeconds ?? APPLE_CLIENT_SECRET_DEFAULT_TTL_SECONDS), 1),
    APPLE_CLIENT_SECRET_MAX_TTL_SECONDS
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pemToDer(privateKeyPem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })));
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: teamId,
        iat,
        exp: iat + ttl,
        aud: APPLE_AUDIENCE,
        sub: clientId,
      })
    )
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(new TextEncoder().encode(`${header}.${payload}`))
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export type AppleClientSecretExpiryStatus = "ok" | "expiring-soon" | "expired" | "invalid";

export interface AppleClientSecretExpiry {
  status: AppleClientSecretExpiryStatus;
  expiresAtMs?: number;
  daysRemaining?: number;
}

/** Decode a JWT payload without verifying (expiry detection only, see header). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(padded)) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Classify a (possibly operator-minted) Apple client-secret JWT by
 * expiry: "expiring-soon" under 30 days, "expired" at or past exp,
 * "invalid" when the token has no parseable numeric exp.
 */
export function getAppleClientSecretExpiry(jwt: string, nowMs: number): AppleClientSecretExpiry {
  const payload = decodeJwtPayload(jwt);
  const exp = payload?.["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return { status: "invalid" };
  }
  const expiresAtMs = exp * 1000;
  const daysRemaining = (expiresAtMs - nowMs) / (24 * 60 * 60 * 1000);
  if (daysRemaining <= 0) return { status: "expired", expiresAtMs, daysRemaining };
  if (daysRemaining < APPLE_CLIENT_SECRET_EXPIRING_SOON_DAYS) {
    return { status: "expiring-soon", expiresAtMs, daysRemaining };
  }
  return { status: "ok", expiresAtMs, daysRemaining };
}
