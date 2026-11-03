/**
 * Issue #2981 (monetization Phase 2.18) — digest content provider.
 *
 * The missing piece of the scheduled digest pass: the tick's
 * itemsProvider. The pass itself (lifecycleDigestPass.ts, #2659)
 * already owns enumeration, the once-per-day marker, per-user
 * failure containment, and delegation to sendDailyDigest
 * (lifecycleEmail.ts), which owns the opt-in re-check, the
 * per-day guard, skip-on-empty, and the slice-3 tier cap. This
 * module owns ONLY the content: windowed recent highlights from
 * the tenant's report projection.
 *
 * Source (inventory, S218-PLAN.md): the D1 agent_reports
 * projection, read through the established readReports helper
 * (#1688). DO mas_reports was rejected: per-login-instance
 * storage with no per-subscriber handle in the run-due route
 * context, so reading it would be wrong-instance content.
 *
 * Scoping (honest, stated): the reader is called with the
 * subscriber's recorded tenantId, and the projection read is
 * WHERE tenant_id = ? — a subscriber whose tenantId matches no
 * seeded tenant gets [], never another tenant's rows. The pool
 * is tenant-level (the projection carries no per-user owner
 * column), matching the existing /api/reports/list surface,
 * which serves the same projection to any signed-in tenant
 * user; delivery stays per-subscriber (opt-in enumeration +
 * recorded email + send-time opt-out re-check). This module
 * never touches DO storage and never invents content: no
 * windowed reports → [] → the pass honestly skips.
 *
 * Availability caveat: the projection is populated ONLY by the
 * platform-admin seed (#1688). An unseeded tenant honestly
 * skips until seeded; that is a content gap, not a provider
 * failure, and the pass records it as empty-skipped.
 *
 * Window: reports created since the start of the previous UTC
 * day. The pass fires once per UTC day on the first tick after
 * midnight, so the window is "since the previous digest day".
 * Reader failures propagate: the pass records items-failed for
 * that subscriber and continues with the rest.
 */
export interface DigestHighlightRow {
  title: string;
  summary: string;
  createdAtMs: number;
}

/** Cap on a single highlight's summary in the digest line (chars). */
export const DIGEST_HIGHLIGHT_SUMMARY_MAX = 280;

/**
 * Start of the previous UTC day for nowMs (00:00 UTC yesterday).
 * Pure and exported for tests.
 */
export function digestWindowStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
}

/** One digest line per report: title, plus a capped summary. */
export function formatDigestHighlight(row: DigestHighlightRow): string {
  if (!row.summary) return row.title;
  const summary =
    row.summary.length > DIGEST_HIGHLIGHT_SUMMARY_MAX
      ? `${row.summary.slice(0, DIGEST_HIGHLIGHT_SUMMARY_MAX)}…`
      : row.summary;
  return `${row.title}: ${summary}`;
}

/**
 * Windowed recent highlights, newest first. Pure: the window and
 * the ordering are testable without any store.
 */
export function buildDigestHighlights(
  rows: DigestHighlightRow[],
  nowMs: number,
): string[] {
  const start = digestWindowStartMs(nowMs);
  return [...rows]
    .filter((row) => row.createdAtMs >= start)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map(formatDigestHighlight);
}

/** Tenant-scoped projection read (null when the store is unbound). */
export type DigestReportReader = (
  tenantId: string,
) => Promise<DigestHighlightRow[] | null>;

/**
 * The tick's itemsProvider. The userId is intentionally unused:
 * scoping is by the subscriber's tenantId, which is the key the
 * projection read is scoped on. Null reader → [] (skip);
 * reader throw → propagates (pass records items-failed).
 */
export function createDigestContentProvider(
  readReports: DigestReportReader,
  nowMs: () => number = Date.now,
): (userId: string, tenantId: string) => Promise<string[]> {
  return async (_userId: string, tenantId: string): Promise<string[]> => {
    const rows = await readReports(tenantId);
    if (!rows) return [];
    return buildDigestHighlights(rows, nowMs());
  };
}
