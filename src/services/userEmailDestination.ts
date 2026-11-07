/**
 * Issue Qunsultant/cfagent#488 — per-user email destination as data.
 *
 * SCREENER_EMAIL_TO (and OPTIONS_EMAIL_TO) are deployment-global env vars:
 * every user's screener mail goes to the same address, or nowhere. This
 * module makes the destination per-user data instead, stored in the
 * SessionStore Durable Object (the same DO that holds sessions and
 * E*TRADE tokens since #415 — never KV), keyed by the caller's login.
 *
 * Resolution precedence (the scoped-defaults order run > session > user >
 * global env > built-in, with no session-level email destination today):
 *   1. the run's explicit emailTo (event / call-site option),
 *   2. the user's stored destination (this module),
 *   3. OPTIONS_EMAIL_TO (options runs only, kept for compatibility),
 *   4. SCREENER_EMAIL_TO (the deployment default),
 *   5. none (caller skips email with a named reason, as before).
 *
 * A stored destination is the user's own delivery address, not an
 * enforcement gate: setting it changes where that user's reports go and
 * nothing else, so it is user-configurable by design. It never grants
 * any permission and never disables any IAAA gate.
 *
 * Failure discipline: a store read failure (DO unbound, timeout, corrupt
 * record) degrades to the env fallback — delivery must not fail because
 * a preference read failed. A corrupt record is treated as missing, not
 * as an address, and is never overwritten by a read. Writes validate
 * strictly and reject invalid addresses instead of storing them.
 */

import { sessionStore } from "../security/session";
import type { KvLike } from "../security/kvResilience";
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/userEmailDestination",
});


/** Prefix for every per-user email-destination key in the SessionStore DO. */
export const USER_EMAIL_DESTINATION_KEY_PREFIX = "user-email-destination:";

const MAX_EMAIL_LENGTH = 254;
/** Deliberately strict: one @, a dot in the domain, no spaces or brackets. */
const EMAIL_PATTERN = /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]+$/;

export interface EmailDestinationRecord {
  email: string;
  updatedAt: string;
  updatedBy: string;
}

export type NormalizeResult = { ok: true; email: string } | { ok: false; error: string };

export function normalizeEmailDestination(value: unknown): NormalizeResult {
  if (typeof value !== "string") return { ok: false, error: "Email destination must be a string." };
  const email = value.trim().toLowerCase();
  if (email === "") return { ok: false, error: "Email destination must not be empty." };
  if (email.length > MAX_EMAIL_LENGTH) {
    return { ok: false, error: `Email destination must be ${MAX_EMAIL_LENGTH} characters or fewer.` };
  }
  if (!EMAIL_PATTERN.test(email)) return { ok: false, error: "Email destination is not a valid email address." };
  return { ok: true, email };
}

function destinationKey(userLogin: string): string {
  return `${USER_EMAIL_DESTINATION_KEY_PREFIX}${userLogin}`;
}

export interface UserEmailDestinationStore {
  get(userLogin: string): Promise<string | null>;
  set(userLogin: string, email: string, updatedBy: string): Promise<EmailDestinationRecord>;
  clear(userLogin: string): Promise<void>;
}

export function createUserEmailDestinationStore(kv: KvLike): UserEmailDestinationStore {
  return {
    async get(userLogin: string): Promise<string | null> {
      const raw = await kv.get(destinationKey(userLogin));
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof (parsed as { email?: unknown }).email !== "string"
      ) {
        return null;
      }
      const normalized = normalizeEmailDestination((parsed as { email: string }).email);
      return normalized.ok ? normalized.email : null;
    },
    async set(userLogin: string, email: string, updatedBy: string): Promise<EmailDestinationRecord> {
      const normalized = normalizeEmailDestination(email);
      if (!normalized.ok) throw new Error(normalized.error);
      const record: EmailDestinationRecord = {
        email: normalized.email,
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
      await kv.put(destinationKey(userLogin), JSON.stringify(record));
      return record;
    },
    async clear(userLogin: string): Promise<void> {
      await kv.delete(destinationKey(userLogin));
    },
  };
}

/** Production store: the SessionStore DO via the session KvLike adapter. */
export function userEmailDestinationStore(env: Env): UserEmailDestinationStore {
  return createUserEmailDestinationStore(sessionStore(env));
}

/**
 * Best-effort stored-destination read for delivery paths. Never throws:
 * any store failure reads as "no stored destination" so the caller falls
 * back to the global env vars exactly as before.
 */
export async function getStoredEmailDestination(
  env: Env,
  userLogin: string
): Promise<string | undefined> {
  if (!userLogin) return undefined;
  try {
    const stored = await userEmailDestinationStore(env).get(userLogin);
    return stored ?? undefined;
  } catch (err) {
    structuredLog.warn("userEmailDestination.stored_destination_read_failed", {
      message: "[userEmailDestination] Stored destination read failed, falling back to env",
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export interface ResolveEmailDestinationInput {
  eventEmailTo?: string | null;
  storedEmailTo?: string | null;
  env: Record<string, unknown>;
}

function envStr(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Pure precedence: run > stored user > OPTIONS_EMAIL_TO > SCREENER_EMAIL_TO. */
export function resolveEmailDestination(input: ResolveEmailDestinationInput): string | undefined {
  const event = input.eventEmailTo?.trim();
  if (event) return event;
  const stored = input.storedEmailTo?.trim();
  if (stored) {
    const normalized = normalizeEmailDestination(stored);
    if (normalized.ok) return normalized.email;
  }
  return envStr(input.env, "OPTIONS_EMAIL_TO") ?? envStr(input.env, "SCREENER_EMAIL_TO");
}
