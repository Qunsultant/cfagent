/**
 * Email principal map (CHANNEL_EMAIL_PRINCIPALS) — issue #5083 (S4).
 *
 * The CHANNEL_EMAIL_PRINCIPALS config var is a JSON map of lowercased
 * sender address → { login, tier }. It is plain configuration read from
 * env (not a credential), and it is a cross-cutting identity concern:
 * the trading channels resolve a principal from it, and the OTel
 * alerting port (S4) resolves the alert recipients from it. It lives
 * here (src/security/) — not in src/trading/ — so both sides can import
 * it without crossing the trading boundary (issue #290: src/trading/
 * is importable only through src/trading/index.ts).
 *
 * Tiers: "read" (quote / screen / discovery / recommendation) <
 * "preview" (+ trade previews) < "trade" (+ approve / execute).
 */
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

export type ChannelTier = "read" | "preview" | "trade";

export function isTier(value: unknown): value is ChannelTier {
  return value === "read" || value === "preview" || value === "trade";
}

export interface EmailPrincipalEntry {
  login: string;
  tier: ChannelTier;
}

/**
 * Parse the CHANNEL_EMAIL_PRINCIPALS config var. Malformed JSON is an
 * empty map plus a loud log — a config typo must fail closed (nobody
 * resolves) without ever throwing the worker. Individual malformed
 * entries are skipped the same way. The log goes through the
 * structured logger (the console.* ratchet, #3515 S3, pins new files
 * at zero unstructured console uses).
 */
export function parseEmailPrincipals(env: Env): Record<string, EmailPrincipalEntry> {
  const logger = createStructuredLogger(createObservabilitySink(env), {
    component: "security.emailPrincipals",
  });
  const raw = (env as { CHANNEL_EMAIL_PRINCIPALS?: string }).CHANNEL_EMAIL_PRINCIPALS;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("email_principals.invalid_json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn("email_principals.not_an_object", {});
    return {};
  }
  const out: Record<string, EmailPrincipalEntry> = {};
  for (const [address, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = entry as { login?: unknown; tier?: unknown } | null;
    if (!e || typeof e.login !== "string" || e.login.trim() === "" || !isTier(e.tier)) {
      logger.warn("email_principals.malformed_entry", { address });
      continue;
    }
    out[address.trim().toLowerCase()] = { login: e.login, tier: e.tier };
  }
  return out;
}
