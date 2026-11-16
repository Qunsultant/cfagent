/**
 * Uniform Provenance Tuple (#4615)
 *
 * Every run, delivery, denial, and fallback audit/structured record carries
 * the full 5-leg provenance tuple (tenant + user + provider + broker + channel)
 * so any single record is traceable without joining against another table.
 */

export type ProvenanceRecordKind = "run" | "delivery" | "denial" | "fallback";

export interface ProvenanceTuple {
  tenantId: string;
  userId: string;
  providerId: string;
  brokerId: string;
  channel: string;
}

export interface ProvenanceTupleInput {
  tenantId?: string | null;
  userId?: string | null;
  providerId?: string | null;
  brokerId?: string | null;
  channel?: string | null;
}

const UNSPECIFIED = "unspecified";

function normalizeLeg(value: string | null | undefined, fallback: string = UNSPECIFIED): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Build a complete 5-leg ProvenanceTuple with non-empty string values for every leg.
 */
export function buildProvenanceTuple(input: ProvenanceTupleInput): ProvenanceTuple {
  return {
    tenantId: normalizeLeg(input.tenantId),
    userId: normalizeLeg(input.userId),
    providerId: normalizeLeg(input.providerId),
    brokerId: normalizeLeg(input.brokerId),
    channel: normalizeLeg(input.channel),
  };
}

/**
 * Attach the uniform provenance tuple and record kind to an audit or log detail object.
 */
export function withProvenanceTuple<T extends Record<string, unknown>>(
  detail: T,
  recordKind: ProvenanceRecordKind,
  input: ProvenanceTupleInput
): T & { provenanceRecordKind: ProvenanceRecordKind; provenanceTuple: ProvenanceTuple } {
  return {
    ...detail,
    provenanceRecordKind: recordKind,
    provenanceTuple: buildProvenanceTuple(input),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Extract a valid 5-leg ProvenanceTuple from an arbitrary record/detail payload without any join.
 * Returns null if any leg is missing or empty.
 */
export function readProvenanceTuple(record: unknown): ProvenanceTuple | null {
  if (!record || typeof record !== "object") return null;
  const rec = record as Record<string, unknown>;
  const nested =
    rec.provenanceTuple && typeof rec.provenanceTuple === "object"
      ? (rec.provenanceTuple as Record<string, unknown>)
      : rec;

  const tenantId = nested.tenantId;
  const userId = nested.userId;
  const providerId = nested.providerId;
  const brokerId = nested.brokerId;
  const channel = nested.channel;

  if (
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(userId) ||
    !isNonEmptyString(providerId) ||
    !isNonEmptyString(brokerId) ||
    !isNonEmptyString(channel)
  ) {
    return null;
  }

  return {
    tenantId: tenantId.trim(),
    userId: userId.trim(),
    providerId: providerId.trim(),
    brokerId: brokerId.trim(),
    channel: channel.trim(),
  };
}

/**
 * Verify that a record carries all 5 provenance tuple legs.
 */
export function hasUniformProvenanceTuple(record: unknown): boolean {
  return readProvenanceTuple(record) !== null;
}
