// @vitest-environment node
/**
 * Issue #4002 (recording slice): a feed-run row's Workflow Runs
 * LIST title carries the feed job id it executed — the route
 * takes only a provider id and forSource() returns the first
 * registered job for that source, so the title names the job the
 * run actually was (quotes), not just the provider. Without
 * this, the three failed rows (two Yahoo, one Public) all read
 * identically as "POST /data-providers/<provider>/feed-run"
 * with no job id anywhere on the list.
 *
 * Pins httpRequestRunIdentity (the title derivation used by
 * runFromJobs):
 * - a Yahoo feed-run row titles "POST /data-providers/yahoo/feed-run
 *   — yahoo-nasdaq100-quotes" (and Public likewise);
 * - the branch fires even though the row already carries a
 *   "METHOD path" display name (like the market-data/ad
 *   branches, unlike the generic fallback);
 * - an unregistered provider falls through to the existing
 *   behaviour (title = display name), never an invented id;
 * - a non-feed-run row is untouched.
 */
import { describe, expect, it } from "vitest";

import {
  buildWorkflowRuns,
  httpRequestRunIdentity,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";

function httpJob(over: Partial<WorkflowRunJobRow> & { payload: Record<string, unknown> }): WorkflowRunJobRow {
  const { payload, ...rest } = over;
  return {
    job_id: "job-1",
    capability: "http.request",
    display_name: "",
    status: "failed",
    created_at: "2026-11-10T10:00:00.000Z",
    ...rest,
    payload_json: JSON.stringify(payload),
  } as WorkflowRunJobRow;
}

function feedRunJob(provider: string): WorkflowRunJobRow {
  return httpJob({
    job_id: `feed-run-${provider}`,
    // The row as the substrate stores it: a "METHOD path"
    // display name, no job id anywhere.
    display_name: `POST /data-providers/${provider}/feed-run`,
    payload: {
      method: "POST",
      pathAndQuery: `/data-providers/${provider}/feed-run`,
      headers: {},
      body: "{}",
    },
  });
}

describe("feed-run list titles carry the feed job id (#4002)", () => {
  it("a Yahoo feed-run row titles with yahoo-nasdaq100-quotes", () => {
    const runs = buildWorkflowRuns({ jobs: [feedRunJob("yahoo")], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("POST /data-providers/yahoo/feed-run — yahoo-nasdaq100-quotes");
  });

  it("a Public feed-run row titles with public-nasdaq100-quotes", () => {
    const runs = buildWorkflowRuns({ jobs: [feedRunJob("public")], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("POST /data-providers/public/feed-run — public-nasdaq100-quotes");
  });

  it("an unregistered provider falls through to the display name — never an invented id", () => {
    const job = feedRunJob("nope");
    expect(httpRequestRunIdentity(job)).toBeNull();
    const runs = buildWorkflowRuns({ jobs: [job], outcomes: [], transitions: [] });
    expect(runs[0].title).toBe("POST /data-providers/nope/feed-run");
  });

  it("a non-feed-run row is untouched", () => {
    const job = httpJob({
      job_id: "cmp-1",
      display_name: "POST /market-data/compare",
      payload: {
        method: "POST",
        pathAndQuery: "/market-data/compare",
        body: JSON.stringify({ symbols: ["MSFT", "TSLA"] }),
      },
    });
    expect(httpRequestRunIdentity(job)?.title).toBe("Market data comparison — MSFT, TSLA");
  });
});
