/**
 * Issue #2964 — the in-memory implementation of the job-run-record
 * port, with semantics identical to the DO-SQLite adapter (insert,
 * per-job prune to the cap, newest-first reads with a stable
 * insertion tiebreak for same-millisecond runs).
 */
import {
  JOB_RUN_RECORDS_PER_JOB_CAP,
  type JobRunRecord,
  type JobRunRecordStore,
} from "./jobRunRecordPorts";

export class InMemoryJobRunRecordStore implements JobRunRecordStore {
  private records: Array<JobRunRecord & { seq: number }> = [];
  private seq = 0;

  record(record: JobRunRecord): void {
    this.records.push({ ...record, seq: this.seq++ });
    const perJob = this.records.filter((r) => r.jobId === record.jobId);
    if (perJob.length > JOB_RUN_RECORDS_PER_JOB_CAP) {
      const keep = new Set(
        perJob
          .slice()
          .sort((a, b) => (b.started < a.started ? -1 : b.started > a.started ? 1 : b.seq - a.seq))
          .slice(0, JOB_RUN_RECORDS_PER_JOB_CAP)
          .map((r) => r.seq),
      );
      this.records = this.records.filter((r) => r.jobId !== record.jobId || keep.has(r.seq));
    }
  }

  listByJob(jobId: string, limit = 50): JobRunRecord[] {
    return this.records
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => (b.started < a.started ? -1 : b.started > a.started ? 1 : b.seq - a.seq))
      .slice(0, Math.max(1, limit))
      .map(({ seq: _seq, ...record }) => record);
  }

  latestByJob(jobId: string): JobRunRecord | undefined {
    return this.listByJob(jobId, 1)[0];
  }

  listRecent(limit = 50): JobRunRecord[] {
    return this.records
      .slice()
      .sort((a, b) => (b.started < a.started ? -1 : b.started > a.started ? 1 : b.seq - a.seq))
      .slice(0, Math.max(1, limit))
      .map(({ seq: _seq, ...record }) => record);
  }
}
