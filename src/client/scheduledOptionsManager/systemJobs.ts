/**
 * Issue #5880 — the system-job maps are DERIVED from the one
 * externalized job catalogue (`config/job-catalogue.json`, read
 * through `src/config/jobCatalogue.ts`), not a second hardcoded list.
 *
 * The create form used to offer its 3 jobs from a hardcoded
 * `CreatableJob` union, a hardcoded `JOB_CALLBACKS` map, and a second
 * hardcoded `SYSTEM_JOBS` / `TRIGGER_ROUTES` map that also named the
 * per-callback trigger routes. All three now derive from the
 * catalogue: `JOB_CALLBACKS` is the form-job → callback map for the
 * entries carrying a `formJob`; `SYSTEM_JOBS` is the callback → info
 * map for the entries carrying a `triggerRoute` (its label is the
 * entry's `cardLabel` when one exists, else its `label`);
 * `TRIGGER_ROUTES` is the callback → trigger-route map built from
 * `SYSTEM_JOBS`, exactly as before. The exported names and values are
 * unchanged — only the source moved — and
 * `tests/job_catalogue_5880.test.ts` (5880-P04) pins all three to
 * their pre-#5880 values, so a catalogue edit that drops or renames
 * a form job fails loudly instead of silently narrowing the picker.
 *
 * Callbacks absent from `TRIGGER_ROUTES` (`sendScheduledReminder`,
 * `expireStaleOrderDraft`, `executeAsyncJob`, …) still have no
 * trigger route and render no Trigger control — a card's Trigger
 * always runs that card's own job, never a different one.
 */
import type { CreatableJob, SystemJobInfo } from "./types";
import { getJobCatalogue } from "../../config/jobCatalogue";

/**
 * The jobs with an on-demand trigger route, keyed by callback.
 * Built from the catalogue entries carrying a `triggerRoute` — the
 * catalogue validator requires those entries to carry a description,
 * so every value here is a complete `SystemJobInfo`.
 */
export const SYSTEM_JOBS: Record<string, SystemJobInfo> = Object.fromEntries(
  getJobCatalogue()
    .filter((job) => job.triggerRoute !== undefined)
    .map((job) => [
      job.callback as string,
      {
        label: job.cardLabel ?? job.label,
        description: job.description as string,
        triggerRoute: job.triggerRoute as string,
      },
    ]),
);

/**
 * Callback → its on-demand trigger route. Callbacks absent here
 * (sendScheduledReminder, expireStaleOrderDraft, executeAsyncJob, …)
 * have no trigger route and render no Trigger control — a card's
 * Trigger always runs that card's own job, never a different one.
 */
export const TRIGGER_ROUTES: Record<string, string> = Object.fromEntries(
  Object.entries(SYSTEM_JOBS).map(([callback, info]) => [callback, info.triggerRoute]),
);

export function systemJobFor(callback: unknown): SystemJobInfo | undefined {
  return typeof callback === "string" ? SYSTEM_JOBS[callback] : undefined;
}

export function triggerRouteFor(callback: unknown): string | undefined {
  return typeof callback === "string" ? TRIGGER_ROUTES[callback] : undefined;
}

/**
 * Form-job key → the SDK callback it arms. Built from the catalogue
 * entries carrying a `formJob` — the jobs the create form offers.
 */
export const JOB_CALLBACKS: Record<CreatableJob, string> = Object.fromEntries(
  getJobCatalogue()
    .filter((job) => job.formJob !== undefined)
    .map((job) => [job.formJob as string, job.callback as string]),
) as Record<CreatableJob, string>;
