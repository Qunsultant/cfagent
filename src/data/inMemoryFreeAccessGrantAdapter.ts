/**
 * Issue #3247 (sub-issue of #3241), slice 1 — in-memory
 * free-access grant store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any
 * store at all. No migration concept applies here (there is no
 * SQL to migrate). Single-threaded JS makes each method body
 * atomic, so the conditional transitions read as check-then-set;
 * the D1 adapter expresses the same transitions as single
 * conditional statements.
 */
import {
  assertFreeAccessGrantInput,
  isFreeAccessGrantActive,
  type FreeAccessGrantPort,
  type FreeAccessGrantRecord,
} from "./freeAccessGrantPorts";

function newestFirst(a: FreeAccessGrantRecord, b: FreeAccessGrantRecord): number {
  return b.grantedAtMs - a.grantedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export class InMemoryFreeAccessGrantAdapter implements FreeAccessGrantPort {
  private rows = new Map<string, FreeAccessGrantRecord>();

  async getActiveGrant(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null> {
    const active = [...this.rows.values()]
      .filter((r) => r.login === login && isFreeAccessGrantActive(r, nowMs))
      .sort(newestFirst);
    return active.length === 0 ? null : { ...active[0] };
  }

  async listGrants(login: string): Promise<FreeAccessGrantRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.login === login)
      .sort(newestFirst)
      .map((r) => ({ ...r }));
  }

  async grant(input: {
    login: string;
    kind: FreeAccessGrantRecord["kind"];
    expiresAtMs: number | null;
    reason: string;
    grantedBy: string;
    nowMs: number;
  }): Promise<{ granted: FreeAccessGrantRecord; replaced: FreeAccessGrantRecord | null }> {
    const validated = assertFreeAccessGrantInput(input, input.nowMs);
    const nowMs = input.nowMs;
    let replaced: FreeAccessGrantRecord | null = null;
    const active = await this.getActiveGrant(validated.login, nowMs);
    if (active) {
      replaced = { ...active, revokedAtMs: nowMs };
      this.rows.set(replaced.id, { ...replaced });
    }
    const record: FreeAccessGrantRecord = {
      id: `freeaccess-${crypto.randomUUID().slice(0, 8)}`,
      login: validated.login,
      kind: validated.kind,
      grantedBy: validated.grantedBy,
      grantedAtMs: nowMs,
      expiresAtMs: validated.expiresAtMs,
      revokedAtMs: null,
      reason: validated.reason,
    };
    this.rows.set(record.id, { ...record });
    return { granted: { ...record }, replaced: replaced ? { ...replaced } : null };
  }

  async revokeActive(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null> {
    const active = await this.getActiveGrant(login, nowMs);
    if (!active) return null;
    const revoked = { ...active, revokedAtMs: nowMs };
    this.rows.set(revoked.id, { ...revoked });
    return { ...revoked };
  }
}
