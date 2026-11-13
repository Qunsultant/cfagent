/**
 * Issue #4360 — the in-memory JobStageEventStore: the tests-only double
 * for the consumer's persistence seam. Same contract as the DO adapter
 * (dedup on `eventKey`, list in recorded order); never wired into a
 * route or a consumer.
 */
import type { JobStageEventRecord, JobStageEventStore } from "./jobStageEventPorts";

export function createInMemoryJobStageEventStore(
  initial: JobStageEventRecord[] = [],
): JobStageEventStore {
  const rows: JobStageEventRecord[] = [...initial];
  const seen = new Set(initial.map((row) => row.eventKey));
  return {
    record: async (event) => {
      if (seen.has(event.eventKey)) return false;
      seen.add(event.eventKey);
      rows.push({ ...event });
      return true;
    },
    listByRun: async (runId) => rows.filter((row) => row.runId === runId).map((row) => ({ ...row })),
  };
}
