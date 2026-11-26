/**
 * Issue #5880 — the catalogue's ids resolve through the reused ID
 * resolution work: one reader, so schedules, workflows and queues
 * never disagree about which job they mean.
 *
 * No new id scheme is invented here. The resolution order is the
 * work the schedules programme already built:
 * - `declaredTaskIdOf` (`src/services/unifiedScheduleManagement.ts`,
 *   #4351): a code-declared task is identified by its TASK id (the id
 *   `getScheduledTasks()` declares it under), never by the SDK alarm
 *   id. A declared task whose TASK id is a catalogue id IS that
 *   catalogue job; any other declared task is a user Think task, not
 *   a catalogue job.
 * - The callback: the SDK callback a schedule runs under names its
 *   catalogue entry (`jobCatalogueEntryForCallback`).
 * - The operation: a goal/planner operation names its catalogue
 *   entry (`jobCatalogueEntryForOperation`).
 * - The record id: a record's id is the list id
 *   (`unifiedScheduleManagement.ts:1140-1146`) — a stored system
 *   record resolves by its record id even when the value carries
 *   no callback, and pause stores the record under
 *   `recordId = declaredTaskId ?? id` (`:1376-1380`).
 *
 * Dedupe still lives where it lived: `canonicalJson` /
 * `canonicalJsonWithoutProvenance` (`src/services/scheduleDedupe.ts`,
 * #2071 / #3121 S1) compare same callback, same payload
 * (order-insensitive), same cadence, with provenance never
 * participating. This reader resolves the job id; the dedupe
 * comparison then runs on the resolved job, so two submissions of
 * the same catalogue job with the same criteria and cadence are
 * duplicates regardless of who created them or when.
 *
 * Server-side only: this module imports the management service, so
 * the client bundle must not import it — the client reads the
 * catalogue through `src/config/jobCatalogue.ts` instead.
 */
import { declaredTaskIdOf } from "./unifiedScheduleManagement";
import {
  jobCatalogueEntryForCallback,
  jobCatalogueEntryForId,
  jobCatalogueEntryForOperation,
} from "../config/jobCatalogue";

/** The shapes a schedule, alarm, record or goal definition arrives in. */
export type JobCatalogueIdValue =
  | { callback?: unknown; payload?: unknown; definition?: unknown; id?: unknown; operation?: unknown }
  | null
  | undefined;

/**
 * The catalogue id a value names, or null when it names no catalogue
 * job. One reader for every shape, so the declaration filter, the
 * pause/delete/resume paths, the list and the ledger can never
 * disagree about which job they mean.
 */
export function jobCatalogueIdOf(value: JobCatalogueIdValue): string | null {
  if (!value || typeof value !== "object") return null;
  // A code-declared task, identified by its TASK id (#4351): when
  // that id is a catalogue id, the task IS that catalogue job.
  const declared = declaredTaskIdOf(
    value as { callback?: unknown; payload?: unknown; definition?: unknown },
  );
  if (declared && jobCatalogueEntryForId(declared)) return declared;
  const holder = value as {
    callback?: unknown;
    payload?: unknown;
    definition?: unknown;
    id?: unknown;
    operation?: unknown;
  };
  const definition =
    holder.definition && typeof holder.definition === "object"
      ? (holder.definition as { callback?: unknown; payload?: unknown; operation?: unknown })
      : holder;
  const callback = definition.callback ?? holder.callback;
  if (typeof callback === "string" && callback) {
    const byCallback = jobCatalogueEntryForCallback(callback);
    if (byCallback) return byCallback.id;
  }
  const operation = definition.operation ?? holder.operation;
  if (typeof operation === "string" && operation) {
    const byOperation = jobCatalogueEntryForOperation(operation);
    if (byOperation) return byOperation.id;
  }
  // A record's id is the list id: a stored system record resolves
  // by its record id even when the value carries no callback.
  const id = holder.id;
  if (typeof id === "string" && id) {
    const byId = jobCatalogueEntryForId(id);
    if (byId) return byId.id;
  }
  return null;
}
