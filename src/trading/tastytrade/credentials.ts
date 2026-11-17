/**
 * Tastytrade OAuth2 Credential & Session Seam (issue #4675, Gap 21).
 *
 * Ports the OAuth2 personal refresh-token grant pattern from
 * amuse `src/tastytrade_backtest.py`:
 *   - POST /oauth/token with `grant_type=refresh_token`, `refresh_token`,
 *     and `client_secret` (form-urlencoded).
 *   - Mandatory `User-Agent` header on every request.
 *   - Proactive token refresh (`TASTYTRADE_CONFIG.refreshMarginSecs` = 60s
 *     before expiry) — never a 401 retry on POST, so an order is never
 *     replayed.
 *   - Adopts a server-rotated `refresh_token` when returned.
 *   - Secrets never appear in errors, logs, or client projections.
 *   - Per-user credentials live in the SessionStore DO under namespace
 *     `tastytrade` (`verify-before-store` via `GET /customers/me/accounts`).
 */
import type { Env } from "../../types";
import { TASTYTRADE_CONFIG } from "../../config/tastytrade";
import { createStoreKv, type DoNamespaceLike } from "../../data/durableKv";

export type TastytradeSide = "paper" | "live";

export interface TastytradeCredentialPair {
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly baseUrl: string;
  readonly side: TastytradeSide;
  readonly source: "stored" | "env";
}

export interface TastytradeCredentialRecord {
  readonly userLogin: string;
  readonly side: TastytradeSide;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly refreshTokenLast4: string;
  readonly storedAt: string;
}

export interface TastytradeCredentialDescription {
  readonly side: TastytradeSide;
  readonly refreshTokenLast4: string;
  readonly storedAt: string;
}

export type TastytradeVerifyOutcome =
  | { readonly ok: true; readonly accountNumber: string }
  | { readonly ok: false; readonly reason: "rejected" | "unavailable"; readonly httpStatus?: number };

export const TASTYTRADE_CREDENTIAL_NAMESPACE = "tastytrade";
export const TASTYTRADE_CREDENTIAL_KEY_PREFIX = "tastytrade:cred:";
export const TASTYTRADE_CREDENTIAL_SIDES: readonly TastytradeSide[] = ["paper", "live"];

const REJECTED_STATUSES = new Set([401, 403]);

export function tastytradeCredentialKey(userLogin: string, side: TastytradeSide): string {
  return `${TASTYTRADE_CREDENTIAL_KEY_PREFIX}${side.toUpperCase()}:${userLogin.toLowerCase()}`;
}

export function normalizeTastytradeBaseUrl(raw: unknown, fallback: string): string {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value || !/^https:\/\/[^/]+$/i.test(value)) return fallback;
  return value;
}

export function tastytradeTradingSide(env: Env, overrideEnv?: string): TastytradeSide {
  const pin = String(env.TASTYTRADE_TRADING_TYPE ?? "").trim().toLowerCase();
  if (pin === "paper" || pin === "live") return pin;

  const selection = String(overrideEnv ?? "").trim().toUpperCase();
  if (selection === "TEST") return "paper";
  if (selection === "PROD") return "live";

  const base = String(env.TASTYTRADE_BASE_URL ?? "");
  return base && !base.includes("cert.tastyworks.com") ? "live" : "paper";
}

export function resolveTastytradeBaseUrl(env: Env, overrideEnv?: string): string {
  const side = tastytradeTradingSide(env, overrideEnv);
  const explicit = env.TASTYTRADE_BASE_URL;
  if (typeof explicit === "string" && explicit.trim()) {
    return normalizeTastytradeBaseUrl(
      explicit,
      side === "live" ? TASTYTRADE_CONFIG.liveBaseUrl : TASTYTRADE_CONFIG.paperBaseUrl,
    );
  }
  const sideUrl = side === "live" ? env.TASTYTRADE_LIVE_URL : env.TASTYTRADE_PAPER_URL;
  const fallback = side === "live" ? TASTYTRADE_CONFIG.liveBaseUrl : TASTYTRADE_CONFIG.paperBaseUrl;
  return normalizeTastytradeBaseUrl(sideUrl, fallback);
}

function getSessionKv(env: Env) {
  const ns = (env as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE;
  if (!ns) return null;
  return createStoreKv({
    namespace: ns,
    namespaceName: TASTYTRADE_CREDENTIAL_NAMESPACE,
    legacyFallback: false,
  });
}

export function parseTastytradeCredential(raw: string | null): TastytradeCredentialRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TastytradeCredentialRecord>;
    if (
      typeof parsed.userLogin !== "string" ||
      (parsed.side !== "paper" && parsed.side !== "live") ||
      typeof parsed.clientSecret !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      !parsed.clientSecret.trim() ||
      !parsed.refreshToken.trim()
    ) {
      return null;
    }
    return {
      userLogin: parsed.userLogin,
      side: parsed.side,
      clientSecret: parsed.clientSecret,
      refreshToken: parsed.refreshToken,
      refreshTokenLast4:
        typeof parsed.refreshTokenLast4 === "string"
          ? parsed.refreshTokenLast4
          : parsed.refreshToken.slice(-4),
      storedAt: typeof parsed.storedAt === "string" ? parsed.storedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function describeTastytradeCredential(
  record: TastytradeCredentialRecord | null,
): TastytradeCredentialDescription | null {
  if (!record) return null;
  return {
    side: record.side,
    refreshTokenLast4: record.refreshTokenLast4,
    storedAt: record.storedAt,
  };
}

export async function getStoredTastytradeCredential(
  env: Env,
  userLogin: string,
  side: TastytradeSide,
): Promise<TastytradeCredentialRecord | null> {
  const kv = getSessionKv(env);
  if (!kv || !userLogin) return null;
  const raw = await kv.get(tastytradeCredentialKey(userLogin, side));
  return parseTastytradeCredential(raw);
}

export async function storeTastytradeCredential(
  env: Env,
  input: {
    userLogin: string;
    side: TastytradeSide;
    clientSecret: string;
    refreshToken: string;
  },
): Promise<TastytradeCredentialDescription> {
  const kv = getSessionKv(env);
  if (!kv) {
    throw new Error("SessionStore Durable Object is not bound; cannot store Tastytrade credentials.");
  }
  const record: TastytradeCredentialRecord = {
    userLogin: input.userLogin,
    side: input.side,
    clientSecret: input.clientSecret.trim(),
    refreshToken: input.refreshToken.trim(),
    refreshTokenLast4: input.refreshToken.trim().slice(-4),
    storedAt: new Date().toISOString(),
  };
  await kv.put(tastytradeCredentialKey(input.userLogin, input.side), JSON.stringify(record));
  return {
    side: record.side,
    refreshTokenLast4: record.refreshTokenLast4,
    storedAt: record.storedAt,
  };
}

export async function revokeTastytradeCredentials(env: Env, userLogin: string): Promise<void> {
  const kv = getSessionKv(env);
  if (!kv || !userLogin) return;
  await Promise.all(
    TASTYTRADE_CREDENTIAL_SIDES.map((side) => kv.delete(tastytradeCredentialKey(userLogin, side))),
  );
}

export async function resolveTastytradeCredentials(
  env: Env,
  userLogin: string,
  overrideEnv?: string,
): Promise<TastytradeCredentialPair | null> {
  const side = tastytradeTradingSide(env, overrideEnv);
  const baseUrl = resolveTastytradeBaseUrl(env, overrideEnv);

  const stored = await getStoredTastytradeCredential(env, userLogin, side);
  if (stored) {
    return {
      clientSecret: stored.clientSecret,
      refreshToken: stored.refreshToken,
      baseUrl,
      side,
      source: "stored",
    };
  }

  const sideSecret = side === "live" ? env.TASTYTRADE_LIVE_CLIENT_SECRET : env.TASTYTRADE_PAPER_CLIENT_SECRET;
  const sideRefresh = side === "live" ? env.TASTYTRADE_LIVE_REFRESH_TOKEN : env.TASTYTRADE_PAPER_REFRESH_TOKEN;
  const clientSecret = String(env.TASTYTRADE_CLIENT_SECRET ?? sideSecret ?? "").trim();
  const refreshToken = String(env.TASTYTRADE_REFRESH_TOKEN ?? sideRefresh ?? "").trim();
  if (!clientSecret || !refreshToken) return null;

  return {
    clientSecret,
    refreshToken,
    baseUrl,
    side,
    source: "env",
  };
}

/**
 * OAuth2 personal refresh-token session ported from amuse `OAuthSession`.
 *
 * Proactively refreshes `TASTYTRADE_CONFIG.refreshMarginSecs` before expiry;
 * never retries a POST on 401; never exposes secrets in errors or JSON.
 */
export class TastytradeOAuthSession {
  private readonly clientSecret: string;
  private refreshToken: string;
  readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private accessToken: string | null = null;
  private expiresAtMs = 0;

  constructor(options: {
    clientSecret: string;
    refreshToken: string;
    baseUrl?: string;
    userAgent?: string;
    fetchImpl?: typeof fetch;
    nowMs?: () => number;
  }) {
    if (!options.clientSecret.trim() || !options.refreshToken.trim()) {
      throw new Error("Tastytrade OAuth2 credentials require both client_secret and refresh_token.");
    }
    this.clientSecret = options.clientSecret.trim();
    this.refreshToken = options.refreshToken.trim();
    this.baseUrl = normalizeTastytradeBaseUrl(options.baseUrl, TASTYTRADE_CONFIG.paperBaseUrl);
    this.userAgent = options.userAgent ?? TASTYTRADE_CONFIG.userAgent;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  get currentRefreshToken(): string {
    return this.refreshToken;
  }

  needsRefresh(): boolean {
    if (!this.accessToken) return true;
    const marginMs = TASTYTRADE_CONFIG.refreshMarginSecs * 1000;
    return this.nowMs() >= this.expiresAtMs - marginMs;
  }

  async getAccessToken(): Promise<string> {
    if (this.needsRefresh() || !this.accessToken) {
      await this.refresh();
    }
    if (!this.accessToken) {
      throw new Error("Tastytrade OAuth2 token refresh did not yield an access token.");
    }
    return this.accessToken;
  }

  async refresh(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_secret: this.clientSecret,
    });

    const resp = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TASTYTRADE_CONFIG.requestTimeoutMs),
    });

    if (!resp.ok) {
      // Never include client_secret or refresh_token in exceptions.
      throw new Error(`Tastytrade OAuth2 token refresh failed (HTTP ${resp.status}).`);
    }

    const data = (await resp.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      refresh_token?: unknown;
    } | null;

    if (!data || typeof data.access_token !== "string" || !data.access_token.trim()) {
      throw new Error("Tastytrade OAuth2 token response missing access_token.");
    }

    const rawExpires = Number(data.expires_in);
    const expiresInSecs =
      Number.isFinite(rawExpires) && rawExpires > 0
        ? rawExpires
        : TASTYTRADE_CONFIG.defaultExpiresInSecs;

    this.accessToken = data.access_token;
    if (typeof data.refresh_token === "string" && data.refresh_token.trim()) {
      this.refreshToken = data.refresh_token.trim();
    }
    this.expiresAtMs = this.nowMs() + expiresInSecs * 1000;
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      authenticated: this.accessToken !== null,
      expiresAtMs: this.expiresAtMs,
    };
  }
}

/**
 * Verify a Tastytrade credential pair against `GET /customers/me/accounts`
 * before storing it.
 */
export async function verifyTastytradeAccount(input: {
  baseUrl: string;
  clientSecret: string;
  refreshToken: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}): Promise<TastytradeVerifyOutcome> {
  const doFetch = input.fetchImpl ?? fetch;
  const userAgent = input.userAgent ?? TASTYTRADE_CONFIG.userAgent;
  const session = new TastytradeOAuthSession({
    clientSecret: input.clientSecret,
    refreshToken: input.refreshToken,
    baseUrl: input.baseUrl,
    userAgent,
    fetchImpl: doFetch,
  });

  let token: string;
  try {
    token = await session.getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const statusMatch = msg.match(/HTTP (\d{3})/);
    const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
    return {
      ok: false,
      reason: httpStatus && REJECTED_STATUSES.has(httpStatus) ? "rejected" : "unavailable",
      httpStatus,
    };
  }

  try {
    const resp = await doFetch(`${session.baseUrl}/customers/me/accounts`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(TASTYTRADE_CONFIG.requestTimeoutMs),
    });

    if (!resp.ok) {
      return {
        ok: false,
        reason: REJECTED_STATUSES.has(resp.status) ? "rejected" : "unavailable",
        httpStatus: resp.status,
      };
    }

    const payload = (await resp.json().catch(() => null)) as {
      data?: { items?: Array<{ account?: { "account-number"?: string } }> };
    } | null;
    const firstAccount = payload?.data?.items?.[0]?.account?.["account-number"];
    if (!firstAccount || typeof firstAccount !== "string") {
      return { ok: false, reason: "unavailable", httpStatus: resp.status };
    }
    return { ok: true, accountNumber: firstAccount };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
