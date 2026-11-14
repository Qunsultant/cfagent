/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the job-outcome port: the legacy src/services/
 * jobOutcomes.ts, moved into the data layer statement-for-
 * statement (both tables, audit R-9). The service module is
 * now a re-export shim over this adapter and jobOutcomePorts.
 */
import {
  JOB_OUTCOMES_KEEP_ROWS,
  JOB_OUTCOMES_PRUNE_INTERVAL_MS,
  JOB_OUTCOMES_RETENTION_DEFAULT_DAYS,
  type JobOutcomeInput,
  type JobOutcomeRow,
  type JobOutcomeSqlExecutor,
  type JobOutcomeStore,
  type PruneJobOutcomesOptions,
  type PruneJobOutcomesResult,
} from "./jobOutcomePorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

function rowFromRecord(r: Record<string, any>): JobOutcomeRow {
  let deliveryStates: Record<string, string> = {};
  try {
    deliveryStates = r.delivery_json ? JSON.parse(String(r.delivery_json)) : {};
  } catch {
    deliveryStates = {};
  }
  return {
    id: String(r.id),
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    scanned: r.scanned ?? null,
    matched: r.matched ?? null,
    codedError: r.coded_error ?? null,
    reportUrl: r.report_url ?? null,
    pdfKey: r.pdf_key ?? null,
    xlsxKey: r.xlsx_key ?? null,
    csvKey: r.csv_key ?? null,
    deliveryStates,
    origin: r.origin,
    createdAt: r.created_at,
  };
}

function resolveDays(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : JOB_OUTCOMES_RETENTION_DEFAULT_DAYS;
}

export class DoSqliteJobOutcomeStore implements JobOutcomeStore {
  constructor(private readonly sql: JobOutcomeSqlExecutor) {}

  ensureTables(): void {
    this.sql.exec(doTableSql("mas_job_outcomes"));
    // The feed orders by created_at and the prune filters on it; without this
    // index every list call scans the whole table (see #2280).
    this.sql.exec(doIndexSql("idx_mas_job_outcomes_created"));
  }

  private ensureMetaTable(): void {
    this.sql.exec(
      doTableSql("mas_job_outcomes_meta")
    );
  }

  private countOutcomes(): number {
    const rows = Array.from(
      this.sql.exec("SELECT COUNT(*) AS count FROM mas_job_outcomes")
    ) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  record(input: JobOutcomeInput): JobOutcomeRow {
    this.ensureTables();
    const now = new Date().toISOString();
    const existing = Array.from(
      this.sql.exec("SELECT * FROM mas_job_outcomes WHERE id = ?", input.id)
    )[0] as Record<string, any> | undefined;
    const prev = existing ? rowFromRecord(existing) : undefined;
    const merged: JobOutcomeRow = {
      id: input.id,
      kind: input.kind,
      trigger: input.trigger,
      status: input.status,
      scanned: input.scanned ?? prev?.scanned ?? null,
      matched: input.matched ?? prev?.matched ?? null,
      codedError:
        input.codedError ?? (input.status === "completed" || input.status === "partial" ? null : prev?.codedError ?? null),
      reportUrl: input.reportUrl ?? prev?.reportUrl ?? null,
      pdfKey: input.pdfKey ?? prev?.pdfKey ?? null,
      xlsxKey: input.xlsxKey ?? prev?.xlsxKey ?? null,
      csvKey: input.csvKey ?? prev?.csvKey ?? null,
      deliveryStates: { ...(prev?.deliveryStates ?? {}), ...(input.deliveryStates ?? {}) },
      origin: input.origin,
      createdAt: input.createdAt ?? prev?.createdAt ?? now,
    };
    this.sql.exec(
      "INSERT OR REPLACE INTO mas_job_outcomes (id, kind, trigger, status, scanned, matched, coded_error, report_url, pdf_key, xlsx_key, csv_key, delivery_json, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      merged.id,
      merged.kind,
      merged.trigger,
      merged.status,
      merged.scanned,
      merged.matched,
      merged.codedError,
      merged.reportUrl,
      merged.pdfKey,
      merged.xlsxKey,
      merged.csvKey,
      JSON.stringify(merged.deliveryStates),
      merged.origin,
      merged.createdAt
    );
    return merged;
  }

  prune(options: PruneJobOutcomesOptions = {}): PruneJobOutcomesResult {
    this.ensureTables();
    const days = resolveDays(options.retentionDays);
    const keep = Math.max(1, Math.floor(options.keepRows ?? JOB_OUTCOMES_KEEP_ROWS));
    let deletedByAge = 0;

    if (days > 0) {
      const cutoff = new Date((options.now?.() ?? Date.now()) - days * 86_400_000).toISOString();
      const before = this.countOutcomes();
      this.sql.exec("DELETE FROM mas_job_outcomes WHERE created_at < ?", cutoff);
      deletedByAge = Math.max(0, before - this.countOutcomes());
    }

    const total = this.countOutcomes();
    let deletedByCap = 0;
    if (total > keep) {
      const ids = Array.from(
        this.sql.exec(
          "SELECT id FROM mas_job_outcomes ORDER BY created_at ASC LIMIT ?",
          total - keep
        )
      ) as Array<{ id: string }>;
      for (const row of ids) {
        this.sql.exec("DELETE FROM mas_job_outcomes WHERE id = ?", row.id);
        deletedByCap += 1;
      }
    }

    return { deletedByAge, deletedByCap };
  }

  maybePrune(nowMs: number = Date.now()): boolean {
    this.ensureMetaTable();
    const existing = Array.from(
      this.sql.exec("SELECT v FROM mas_job_outcomes_meta WHERE k = 'pruned_at'")
    ) as Array<{ v: string }>;
    const last = existing[0] ? Date.parse(existing[0].v) : Number.NaN;
    if (Number.isFinite(last) && nowMs - last < JOB_OUTCOMES_PRUNE_INTERVAL_MS) {
      return false;
    }
    try {
      this.prune({ now: () => nowMs });
    } catch (err) {
      console.warn(
        "[job-outcomes] prune failed:",
        err instanceof Error ? err.message : String(err)
      );
      return false;
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', ?)",
      new Date(nowMs).toISOString()
    );
    return true;
  }

  countRows(): number {
    return this.countOutcomes();
  }

  clearRows(): void {
    // Only the outcomes table: the meta watermark row
    // (mas_job_outcomes_meta 'pruned_at') is preserved.
    this.sql.exec("DELETE FROM mas_job_outcomes");
  }

  list(limit = 50): JobOutcomeRow[] {
    this.ensureTables();
    this.maybePrune();
    const rows = Array.from(
      this.sql.exec("SELECT * FROM mas_job_outcomes ORDER BY created_at DESC LIMIT ?", limit)
    ) as Array<Record<string, any>>;
    return rows.map(rowFromRecord);
  }
}
