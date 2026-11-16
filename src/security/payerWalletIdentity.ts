/**
 * Payer-Wallet Fallback Identity Policy (#4621)
 *
 * Decision: wallet-as-subject (scoped & fail-closed).
 * - When a verified session login (`x-user-login`) is present, the session
 *   login is the subject and resolves its commercial tier normally.
 * - When no session login exists on a verified x402 call, a verified on-chain
 *   payer wallet (`payer:<normalizedAddress>`) may act as an isolated
 *   `wallet-as-subject` ONLY for that x402 paid run and per-payer quota.
 * - A payer wallet NEVER impersonates an arbitrary app user login and NEVER
 *   gains access to user-owned broker tokens, sessions, or tenant settings.
 * - Tier resolution: if an explicit wallet->login mapping exists, the gate
 *   resolves that mapped login's tier; otherwise an unmapped wallet defaults
 *   to `"free"` (or null/fail-closed for tier-gated reads).
 */

export type PayerIdentityMode = "session-login" | "wallet-as-subject";

export interface WalletLoginResolver {
  (walletAddress: string): Promise<string | null> | string | null;
}

export interface PayerIdentityResolution {
  ok: true;
  mode: PayerIdentityMode;
  subjectId: string;
  tierLookupLogin: string | null;
  canAccessUserBrokerTokens: boolean;
}

export interface PayerIdentityRefusal {
  ok: false;
  code: "FAILURE_PAYER_IDENTITY_REQUIRED";
  error: string;
}

export type PayerIdentityResult = PayerIdentityResolution | PayerIdentityRefusal;

export function normalizeWalletSubject(walletAddress: string): string {
  return `payer:${walletAddress.trim().toLowerCase()}`;
}

/**
 * Resolve the identity and tier-lookup login for a premium x402 call.
 * Fails closed when neither a session login nor a verified payer wallet exists.
 */
export async function resolvePayerWalletIdentity(input: {
  sessionLogin?: string | null;
  verifiedPayerWallet?: string | null;
  resolveWalletMappedLogin?: WalletLoginResolver;
}): Promise<PayerIdentityResult> {
  const sessionLogin =
    typeof input.sessionLogin === "string" ? input.sessionLogin.trim() : "";
  if (sessionLogin.length > 0) {
    return {
      ok: true,
      mode: "session-login",
      subjectId: sessionLogin,
      tierLookupLogin: sessionLogin,
      canAccessUserBrokerTokens: true,
    };
  }

  const wallet =
    typeof input.verifiedPayerWallet === "string"
      ? input.verifiedPayerWallet.trim()
      : "";
  if (!wallet) {
    return {
      ok: false,
      code: "FAILURE_PAYER_IDENTITY_REQUIRED",
      error: "Verified session login or x402 payer wallet is required.",
    };
  }

  const mappedLogin = input.resolveWalletMappedLogin
    ? await input.resolveWalletMappedLogin(wallet)
    : null;
  const normalizedMapped =
    typeof mappedLogin === "string" && mappedLogin.trim().length > 0
      ? mappedLogin.trim()
      : null;

  return {
    ok: true,
    mode: "wallet-as-subject",
    subjectId: normalizeWalletSubject(wallet),
    tierLookupLogin: normalizedMapped,
    // A payer wallet without a verified session never reads user broker tokens.
    canAccessUserBrokerTokens: false,
  };
}
