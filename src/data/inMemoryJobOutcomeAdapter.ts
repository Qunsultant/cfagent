/**
 * Issue #2356 (#1976 step 4c) — the in-memory implementation
 * of the job-outcome port, with semantics identical to the
 * DO-SQLite adapter (upsert-merge, age + cap prune, the
 * daily watermark).
 */
import {
  JOB_OUTCOMES_KEEP_ROWS,
  JOB_OUTCOMES_PRUNE_INTERVAL_MS,
  JOB_OUTCOMES_RETENTION_DEFAULT_DAYS,
  type JobOutcomeInput,
  type JobOutcomeRow,
  type JobOutcomeStore,
  type PruneJobOutcomesOptions,
  type PruneJobOutcomesResult,
} from "./jobOutcomePorts";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

function resolveDays(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : JOB_OUTCOMES_RETENTION_DEFAULT_DAYS;
}

export class InMemoryJobOutcomeStore implements JobOutcomeStore {
  private rows = new Map<string, JobOutcomeRow>();
  private prunedAt: string | null = null;
  // #3515 S3 batch 7 — optional sink injection (d1QueryLogger precedent);
  // env-constructed sink from the composition root when it holds env,
  // else the structured console fallback (never a `{}` sink, #5587).
  private readonly log: StructuredLogger;
  constructor(options?: { sink?: ObservabilitySink }) {
    this.log = createStructuredLogger(
      options?.sink ?? new ConsoleObservabilitySink(),
      { component: "data/inMemoryJobOutcomeAdapter" },
    );
  }

  ensureTables(): void {
    // In-memory: nothing to ensure.
  }

  record(input: JobOutcomeInput): JobOutcomeRow {
    const now = new Date().toISOString();
    const prev = this.rows.get(input.id);
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
    this.rows.set(merged.id, structuredClone(merged));
    return merged;
  }

  prune(options: PruneJobOutcomesOptions = {}): PruneJobOutcomesResult {
    const days = resolveDays(options.retentionDays);
    const keep = Math.max(1, Math.floor(options.keepRows ?? JOB_OUTCOMES_KEEP_ROWS));
    let deletedByAge = 0;
    if (days > 0) {
      const cutoff = new Date((options.now?.() ?? Date.now()) - days * 86_400_000).toISOString();
      for (const [id, row] of this.rows) {
        if (row.createdAt < cutoff) {
          this.rows.delete(id);
          deletedByAge += 1;
        }
      }
    }
    let deletedByCap = 0;
    if (this.rows.size > keep) {
      const oldestFirst = [...this.rows.values()].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
      for (const row of oldestFirst.slice(0, this.rows.size - keep)) {
        this.rows.delete(row.id);
        deletedByCap += 1;
      }
    }
    return { deletedByAge, deletedByCap };
  }

  maybePrune(nowMs: number = Date.now()): boolean {
    const last = this.prunedAt ? Date.parse(this.prunedAt) : Number.NaN;
    if (Number.isFinite(last) && nowMs - last < JOB_OUTCOMES_PRUNE_INTERVAL_MS) {
      return false;
    }
    try {
      this.prune({ now: () => nowMs });
    } catch (err) {
      this.log.warn("inMemoryJobOutcomeAdapter.prune_failed", {
        message: "[job-outcomes] prune failed:",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    this.prunedAt = new Date(nowMs).toISOString();
    return true;
  }

  countRows(): number {
    return this.rows.size;
  }

  clearRows(): void {
    // The prune watermark (prunedAt) is preserved, mirroring
    // the DO adapter's meta-table preservation.
    this.rows.clear();
  }

  list(limit = 50): JobOutcomeRow[] {
    this.maybePrune();
    return [...this.rows.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
