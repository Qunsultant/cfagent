/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the enrichment-run port: the legacy SqlEnrichmentStore
 * (issue #1888), moved verbatim into the data layer behind its
 * EXISTING port (src/enrichment/enrichmentPorts.ts).
 * src/enrichment/enrichmentStore.ts keeps the in-memory
 * adapter and re-exports this class.
 *
 * Adapter move only (step-2 audit §2.7): the class carries its
 * killswitch methods with it — same key, same fail-closed
 * read. Since step 4g (#2390) executed the G-7 ruling, the
 * killswitch read/write route through the dedicated settings
 * port (settingsReadPorts.ts; composed via
 * createSettingsPorts) instead of issuing mas_settings
 * statements here; the settings adapter owns the table. The
 * get-then-put and supersede-then-put pairs are NOT wrapped
 * in the transaction aspect (audit §4).
 */
import {
  ENRICHMENT_KILLSWITCH_KEY,
  parseKillswitchValue,
  summarizeEnrichmentQuality,
  type EnrichmentKillswitchState,
  type EnrichmentQualitySummary,
  type EnrichmentRunRecord,
  type EnrichmentRunStore,
} from "../enrichment/enrichmentPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";
import { createSettingsPort } from "./createSettingsPorts";
import type { SettingsPort } from "./settingsReadPorts";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

export interface EnrichmentSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export type EnrichmentAuditFn = (
  type: string,
  agent: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

const CREATE_RUNS_SQL = doTableSql("mas_enrichment_runs");
const CREATE_RUNS_INDEX_SQL = doIndexSql("idx_mas_enrichment_runs_job");

export class SqlEnrichmentStore implements EnrichmentRunStore {
  /** The settings port over the same handle (killswitch key only). */
  private readonly settings: SettingsPort;
  // #3515 S3 batch 7 — optional sink injection (d1QueryLogger precedent);
  // env-constructed sink from the composition root when it holds env,
  // else the structured console fallback (never a `{}` sink, #5587).
  private readonly log: StructuredLogger;
  constructor(
    private readonly sql: EnrichmentSqlExecutor,
    private readonly audit?: EnrichmentAuditFn,
    options?: { sink?: ObservabilitySink },
  ) {
    this.log = createStructuredLogger(
      options?.sink ?? new ConsoleObservabilitySink(),
      { component: "data/doSqliteEnrichmentAdapter" },
    );
    this.settings = createSettingsPort(sql);
  }

  ensureTables(): void {
    this.sql.exec(CREATE_RUNS_SQL);
    this.sql.exec(CREATE_RUNS_INDEX_SQL);
  }

  recordRun(run: EnrichmentRunRecord): void {
    this.ensureTables();
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_enrichment_runs.insert_run", {
      record: {
        id: run.id,
        created_at: run.createdAt,
        job_id: run.jobId,
        stage: run.stage,
        record_json: JSON.stringify(run),
      },
    });
  }

  listRuns(limit = 20): EnrichmentRunRecord[] {
    this.ensureTables();
    const rows = executeDoDml<Array<{ record_json: string }>>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_enrichment_runs.list_runs",
      { orderBy: "created_at DESC, id DESC", limit },
    );
    return rows.map((r) => JSON.parse(r.record_json) as EnrichmentRunRecord);
  }

  getRun(id: string): EnrichmentRunRecord | null {
    this.ensureTables();
    const row = executeDoDml<{ record_json: string } | null>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_enrichment_runs.get_run",
      { id },
    );
    if (row === null) return null;
    return JSON.parse(row.record_json) as EnrichmentRunRecord;
  }

  qualitySummary(limit = 200): EnrichmentQualitySummary {
    return summarizeEnrichmentQuality(this.listRuns(limit));
  }

  /** Fail-closed: an unreadable settings read reports halted. */
  getKillswitchState(): EnrichmentKillswitchState {
    try {
      const value = this.settings.get(ENRICHMENT_KILLSWITCH_KEY);
      if (value === null) return "clear";
      return parseKillswitchValue(value);
    } catch (err) {
      this.log.error("doSqliteEnrichmentAdapter.killswitch_read_failed", {
        message: "[Enrichment] Killswitch read failed; halting enrichment (fail-closed):",
        error: err instanceof Error ? err.message : String(err),
      });
      return "halted";
    }
  }

  setKillswitch(
    state: EnrichmentKillswitchState,
    setBy: string,
    reason: string,
  ): EnrichmentKillswitchState {
    this.settings.set(
      ENRICHMENT_KILLSWITCH_KEY,
      state === "halted" ? "on" : "off",
    );
    // Best-effort audit: never blocks an operator stop. The audit fn
    // is async (#6102: D1) — a rejection must not surface either, so
    // both the sync throw and the async rejection land in the same
    // ignored-error log.
    const auditFailed = (err: unknown) => {
      this.log.error("doSqliteEnrichmentAdapter.killswitch_audit_failed", {
        message: "[Enrichment] Killswitch audit failed (ignored):",
        error: err instanceof Error ? err.message : String(err),
        state,
        setBy,
        reason,
      });
    };
    try {
      void Promise.resolve(
        this.audit?.("enrichment.killswitch", "enrichment", {
          state,
          setBy,
          reason,
        }),
      ).catch(auditFailed);
    } catch (err) {
      auditFailed(err);
    }
    return state;
  }
}
