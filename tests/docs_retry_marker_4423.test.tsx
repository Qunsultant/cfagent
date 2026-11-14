// @vitest-environment jsdom
/**
 * Issue #4423 (Docs retry indistinguishability) — a retried chain is ONE Docs
 * row by design (the retry is idempotent with the original), so the row itself
 * must say a retry happened.
 *
 * Pins:
 *  - 4423-P01 the chain-row projection reads the retry lineage the rows
 *    persisted: `retryOf` from the payload, the attempt count from the
 *    history — and 0/absent on an original attempt (never a guess).
 *  - 4423-P02 a canonical options row carries `retriedShards` / `shardAttempts`
 *    into the run summary; a row that records neither keeps `retry` null, so
 *    "no retry" and "not recorded" stay distinguishable.
 *  - 4423-P03 the Docs row carries the lineage through untouched.
 *  - 4423-P04 Docs renders `Retry ×N` on a retried row, and no marker at all
 *    on an original run.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { chainRowsFromSql } from "../src/services/shardJobs";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { toDocumentRows } from "../src/client/docsAndReports";
import { DocsAndReportsPanel } from "../src/client/DocsAndReportsPanel";
import type { ScheduledReportHit } from "../src/services/scheduledReports";
import type { RunSummary } from "../src/services/runSummaries";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;

function chainSql(rows: Array<Record<string, unknown>>) {
  return { exec: () => rows } as never;
}

function reportHit(body: Record<string, unknown>): ScheduledReportHit {
  return {
    id: "rep-4423",
    runId: "options:chain-4423",
    title: "Options scanner — bullish (PDF)",
    source: "options_scanner",
    summary: "Sharded options screen",
    body: JSON.stringify(body),
    createdAt: "2026-11-14T12:00:00.000Z",
    generationId: "options:chain-4423:pdf",
    userLogin: "analyst",
  } as ScheduledReportHit;
}

function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    kind: "options_scanner",
    id: "rep-4423",
    runId: "options:chain-4423",
    title: "Options scanner — bullish (PDF)",
    summary: "Sharded options screen",
    trigger: "scheduled",
    createdAt: "2026-11-14T12:00:00.000Z",
    status: "completed",
    resultCount: 12,
    retry: null,
    pdfKey: "options:pdf:4423",
    reportUrl: "/api/options/report.pdf?key=options%3Apdf%3A4423",
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: "generated",
    pdfError: null,
    reportId: "rep-4423",
    scanRunId: null,
    discoveryRunId: null,
    source: "options_scanner",
    ...over,
  } as RunSummary;
}

describe("4423-P01 the chain rows carry their retry lineage", () => {
  it("reads retryOf from the payload and the attempt count from the history", () => {
    const rows = chainRowsFromSql(
      chainSql([
        {
          job_id: "shard-a",
          stage: "feed",
          status: "failed",
          payload_json: JSON.stringify({ shard: { key: "AAPL" }, retryOf: "shard-original" }),
          result_json: null,
          error: "host died",
          created_at: "2026-11-14T12:00:00.000Z",
          parent_job_id: null,
          attempts_json: JSON.stringify([
            { attempt: 1, error: "timeout", at: "2026-11-14T12:00:01.000Z" },
            { attempt: 2, error: "timeout", at: "2026-11-14T12:00:02.000Z" },
          ]),
        },
        {
          job_id: "shard-b",
          stage: "feed",
          status: "completed",
          payload_json: JSON.stringify({ shard: { key: "MSFT" } }),
          result_json: null,
          error: null,
          created_at: "2026-11-14T12:00:03.000Z",
          parent_job_id: null,
          attempts_json: null,
        },
      ]),
      "chain-4423",
      "session-1",
    );
    expect(rows[0].retryOf).toBe("shard-original");
    expect(rows[0].attempts).toBe(2);
    expect(rows[1].retryOf).toBeUndefined();
    expect(rows[1].attempts).toBe(0);
  });

  it("treats a malformed history as no recorded attempt", () => {
    const rows = chainRowsFromSql(
      chainSql([
        {
          job_id: "shard-a",
          stage: "feed",
          status: "completed",
          payload_json: "{}",
          result_json: null,
          error: null,
          created_at: "2026-11-14T12:00:00.000Z",
          parent_job_id: null,
          attempts_json: "not json",
        },
      ]),
      "chain-4423",
      "session-1",
    );
    expect(rows[0].attempts).toBe(0);
  });
});

describe("4423-P02 the run summary carries it, or says nothing", () => {
  it("projects retriedShards and shardAttempts", () => {
    const summary = runSummaryFromReport(
      reportHit({ format: "pdf", trigger: "scheduled", retriedShards: 2, shardAttempts: 5 }),
    );
    expect(summary.retry).toEqual({ retriedShards: 2, attempts: 5 });
  });

  it("keeps retry null when the body records neither", () => {
    const summary = runSummaryFromReport(reportHit({ format: "pdf", trigger: "scheduled" }));
    expect(summary.retry).toBeNull();
  });
});

describe("4423-P03 the Docs row carries the lineage", () => {
  it("passes retry through to the row", () => {
    const rows = toDocumentRows([runSummary({ retry: { retriedShards: 1, attempts: 3 } })]);
    expect(rows[0].retry).toEqual({ retriedShards: 1, attempts: 3 });
  });

  it("keeps null when the run records none", () => {
    const rows = toDocumentRows([runSummary()]);
    expect(rows[0].retry).toBeNull();
  });
});

describe("4423-P04 Docs renders the marker", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = null;
    globalThis.fetch = realFetch;
  });

  async function renderWith(rows: RunSummary[]) {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ runs: rows }),
    ) as unknown as typeof fetch;
    root = createRoot(container);
    await act(async () => {
      root!.render(<DocsAndReportsPanel />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("shows Retry ×N on a retried row", async () => {
    await renderWith([runSummary({ retry: { retriedShards: 2, attempts: 4 } })]);
    expect(container.textContent ?? "").toContain("Retry ×2");
  });

  it("shows no marker on an original run", async () => {
    await renderWith([runSummary()]);
    expect(container.textContent ?? "").not.toContain("Retry ×");
  });
});
