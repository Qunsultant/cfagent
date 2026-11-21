import { describe, expect, it } from "vitest";
import { previewFeedArtifact } from "../src/agents/routes/dataProviders";
import type { FeedDatasetArtifact } from "../src/data/feedDatasetPorts";

function artifact(over: Partial<FeedDatasetArtifact>): FeedDatasetArtifact {
  return {
    id: "artifact-1",
    jobId: "quotes-alpha",
    sourceId: "source-a",
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "symbols", symbols: ["AAA"], label: "test", snapshotDate: null, sourceLabel: null, size: 1 },
    providerId: "source-a",
    asOf: "2026-11-21T00:00:00.000Z",
    quotes: [],
    run: {
      runId: "run-1",
      trigger: "manual",
      kind: "original",
      startedAt: "2026-11-21T00:00:00.000Z",
      finishedAt: "2026-11-21T00:00:01.000Z",
      status: "completed",
      requested: 1,
      received: 1,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    createdAt: "2026-11-21T00:00:01.000Z",
    ...over,
  };
}

describe("issue #6048 — bounded feed-artifact preview", () => {
  it("previews quotes and caps the sample", () => {
    const quotes = Array.from({ length: 40 }, (_, i) => ({ symbol: `S${i}` }));
    const preview = previewFeedArtifact(
      artifact({ quotes: quotes as unknown as FeedDatasetArtifact["quotes"] }),
      10,
    );
    expect(preview.dataset).toBe("quotes");
    expect(preview.rows).toBe(40);
    expect(preview.sample).toHaveLength(10);
  });

  it("previews each dataset family without inventing rows", () => {
    const fundamentals = previewFeedArtifact(
      artifact({
        dataset: "fundamentals",
        fundamentals: [{ symbol: "AAA", fundamentals: {} }] as unknown as FeedDatasetArtifact["fundamentals"],
      }),
      20,
    );
    expect(fundamentals.dataset).toBe("fundamentals");
    expect(fundamentals.rows).toBe(1);

    const sentiment = previewFeedArtifact(
      artifact({
        dataset: "sentiment",
        sentiment: [{ symbol: "AAA", sentiment: {} }] as unknown as FeedDatasetArtifact["sentiment"],
      }),
      20,
    );
    expect(sentiment.dataset).toBe("sentiment");

    const empty = previewFeedArtifact(artifact({ dataset: "unknown", quotes: [] }), 20);
    expect(empty).toEqual({ dataset: "unknown", rows: 0, sample: [] });
  });

  it("caps a caller's limit at the maximum", () => {
    const quotes = Array.from({ length: 200 }, (_, i) => ({ symbol: `S${i}` }));
    const preview = previewFeedArtifact(
      artifact({ quotes: quotes as unknown as FeedDatasetArtifact["quotes"] }),
      1000,
    );
    expect(preview.sample).toHaveLength(100);
  });
});
