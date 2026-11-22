import { describe, expect, it } from "vitest";
import { buildCatalogFeedJobSurfaceViews } from "../src/agents/routes/dataProviders";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import { FEED_PIPELINE_CATALOG } from "../src/services/feedPipelineJobs";

/**
 * Issue #6046 — an unbound/empty pipeline door must not render "no feed
 * jobs". The catalog knows which jobs exist; the dataset store knows what
 * each stored; pipeline-only fields stay honestly null.
 *
 * The test names no provider: it derives both the provider and the expected
 * count from the catalog, so it pins the contract, not a brand.
 */
describe("issue #6046 — the feed-jobs catalog fallback", () => {
  const registry = buildFeedJobRegistry({});
  const entry = FEED_PIPELINE_CATALOG[0];
  const providerId = entry.sourceId;
  const expected = FEED_PIPELINE_CATALOG.filter((row) => row.sourceId === providerId).length;

  it("lists every registered job for a provider, from the catalog", async () => {
    const rows = await buildCatalogFeedJobSurfaceViews({
      providerId,
      registry,
      datasetStore: null,
      nowMs: Date.now(),
    });
    expect(rows).toHaveLength(expected);
    expect(rows.every((row) => row.sourceId === providerId)).toBe(true);
    expect(rows.map((row) => row.jobId)).toContain(entry.jobId);
  });

  it("carries the catalog family through and keeps the universe job", async () => {
    const rows = await buildCatalogFeedJobSurfaceViews({
      providerId,
      registry,
      datasetStore: null,
      nowMs: Date.now(),
    });
    const familyEntry = FEED_PIPELINE_CATALOG.find((row) => row.family !== undefined);
    expect(familyEntry).toBeDefined();
    const row = rows.find((candidate) => candidate.jobId === familyEntry!.jobId);
    expect(row?.family).toBe(familyEntry!.family);

    const universeEntry = FEED_PIPELINE_CATALOG.find((candidate) => candidate.dataset === "universe");
    expect(universeEntry).toBeDefined();
    const universeRows = await buildCatalogFeedJobSurfaceViews({
      providerId: universeEntry!.sourceId,
      registry,
      datasetStore: null,
      nowMs: Date.now(),
    });
    const universe = universeRows.find((candidate) => candidate.jobId === universeEntry!.jobId);
    expect(universe).toBeDefined();
    expect(universe?.family).toBe(universeEntry!.family);
    expect(universe?.feed).toBeNull();
    expect(universe?.pipeline).toBeNull();
  });

  it("never fabricates a status it cannot read", async () => {
    const rows = await buildCatalogFeedJobSurfaceViews({
      providerId,
      registry,
      datasetStore: null,
      nowMs: Date.now(),
    });
    expect(rows.every((row) => row.feed === null && row.pipeline === null)).toBe(true);
    expect(rows.every((row) => row.schedule === null && row.nextScheduledRun === null)).toBe(true);
  });
});
