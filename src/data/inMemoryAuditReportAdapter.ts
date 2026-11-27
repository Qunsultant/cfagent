/**
 * Issue #1688 ([AGENTIC] Slice 3) — in-memory test double for
 * the audit + report store. Same port semantics as the D1
 * adapter: replay of the same audit event id is a no-op;
 * replay of the same (tenant, report, version) is a no-op;
 * latest-per-report wins for reads; tenant scoping is
 * enforced on every method. Not a production store.
 */
import type {
  AuditEventRow,
  AuditReportStore,
  CanonicalReportRow,
} from "./auditReportPorts";

export class InMemoryAuditReportAdapter implements AuditReportStore {
  private readonly auditRows: AuditEventRow[] = [];
  private readonly reportRows: CanonicalReportRow[] = [];

  async recordAuditEvent(row: AuditEventRow): Promise<void> {
    if (!this.auditRows.some((r) => r.id === row.id)) {
      this.auditRows.push({ ...row });
    }
  }

  async listAuditForChain(
    tenantId: string,
    chainId: string,
  ): Promise<AuditEventRow[]> {
    return newestFirst(
      this.auditRows.filter(
        (r) => r.tenantId === tenantId && r.chainId === chainId,
      ),
    );
  }

  async listAuditForTenant(tenantId: string): Promise<AuditEventRow[]> {
    return newestFirst(
      this.auditRows.filter((r) => r.tenantId === tenantId),
    );
  }

  async recordReport(row: CanonicalReportRow): Promise<void> {
    const exists = this.reportRows.some(
      (r) =>
        r.tenantId === row.tenantId &&
        r.reportId === row.reportId &&
        r.version === row.version,
    );
    if (!exists) this.reportRows.push({ ...row });
  }

  async latestReport(
    tenantId: string,
    reportId: string,
  ): Promise<CanonicalReportRow | null> {
    const matches = this.reportRows.filter(
      (r) => r.tenantId === tenantId && r.reportId === reportId,
    );
    if (matches.length === 0) return null;
    return { ...matches.reduce((a, b) => (b.version > a.version ? b : a)) };
  }

  async listReports(
    tenantId: string,
    opts?: { userLogin?: string; limit?: number; source?: string },
  ): Promise<CanonicalReportRow[]> {
    const byId = new Map<string, CanonicalReportRow>();
    for (const row of this.reportRows.filter(
      (r) =>
        r.tenantId === tenantId &&
        (!opts?.userLogin || r.userLogin === opts.userLogin) &&
        (!opts?.source || r.source === opts.source),
    )) {
      const current = byId.get(row.reportId);
      if (!current || row.version > current.version) {
        byId.set(row.reportId, row);
      }
    }
    return [...byId.values()]
      .map((r) => ({ ...r }))
      .sort(
        (a, b) =>
          b.updatedAtMs - a.updatedAtMs || a.reportId.localeCompare(b.reportId),
      )
      .slice(0, Math.max(1, opts?.limit ?? 100));
  }

  /**
   * Issue #6101 (step 8) — token substring search over
   * title/summary/body, same match set as the D1 adapter's LIKE
   * groups (SQLite LIKE is ASCII case-insensitive).
   */
  async searchReports(
    tenantId: string,
    tokens: string[],
    opts?: { userLogin?: string; limit?: number },
  ): Promise<CanonicalReportRow[]> {
    if (tokens.length === 0) return [];
    const lowered = tokens.map((t) => t.toLowerCase());
    const matches = this.reportRows.filter(
      (r) =>
        r.tenantId === tenantId &&
        (!opts?.userLogin || r.userLogin === opts.userLogin) &&
        lowered.some((t) =>
          [r.title, r.summary, r.body].some((field) =>
            field.toLowerCase().includes(t),
          ),
        ),
    );
    return latestPerReportInMemory(matches).slice(0, Math.max(1, opts?.limit ?? 100));
  }

  /** Issue #6101 (step 8) — newest version for a generation id, or null. */
  async latestReportByGeneration(
    tenantId: string,
    generationId: string,
    userLogin?: string,
  ): Promise<CanonicalReportRow | null> {
    const matches = this.reportRows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.generationId === generationId &&
        (!userLogin || r.userLogin === userLogin),
    );
    if (matches.length === 0) return null;
    return { ...matches.reduce((a, b) => (b.version > a.version ? b : a)) };
  }

  /** Issue #6101 (step 8) — newest row for a run id, or null. */
  async latestReportByRunId(
    tenantId: string,
    runId: string,
    userLogin?: string,
  ): Promise<CanonicalReportRow | null> {
    const matches = this.reportRows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.runId === runId &&
        (!userLogin || r.userLogin === userLogin),
    );
    if (matches.length === 0) return null;
    return {
      ...matches.reduce((a, b) =>
        b.createdAtMs > a.createdAtMs ||
        (b.createdAtMs === a.createdAtMs && b.version > a.version)
          ? b
          : a,
      ),
    };
  }

  async deleteReport(tenantId: string, reportId: string): Promise<void> {
    for (let i = this.reportRows.length - 1; i >= 0; i -= 1) {
      const row = this.reportRows[i];
      if (row.tenantId === tenantId && row.reportId === reportId) {
        this.reportRows.splice(i, 1);
      }
    }
  }
}

function newestFirst(rows: AuditEventRow[]): AuditEventRow[] {
  return [...rows]
    .map((r) => ({ ...r }))
    .sort(
      (a, b) => b.occurredAtMs - a.occurredAtMs || a.id.localeCompare(b.id),
    );
}

/** Latest row per report, newest first — mirrors the D1 adapter. */
function latestPerReportInMemory(rows: CanonicalReportRow[]): CanonicalReportRow[] {
  const byId = new Map<string, CanonicalReportRow>();
  for (const row of rows) {
    const current = byId.get(row.reportId);
    if (!current || row.version > current.version) {
      byId.set(row.reportId, row);
    }
  }
  return [...byId.values()]
    .map((r) => ({ ...r }))
    .sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || a.reportId.localeCompare(b.reportId),
    );
}
