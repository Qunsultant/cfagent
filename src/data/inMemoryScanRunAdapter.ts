/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the scan-run port, with semantics identical to the DO-SQLite
 * adapter: for tests and for contexts with no Durable Object
 * storage handle. Moved into the data layer from
 * src/trading/options/scanRunStore.ts (now a re-export shim).
 */
import type { OpportunityScanResult } from "../trading";
import {
  SCAN_RUN_MAX_ROWS,
  SCAN_RUN_RETENTION_DAYS,
  visibleToCaller,
  type ScanRunStore,
  type ScanRunStoreOptions,
  type ScanRunSummary,
  type StoredScanRun,
  normalizeScanRunBroker,
  normalizeScanRunLinkage,
  type LedgerLinkage,
  type ScanRunBroker,
} from "./scanRunPorts";

function summarize(
  id: string,
  result: OpportunityScanResult,
  userLogin?: string,
  trigger?: "manual" | "scheduled",
  broker?: ScanRunBroker,
  linkage?: { scheduleId: string | null; asyncJobId: string | null; workflowId: string | null },
): ScanRunSummary {
  return {
    id,
    generatedAt: result.generatedAt,
    mode: result.mode,
    modelVersion: result.modelVersion,
    gate: result.gate,
    coverage: result.coverage,
    profileRef: result.profileRef ?? null,
    pdfKey: result.pdfKey ?? null,
    xlsxKey: result.xlsxKey ?? null,
    csvKey: result.csvKey ?? null,
    partial: result.partial ?? null,
    // Issue #3264: same trigger-through-summary_json rule as the
    // DO-SQLite adapter — no migration, older rows lack the field.
    ...(trigger ? { trigger } : {}),
    // Issue #3327: provenance rides inside the summary object.
    broker: normalizeScanRunBroker(broker),
    ...(userLogin !== undefined ? { userLogin } : {}),
    // Issue #3314: same §4 linkage rule as the DO-SQLite adapter —
    // stamped only when the caller passed a linkage.
    ...(linkage
      ? {
          scheduleId: linkage.scheduleId,
          asyncJobId: linkage.asyncJobId,
          workflowId: linkage.workflowId,
        }
      : {}),
  };
}

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/** Newest-first ordering: generatedAt descending, id descending
 *  on ties (matches the SQL ORDER BY exactly). */
function byNewestFirst(a: ScanRunSummary, b: ScanRunSummary): number {
  if (a.generatedAt !== b.generatedAt) return a.generatedAt < b.generatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export class InMemoryScanRunStore implements ScanRunStore {
  private runs: StoredScanRun[] = [];
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(options: ScanRunStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? SCAN_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? SCAN_RUN_MAX_ROWS;
  }

  async save(
    result: OpportunityScanResult,
    options: {
      userLogin?: string;
      id?: string;
      trigger?: "manual" | "scheduled";
      broker?: ScanRunBroker;
      linkage?: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId">;
    } = {},
  ): Promise<StoredScanRun> {
    // Issue #3314: same linkage rule as the DO-SQLite adapter —
    // normalized once, stamped only when the caller passed one.
    const linkage =
      options.linkage !== undefined ? normalizeScanRunLinkage(options.linkage) : undefined;
    const run: StoredScanRun = {
      ...summarize(options.id ?? this.idFactory(), result, options.userLogin, options.trigger, options.broker, linkage),
      result,
    };
    this.runs.push(run);
    await this.prune(new Date(result.generatedAt));
    return run;
  }

  async list(
    options: { limit?: number; offset?: number; userLogin?: string; broker?: ScanRunBroker } = {},
  ): Promise<ScanRunSummary[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return [...this.runs]
      .filter((r) => visibleToCaller(r, options.userLogin))
      .filter((r) => (options.broker ? normalizeScanRunBroker(r.broker) === options.broker : true))
      .sort(byNewestFirst)
      .slice(offset, offset + limit)
      .map(({ result: _result, ...summary }) => summary);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredScanRun | null> {
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return null;
    return run;
  }

  async updatePdfKey(id: string, pdfKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!pdfKey) return false;
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return false;
    run.pdfKey = pdfKey;
    run.result = { ...run.result, pdfKey };
    return true;
  }

  async updateXlsxKey(id: string, xlsxKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!xlsxKey) return false;
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return false;
    run.xlsxKey = xlsxKey;
    run.result = { ...run.result, xlsxKey };
    return true;
  }

  async updateCsvKey(id: string, csvKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!csvKey) return false;
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return false;
    run.csvKey = csvKey;
    run.result = { ...run.result, csvKey };
    return true;
  }

  async updateLedgerLinkage(
    id: string,
    linkage: Pick<LedgerLinkage, "scheduleId" | "asyncJobId" | "workflowId">,
    options: { userLogin?: string } = {},
  ): Promise<boolean> {
    // Issue #3314: same backfill contract as the DO-SQLite adapter —
    // the result carries no linkage, so only the summary moves.
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return false;
    const clean = normalizeScanRunLinkage(linkage);
    run.scheduleId = clean.scheduleId;
    run.asyncJobId = clean.asyncJobId;
    run.workflowId = clean.workflowId;
    return true;
  }

  async prune(now: Date): Promise<number> {
    const cutoff = retentionCutoff(now, this.retentionDays);
    const kept = [...this.runs]
      .sort(byNewestFirst)
      .filter((r) => r.generatedAt >= cutoff)
      .slice(0, this.maxRows);
    const deleted = this.runs.length - kept.length;
    this.runs = kept;
    return deleted;
  }
}
