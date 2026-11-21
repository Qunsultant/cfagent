import { describe, expect, it } from "vitest";
import { FEEDS_FAMILY, storedIndexFeedJobs } from "../src/client/feedsFamily";
import type { DataProvidersList, FeedJobView } from "../src/client/dataProvidersApi";

function job(over: Partial<FeedJobView> & Pick<FeedJobView, "jobId" | "sourceId">): FeedJobView {
  return {
    dataset: "quotes",
    label: over.jobId,
    feed: null,
    pipeline: null,
    nextScheduledRun: null,
    ...over,
  };
}

function list(jobs: FeedJobView[][]): DataProvidersList {
  return {
    providers: jobs.map((feedJobs) => ({ feedJobs } as unknown as DataProvidersList["providers"][number])),
    routes: [],
  } as DataProvidersList;
}

describe("issue #6048 — the stored-index feed family projection", () => {
  it("keeps only jobs the catalog marks with the family", () => {
    const data = list([
      [
        job({ jobId: "quotes-alpha", sourceId: "source-a", family: FEEDS_FAMILY }),
        job({ jobId: "quotes-wide", sourceId: "source-a" }),
      ],
      [job({ jobId: "quotes-beta", sourceId: "source-b", family: FEEDS_FAMILY })],
    ]);
    expect(storedIndexFeedJobs(data).map((j) => j.jobId)).toEqual([
      "quotes-alpha",
      "quotes-beta",
    ]);
  });

  it("does not invent family membership from a job id pattern", () => {
    const data = list([[job({ jobId: "quotes-alpha", sourceId: "source-a" })]]);
    expect(storedIndexFeedJobs(data)).toEqual([]);
  });

  it("sorts by job id so the table is stable across provider order", () => {
    const a = job({ jobId: "sentiment-alpha", sourceId: "source-a", family: FEEDS_FAMILY });
    const b = job({ jobId: "universe-alpha", sourceId: "source-c", family: FEEDS_FAMILY });
    expect(storedIndexFeedJobs(list([[a], [b]])).map((j) => j.jobId)).toEqual([
      "sentiment-alpha",
      "universe-alpha",
    ]);
  });
});
