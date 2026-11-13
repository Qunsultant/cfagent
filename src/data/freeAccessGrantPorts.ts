/**
 * Issue #3247 (sub-issue of #3241), slice 1 — free-access grant
 * ports.
 *
 * This module is the ADR 0002 R1 boundary for free-access
 * grants: it imports no store client, references no env binding,
 * and writes no SQL. Only the adapters (Drizzle D1, in-memory)
 * touch a store, and only the composition root
 * (createFreeAccessGrantPorts.ts) maps a Worker binding to an
 * adapter.
 *
 * A free-access grant is a durable, auditable, revocable record
 * of free ACCESS for one login, plus exemption from any
 * access/subscription fee. That is all it is: it pins NO
 * allowance (the Free allowance stays operator data, owned by
 * the #3305/#3315 counter and allowance rows), it confers NO
 * tier and NO included runs (unlike a #3243 trial), and it
 * makes NO run free (unlike a #3245 grant) — the gate treats
 * it as nothing, pinned by test (tests/free_access_gate_3247
 * .test.ts). It is not a plan: no price, no runs, no period,
 * no Stripe object, and it never appears in GET /plans.
 *
 * Sign-in, browse, and view are already free today — there is
 * no access gate to open. What the grant adds is the explicit
 * record of the promise ("access free forever"), the
 * user-visible statement of it, and the exemption from any
 * FUTURE access fee. If no access fee ever exists, the grant's
 * observable effect is the record and the mention — that is
 * the design, not a gap.
 *
 * One active grant per login; granting while an active grant
 * exists revokes the old row and inserts the new one (replace
 * semantics, matching #3245's one-grant-slot shape). Expired
 * and revoked rows stay in the table as history — expiry and
 * revocation are filters, not deletions. No retention sweep
 * in v1; expired rows are inert.
 *
 * The grant row carries NO tenantId column: it is keyed by
 * login, and one login has one account row with one tenantId,
 * so login-scoping coincides with account-scoping. The audit
 * event's tenantId comes from the target account row, never
 * from a client-supplied value.
 */

/** A free-access grant kind: lifetime, or a limited window. */
export type FreeAccessGrantKind = "lifetime" | "limited";

/** One free-access grant record: a row of agent_free_access_grants. */
export interface FreeAccessGrantRecord {
  /** Server-generated id (`freeaccess-<uuid8>`). */
  id: string;
  /** The granted login. */
  login: string;
  kind: FreeAccessGrantKind;
  /** Session-verified operator login that granted it. Never client-supplied. */
  grantedBy: string;
  /** Server time at grant (epoch ms). */
  grantedAtMs: number;
  /** Null for lifetime; required, in the future, for limited. */
  expiresAtMs: number | null;
  /** Null while active; set on revoke/replace. */
  revokedAtMs: number | null;
  /** Operator-entered reason, required (mirrors #3245). */
  reason: string;
}

/** Validate a grant kind. */
export function assertFreeAccessGrantKind(value: unknown): FreeAccessGrantKind {
  if (value !== "lifetime" && value !== "limited") {
    throw new Error('Free-access grant kind must be "lifetime" or "limited".');
  }
  return value;
}

/**
 * Validate a grant input. Mirrors `assertUnlimitedFreeGrant`
 * (commercialPorts.ts): grantedBy and reason must be non-empty
 * strings (trimmed, no length cap — the #3245 assert caps
 * nothing either). Kind/expiry coherence is enforced here, so
 * a bad grant is refused before any write: a lifetime grant
 * FORBIDS expiresAtMs, a limited grant REQUIRES an epoch-ms
 * integer in the future. There is NO default window anywhere —
 * the expiry is per-grant operator data, never a code constant.
 */
export function assertFreeAccessGrantInput(
  input: {
    login?: unknown;
    kind?: unknown;
    expiresAtMs?: unknown;
    reason?: unknown;
    grantedBy?: unknown;
  },
  nowMs: number,
): {
  login: string;
  kind: FreeAccessGrantKind;
  expiresAtMs: number | null;
  reason: string;
  grantedBy: string;
} {
  const login = typeof input.login === "string" ? input.login.trim() : "";
  if (!login) {
    throw new Error("Free-access grant login must be a non-empty string.");
  }
  const kind = assertFreeAccessGrantKind(input.kind);
  const grantedBy = typeof input.grantedBy === "string" ? input.grantedBy.trim() : "";
  if (!grantedBy) {
    throw new Error("Free-access grant grantedBy must be a non-empty string.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) {
    throw new Error("Free-access grant reason must be a non-empty string.");
  }
  const expiresAtMs = input.expiresAtMs === undefined ? null : input.expiresAtMs;
  if (kind === "lifetime") {
    if (expiresAtMs !== null) {
      throw new Error("Free-access grant expiresAtMs must be null for a lifetime grant.");
    }
  } else if (
    typeof expiresAtMs !== "number" ||
    !Number.isInteger(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    throw new Error(
      "Free-access grant expiresAtMs must be an epoch-ms integer in the future for a limited grant.",
    );
  }
  return { login, kind, expiresAtMs: expiresAtMs as number | null, reason, grantedBy };
}

/**
 * A grant is active only while it exists, is unrevoked, and its
 * expiry (if any) is in the future. Pure and unit-testable
 * without D1; `getActiveGrant` applies it, and the adapters
 * apply the same filter in SQL / in-memory scan.
 */
export function isFreeAccessGrantActive(
  grant: FreeAccessGrantRecord | null | undefined,
  nowMs: number,
): boolean {
  if (!grant) return false;
  return grant.revokedAtMs === null && (grant.expiresAtMs === null || grant.expiresAtMs > nowMs);
}

/**
 * The free-access grant port. The #3246 §3.8 read contract is
 * satisfied by projection: the mention reader maps the record
 * returned by `getActiveGrant` to `{ kind, expiresAtMs }`. The
 * port returns the full record because the operator routes need
 * `grantedBy`/`reason`/history.
 */
export interface FreeAccessGrantPort {
  /** The active grant for the login, or null. Newest unrevoked, unexpired row. */
  getActiveGrant(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null>;
  /** Full history for the login, newest first (active + revoked + expired). */
  listGrants(login: string): Promise<FreeAccessGrantRecord[]>;
  /**
   * Grant (replacing any active grant). Returns the new row and
   * the replaced row, if any, so the route can audit both
   * events. The replaced row carries its revokedAtMs.
   */
  grant(input: {
    login: string;
    kind: FreeAccessGrantKind;
    expiresAtMs: number | null;
    reason: string;
    grantedBy: string;
    nowMs: number;
  }): Promise<{ granted: FreeAccessGrantRecord; replaced: FreeAccessGrantRecord | null }>;
  /** Revoke the active grant, if any. Returns the revoked row, or null. */
  revokeActive(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null>;
}
