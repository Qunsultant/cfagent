/**
 * Issue #2183 (Q7 audit-policy mechanism, sub-issue of #2012;
 * proposal slice for CISO+CDO review under #945, consumed by #1999)
 * — audit-policy port.
 *
 * #945 requires three decisions that gate #1999's "as audited"
 * claim: which consequential actions block when audit fails, a
 * retention period, and a tamper mechanism. #945 specifies
 * tamper-DETECTION controls without naming a mechanism; #1999
 * names the candidate as "tamper-evident hash chain (proposed)"
 * with "retention undecided". This module builds that mechanism
 * (hash chain) and externalizes the other two decisions as
 * operator data — it does NOT decide the policy.
 *
 * Port-first (ADR 0002 R1/R2): this module carries record types,
 * the port interface, and pure helpers ONLY. It imports no store
 * client, references no env binding, and writes no SQL. All
 * query-builder code lives in d1AuditPolicyAdapter.ts; the
 * in-memory adapter shares the constants below so the two
 * implementations cannot drift. A structural test pins the
 * import rule.
 *
 * Enforcement default (proposal, NOT activation): the seeded
 * enforcement mode is "audit-only". In audit-only mode the gate
 * evaluator NEVER blocks — it records that an action WOULD have
 * blocked. NOTE (#3156, owner directive 2026-11-04): the caller
 * helper in src/services/auditGate.ts now FORCES enforcing mode
 * regardless of this stored setting, and fails closed when the
 * store is unreachable — audit-only is OFF for live money paths.
 * This pure evaluator and its seed keep their #2183 semantics
 * (a future cleanup may remove the setting); only the helper's
 * behavior changed, so the evaluator/seed/resolve tests below
 * still assert the proposal values.
 *
 * Retention scope: the retention period here governs the D1
 * hash-chain evidence rows ONLY. It does not touch mas_events
 * (the DO audit store, still owned by the orchestrator path)
 * and does not touch the shard-job retention allowlist (#1701),
 * which keeps audit as KEEP. Pruning is operator-invoked only
 * (pruneAuditChainForTenant); there is no automatic purge and
 * no scheduled job in this slice.
 *
 * Chain-verification scope note: pruning deletes the OLDEST
 * rows, so the earliest surviving row's prev_hash points at a
 * deleted row. verifyAuditChain therefore treats the earliest
 * surviving row as an anchor (its prev_hash is not checked
 * against a predecessor) and checks every later link. Deleting
 * the oldest rows is exactly what a retention prune does, so
 * oldest-row deletion is undetectable by the chain by design;
 * the prune itself must be audit-logged by its operator caller.
 * A modified payload, a modified hash, a deleted MIDDLE row, or
 * a reordered row is always detected.
 */

/** Enforcement mode, stored as operator data (setting key below). */
export type AuditEnforcementMode = "audit-only" | "enforcing";

/**
 * Consequential actions that PROPOSE to block on audit failure
 * (money-moving actions). Seeded in migration 0016 as operator
 * data, changeable without a code change, PENDING CISO+CDO
 * sign-off. The gate consults the operator rows, never this
 * constant, at runtime — this list is the seed and the doc.
 */
export const AUDIT_POLICY_BLOCKING_ACTIONS = [
  "payment.charge",
  "payment.refund",
  "subscription.change",
  "credit.issue",
] as const;

/**
 * Read-only actions that NEVER block, in either mode, pinned by
 * test. Seeded alongside the blocking set so the proposal is
 * explicit about both sides.
 */
export const AUDIT_POLICY_NON_BLOCKING_ACTIONS = [
  "audit.read",
  "payment.read",
] as const;

/**
 * Proposed retention period in days for D1 hash-chain evidence
 * rows, seeded as operator data (setting key below), PENDING
 * CISO+CDO sign-off. #1999 records retention as undecided, so
 * this number is a proposal, not a decision — and a missing,
 * zero, or negative period prunes nothing (fail-closed toward
 * retention).
 */
export const AUDIT_POLICY_PROPOSED_RETENTION_DAYS = 365;

/** Operator-data setting keys (agent_audit_policy_settings). */
export const AUDIT_POLICY_SETTING_ENFORCEMENT_MODE = "enforcement_mode";
export const AUDIT_POLICY_SETTING_RETENTION_DAYS = "retention_days";

/** Seeded enforcement mode: audit-only. Never "enforcing". */
export const AUDIT_POLICY_DEFAULT_MODE: AuditEnforcementMode = "audit-only";

/** Rows fetched + deleted per prune batch (mirrors retention purge). */
export const AUDIT_CHAIN_PRUNE_DEFAULT_BATCH_SIZE = 500;

/** Safety cap: maximum rows deleted in a single prune run. */
export const AUDIT_CHAIN_PRUNE_DEFAULT_MAX_PER_RUN = 5000;

/** prev_hash of a chain's first row (no predecessor exists). */
export const AUDIT_CHAIN_GENESIS_PREV_HASH = "GENESIS";

/** One operator-data row: does this action block on audit failure? */
export interface AuditPolicyActionRow {
  action: string;
  blockOnAuditFailure: boolean;
  updatedAtMs: number;
}

/** One operator-data setting row (key/value, both strings). */
export interface AuditPolicySettingRow {
  key: string;
  value: string;
  updatedAtMs: number;
}

/**
 * One tamper-evident chain row, per tenant. entryHash binds
 * prevHash + payloadHash + action + createdAtMs; payloadHash
 * binds the canonical JSON of the audited payload. The payload
 * itself is NOT stored here — the DO mas_events row remains the
 * audit record; this row is its tamper-evidence link.
 */
export interface AuditChainEntry {
  id: string;
  tenantId: string;
  /** Per-tenant sequence, 1-based, consecutive among live rows. */
  sequence: number;
  action: string;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
  createdAtMs: number;
}

/** Caller-supplied chain append; id/sequence/hashes are adapter-assigned. */
export interface AuditChainEntryInput {
  tenantId: string;
  action: string;
  payload: Record<string, unknown>;
  /** Injectable clock (tests, backfill). Defaults to Date.now(). */
  createdAtMs?: number;
}

/**
 * Resolved policy: what the gate evaluator reads. Built from
 * operator rows by resolveAuditPolicy; domain code never reads
 * the settings table directly.
 */
export interface AuditPolicy {
  mode: AuditEnforcementMode;
  /** Null when unset/invalid — prune then prunes nothing. */
  retentionDays: number | null;
  blockingActions: ReadonlySet<string>;
}

/**
 * Minimal store surface the audit-policy mechanism needs.
 * Blocking-set and settings rows are GLOBAL operator data (one
 * policy for all tenants); chain rows are tenant-scoped, and
 * there is no unscoped chain read anywhere in this module.
 * Implemented by the D1 adapter and the in-memory adapter.
 */
export interface AuditPolicyPort {
  /** Blocking-set rows (global operator data). */
  listActionPolicies(): Promise<AuditPolicyActionRow[]>;
  getActionPolicy(action: string): Promise<AuditPolicyActionRow | null>;
  setActionPolicy(action: string, blockOnAuditFailure: boolean): Promise<AuditPolicyActionRow>;
  /** Settings rows (global operator data). */
  getSetting(key: string): Promise<AuditPolicySettingRow | null>;
  setSetting(key: string, value: string): Promise<AuditPolicySettingRow>;
  /** Chain head for one tenant (null when the tenant has no rows). */
  getChainHead(tenantId: string): Promise<AuditChainEntry | null>;
  /** Chain rows for one tenant, oldest first. */
  listChainEntries(tenantId: string): Promise<AuditChainEntry[]>;
  /** Append one link; the adapter assigns sequence + hashes. */
  appendChainEntry(input: AuditChainEntryInput): Promise<AuditChainEntry>;
  /** Up to `limit` rows for one tenant with createdAtMs < cutoffMs, oldest first. */
  listAgedChainEntries(tenantId: string, cutoffMs: number, limit: number): Promise<AuditChainEntry[]>;
  /** Delete exactly the given rows for one tenant. */
  deleteChainEntries(tenantId: string, ids: string[]): Promise<void>;
}

/** Result of evaluating one consequential action against the policy. */
export interface AuditGateDecision {
  action: string;
  mode: AuditEnforcementMode;
  /** True when the action's operator row says it blocks. */
  blockOnAuditFailure: boolean;
  /** True ONLY in enforcing mode, for a blocking action, on audit failure. */
  blocked: boolean;
  /** True in audit-only mode when the action WOULD have blocked. Never blocks. */
  wouldBlock: boolean;
  /** False exactly when blocked is true; the caller's allow/deny. */
  allowed: boolean;
}

/**
 * Pure gate evaluator (sync, no store access). Semantics, pinned
 * by test:
 * - Audit write succeeded → allowed, never blocked, never would-block.
 * - Audit write failed + action not in the blocking set (read-only
 *   or unknown) → allowed in BOTH modes. Unknown actions default
 *   to NOT blocked: adding a new consequential action requires
 *   adding an operator-data row for it. That default is itself
 *   part of the proposal for CISO+CDO to confirm or reverse.
 * - Audit write failed + blocking action + enforcing → blocked.
 * - Audit write failed + blocking action + audit-only → allowed,
 *   wouldBlock true (the caller logs the would-block event).
 */
export function evaluateAuditGate(
  policy: AuditPolicy,
  action: string,
  auditWriteSucceeded: boolean,
): AuditGateDecision {
  const blockOnAuditFailure = policy.blockingActions.has(action);
  if (auditWriteSucceeded || !blockOnAuditFailure) {
    return {
      action,
      mode: policy.mode,
      blockOnAuditFailure,
      blocked: false,
      wouldBlock: false,
      allowed: true,
    };
  }
  if (policy.mode === "enforcing") {
    return {
      action,
      mode: policy.mode,
      blockOnAuditFailure,
      blocked: true,
      wouldBlock: false,
      allowed: false,
    };
  }
  return {
    action,
    mode: policy.mode,
    blockOnAuditFailure,
    blocked: false,
    wouldBlock: true,
    allowed: true,
  };
}

/** Build a resolved policy from operator rows. Unknown mode strings fall back to audit-only. */
export async function resolveAuditPolicy(port: AuditPolicyPort): Promise<AuditPolicy> {
  const [actions, modeRow, retentionRow] = await Promise.all([
    port.listActionPolicies(),
    port.getSetting(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE),
    port.getSetting(AUDIT_POLICY_SETTING_RETENTION_DAYS),
  ]);
  const mode: AuditEnforcementMode =
    modeRow?.value === "enforcing" ? "enforcing" : "audit-only";
  let retentionDays: number | null = null;
  if (retentionRow) {
    const parsed = Number(retentionRow.value);
    if (Number.isFinite(parsed) && parsed > 0) retentionDays = parsed;
  }
  return {
    mode,
    retentionDays,
    blockingActions: new Set(
      actions.filter((a) => a.blockOnAuditFailure).map((a) => a.action),
    ),
  };
}

/** SHA-256 hex over UTF-8 text (WebCrypto; also available in Node 22 tests). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Canonical JSON: object keys sorted recursively, so the same
 * payload always hashes the same way regardless of key order.
 * Non-JSON values (undefined, functions) follow JSON.stringify
 * (dropped in objects, null in arrays).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Payload hash: SHA-256 of the canonical JSON of the payload. */
export async function auditPayloadHash(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Entry hash: SHA-256 over prevHash + payloadHash + action +
 * createdAtMs, newline-joined. Any change to any input changes
 * the hash, and any change to a predecessor's hash breaks every
 * later link (each later row's prevHash no longer matches).
 */
export async function auditChainEntryHash(
  prevHash: string,
  payloadHash: string,
  action: string,
  createdAtMs: number,
): Promise<string> {
  return sha256Hex(`${prevHash}\n${payloadHash}\n${action}\n${createdAtMs}`);
}

export interface AuditChainVerification {
  valid: boolean;
  /** Index (in sequence order) of the first broken link, or null when valid. */
  brokenIndex: number | null;
  /** Human-readable reason for the first break, or null when valid. */
  reason: string | null;
}

/**
 * Pure chain verifier. Rows are sorted by sequence first, so a
 * reordered input is verified in chain order — but a GAP in the
 * sequence (a deleted middle row) is itself a break: the row
 * after the gap carries the deleted row's entryHash as its
 * prevHash, which matches no surviving predecessor. The earliest
 * surviving row is the anchor (see module header: retention
 * prune deletes oldest rows by design, so its prevHash is not
 * checked). A modified payloadHash or entryHash fails the
 * recomputation check at that row's index.
 */
export async function verifyAuditChain(
  entries: AuditChainEntry[],
): Promise<AuditChainVerification> {
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    if (i > 0) {
      if (entry.sequence !== ordered[i - 1].sequence + 1) {
        return {
          valid: false,
          brokenIndex: i,
          reason: `sequence gap before sequence ${entry.sequence} (deleted or missing row)`,
        };
      }
      if (entry.prevHash !== ordered[i - 1].entryHash) {
        return {
          valid: false,
          brokenIndex: i,
          reason: `prevHash mismatch at sequence ${entry.sequence} (predecessor modified, deleted, or reordered)`,
        };
      }
    }
    const recomputed = await auditChainEntryHash(
      entry.prevHash,
      entry.payloadHash,
      entry.action,
      entry.createdAtMs,
    );
    if (recomputed !== entry.entryHash) {
      return {
        valid: false,
        brokenIndex: i,
        reason: `entryHash mismatch at sequence ${entry.sequence} (row modified)`,
      };
    }
  }
  return { valid: true, brokenIndex: null, reason: null };
}

export interface AuditChainPruneOptions {
  /** Injectable clock (tests). Defaults to Date.now(). */
  nowMs?: number;
  batchSize?: number;
  maxPerRun?: number;
}

export interface AuditChainPruneReport {
  tenantId: string;
  /** Epoch-ms cutoff used, or null when skipped. */
  cutoffMs: number | null;
  /** Rows deleted. */
  pruned: number;
  /** True when the per-run cap stopped the prune early. */
  capped: boolean;
  /** True when no retention period is configured — nothing touched. */
  skipped: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Retention enforcement for D1 chain rows, operator-invoked
 * only. Reads the externalized retention period from the
 * policy: a missing, non-numeric, zero, or negative period
 * prunes NOTHING (fail-closed toward retention — #1999 records
 * retention as undecided, so "no configured period" must never
 * be read as "delete everything"). Otherwise deletes rows older
 * than now − retentionDays, oldest first, in bounded batches,
 * subject to the per-run cap. Idempotent: a second run over the
 * same tenant prunes zero rows.
 */
export async function pruneAuditChainForTenant(
  port: AuditPolicyPort,
  tenantId: string,
  options: AuditChainPruneOptions = {},
): Promise<AuditChainPruneReport> {
  const policy = await resolveAuditPolicy(port);
  if (policy.retentionDays === null) {
    return { tenantId, cutoffMs: null, pruned: 0, capped: false, skipped: true };
  }
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - policy.retentionDays * DAY_MS;
  const batchSize = Math.max(1, options.batchSize ?? AUDIT_CHAIN_PRUNE_DEFAULT_BATCH_SIZE);
  const maxPerRun = Math.max(
    0,
    options.maxPerRun ?? AUDIT_CHAIN_PRUNE_DEFAULT_MAX_PER_RUN,
  );
  let pruned = 0;
  let capped = false;
  for (;;) {
    if (pruned >= maxPerRun) {
      capped = true;
      break;
    }
    const batch = await port.listAgedChainEntries(
      tenantId,
      cutoffMs,
      Math.min(batchSize, maxPerRun - pruned),
    );
    if (batch.length === 0) break;
    await port.deleteChainEntries(tenantId, batch.map((e) => e.id));
    pruned += batch.length;
    if (batch.length < batchSize) break;
  }
  return { tenantId, cutoffMs, pruned, capped, skipped: false };
}
