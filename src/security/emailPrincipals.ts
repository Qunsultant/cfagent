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
 * entries are skipped the same way.
 */
export function parseEmailPrincipals(env: Env): Record<string, EmailPrincipalEntry> {
  const raw = (env as { CHANNEL_EMAIL_PRINCIPALS?: string }).CHANNEL_EMAIL_PRINCIPALS;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      "[channels] CHANNEL_EMAIL_PRINCIPALS is not valid JSON; treating the email principal map as empty:",
      err instanceof Error ? err.message : String(err)
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[channels] CHANNEL_EMAIL_PRINCIPALS must be a JSON object; treating the email principal map as empty.");
    return {};
  }
  const out: Record<string, EmailPrincipalEntry> = {};
  for (const [address, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = entry as { login?: unknown; tier?: unknown } | null;
    if (!e || typeof e.login !== "string" || e.login.trim() === "" || !isTier(e.tier)) {
      console.error(`[channels] CHANNEL_EMAIL_PRINCIPALS entry for "${address}" is malformed (needs {login, tier}); skipping it.`);
      continue;
    }
    out[address.trim().toLowerCase()] = { login: e.login, tier: e.tier };
  }
  return out;
}
