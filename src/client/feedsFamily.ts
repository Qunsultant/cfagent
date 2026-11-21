/**
 * Issue #6048 — the stored-index feed family projection.
 *
 * Pure: the DataHub feeds view and its pins read this, so the family filter
 * is one function rather than a literal list in the component. Membership is
 * declared by the server catalog (`FeedPipelineCatalogEntry.family`), never
 * by a job-id pattern in the client.
 */
import type { DataProvidersList, FeedJobView } from "./dataProvidersApi";

/** The catalog family the feeds view renders. */
export const FEEDS_FAMILY = "index100";

/** Flatten the providers' feed jobs and keep the stored-index family, by job id. */
export function storedIndexFeedJobs(list: DataProvidersList): FeedJobView[] {
  const jobs: FeedJobView[] = [];
  for (const provider of list.providers) {
    for (const job of provider.feedJobs ?? []) {
      if (job.family === FEEDS_FAMILY) jobs.push(job);
    }
  }
  return jobs.sort((a, b) => a.jobId.localeCompare(b.jobId));
}
