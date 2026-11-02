/**
 * Phase 5 slice 5 (#2000, #1819) — resource-event cardinality guard
 * and aggregation cap. Pure module, no bindings, no I/O, no runtime
 * imports: the fold case in observabilityPorts.ts delegates its
 * dimension bounding here so the whitelist stays a whitelist and the
 * guard stays independently unit-testable.
 *
 * Guard philosophy (pinned by tests, not by convention):
 * - Counts are required and strict: rowsRead/rowsWritten must be
 *   finite integers >= 0, else the whole event is rejected (null).
 *   A malformed count is a producer bug, not a value to guess.
 * - Dimensions are bounded, never exploded: a present-but-unbounded
 *   dimension value collapses to "other" (visible in aggregates),
 *   an over-long optional field drops (counts survive). Nothing
 *   high-cardinality ever reaches the single Analytics Engine index.
 * - Identities never survive: sessionRef is accepted ONLY as the
 *   #1743 correlator (12 lowercase hex chars, exactly what
 *   sessionRefFor produces). A raw session id is dropped, never
 *   laundered into a scope field. tenantId/runId are length-capped
 *   and dropped when over cap, never truncated into a new id.
 * - `statement` is the parameterized SQL template only (placeholders,
 *   no bound values — the producer contract in resourceUsagePorts).
 *   The guard fingerprints it (whitespace-collapsed, mirroring
 *   fingerprintSql) and drops it over cap; it never inspects values.
 */

/** Store ops the port recognizes (resourceUsagePorts). Anything else rejects. */
export const RESOURCE_OPS = ["get", "put", "delete", "consume", "list"] as const;

/** Trigger values the port recognizes. Anything else collapses to "other". */
export const RESOURCE_TRIGGERS = ["user", "scheduled", "tick", "manual"] as const;

/** Bucket shown when a dimension value is present but unbounded. */
export const OTHER_BUCKET = "other";

export const MAX_NS_LENGTH = 64;
export const MAX_CALLER_LENGTH = 128;
export const MAX_STATEMENT_LENGTH = 256;
export const MAX_TENANT_ID_LENGTH = 128;
export const MAX_RUN_ID_LENGTH = 256;

/** Exactly the sessionRefFor correlator shape: 12 lowercase hex chars. */
const SESSION_REF_PATTERN = /^[0-9a-f]{12}$/;

/** Namespace charset: lowercase bucket names only (sessions, etrade, ...). */
const NS_PATTERN = /^[a-z0-9_-]+$/;

/** Caller charset: call-site attribution strings, no whitespace/control. */
const CALLER_PATTERN = /^[A-Za-z0-9_./:-]+$/;

/** Default cap for capBucketGroups (working default, pinned by test). */
export const DEFAULT_MAX_GROUPS = 500;

export interface GuardedResourceFields {
  ns: string;
  op: string;
  rowsRead: number;
  rowsWritten: number;
  caller?: string;
  trigger?: string;
  statement?: string;
  /** Index signature so the set assigns to the event's Record fields. */
  [key: string]: string | number | undefined;
}

export interface GuardedResourceEvent {
  fields: GuardedResourceFields;
  tenantId: string | null;
  runId: string | null;
  sessionRef: string | null;
  durationMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : null;
}

/** Collapse whitespace so one template maps to one key (mirrors fingerprintSql). */
export function fingerprintStatement(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function boundedStr(
  value: unknown,
  maxLength: number,
  pattern: RegExp,
): string | "other" | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > maxLength || !pattern.test(value)) return "other";
  return value;
}

/**
 * Guard one resource envelope's data record. Returns null when the
 * event is malformed (missing/empty ns, unknown op, bad counts) —
 * the fold maps that to ignored, never thrown. Otherwise returns
 * the bounded field set plus scope (dropped fields become null or
 * are omitted; counts always survive a guard collapse).
 */
export function guardResourceEvent(data: unknown): GuardedResourceEvent | null {
  if (!isRecord(data)) return null;
  const nsRaw = data.ns;
  if (typeof nsRaw !== "string" || nsRaw.length === 0) return null;
  const ns =
    nsRaw.length > MAX_NS_LENGTH || !NS_PATTERN.test(nsRaw) ? OTHER_BUCKET : nsRaw;
  const opRaw = data.op;
  if (typeof opRaw !== "string" || !(RESOURCE_OPS as readonly string[]).includes(opRaw)) {
    return null;
  }
  const rowsRead = finiteInt(data.rowsRead);
  const rowsWritten = finiteInt(data.rowsWritten);
  if (rowsRead === null || rowsRead < 0 || rowsWritten === null || rowsWritten < 0) {
    return null;
  }
  const fields: GuardedResourceFields = { ns, op: opRaw, rowsRead, rowsWritten };
  if (data.caller !== undefined) {
    const caller = boundedStr(data.caller, MAX_CALLER_LENGTH, CALLER_PATTERN);
    fields.caller = caller ?? OTHER_BUCKET;
  }
  if (data.trigger !== undefined) {
    const trigger = data.trigger;
    fields.trigger =
      typeof trigger === "string" && (RESOURCE_TRIGGERS as readonly string[]).includes(trigger)
        ? trigger
        : OTHER_BUCKET;
  }
  if (typeof data.statement === "string") {
    const fingerprinted = fingerprintStatement(data.statement);
    if (fingerprinted.length > 0 && fingerprinted.length <= MAX_STATEMENT_LENGTH) {
      fields.statement = fingerprinted;
    }
  }
  const tenantId =
    typeof data.tenantId === "string" &&
    data.tenantId.length > 0 &&
    data.tenantId.length <= MAX_TENANT_ID_LENGTH
      ? data.tenantId
      : null;
  const runId =
    typeof data.runId === "string" &&
    data.runId.length > 0 &&
    data.runId.length <= MAX_RUN_ID_LENGTH
      ? data.runId
      : null;
  const sessionRef =
    typeof data.sessionRef === "string" && SESSION_REF_PATTERN.test(data.sessionRef)
      ? data.sessionRef
      : null;
  const out: GuardedResourceEvent = { fields, tenantId, runId, sessionRef };
  const durationMs = data.durationMs;
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    out.durationMs = durationMs;
  }
  return out;
}

/** Structural shape of one bucketTotals row (duck-typed: no import cycle). */
export interface BucketTotalLike {
  bucketStartMs: number;
  ns: string;
  op: string;
  caller: string;
  trigger: string;
  ops: number;
  rowsRead: number;
  rowsWritten: number;
}

function compareTotals(a: BucketTotalLike, b: BucketTotalLike): number {
  return (
    a.bucketStartMs - b.bucketStartMs ||
    a.ns.localeCompare(b.ns) ||
    a.op.localeCompare(b.op) ||
    a.caller.localeCompare(b.caller) ||
    a.trigger.localeCompare(b.trigger)
  );
}

/**
 * Aggregation cap: keep the top `maxGroups` groups by rowsRead and
 * fold the overflow into per-(bucket, ns, op) "other" rows. Grand
 * totals (ops, rowsRead, rowsWritten) are preserved exactly — the
 * cap bounds the index, never the numbers. The kept rows keep
 * bucketTotals' sort order; overflow rows sort alongside them.
 */
export function capBucketGroups(
  totals: readonly BucketTotalLike[],
  maxGroups: number = DEFAULT_MAX_GROUPS,
): BucketTotalLike[] {
  const cap = Math.max(0, Math.floor(maxGroups));
  const ranked = [...totals].sort((a, b) => b.rowsRead - a.rowsRead);
  const kept = ranked.slice(0, cap);
  const overflow = ranked.slice(cap);
  const overflowByKey = new Map<string, BucketTotalLike>();
  for (const row of overflow) {
    const key = [row.bucketStartMs, row.ns, row.op].join("\0");
    const existing = overflowByKey.get(key);
    if (existing) {
      existing.ops += row.ops;
      existing.rowsRead += row.rowsRead;
      existing.rowsWritten += row.rowsWritten;
    } else {
      overflowByKey.set(key, {
        bucketStartMs: row.bucketStartMs,
        ns: row.ns,
        op: row.op,
        caller: OTHER_BUCKET,
        trigger: OTHER_BUCKET,
        ops: row.ops,
        rowsRead: row.rowsRead,
        rowsWritten: row.rowsWritten,
      });
    }
  }
  return [...kept, ...overflowByKey.values()].sort(compareTotals);
}
