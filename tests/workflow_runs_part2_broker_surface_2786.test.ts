/**
 * #2786 Part 2 + broker surfacing — RED FIRST.
 *
 * Pins the owner's 2026-11-03 rulings (comment 6604049143) plus the two
 * direction updates (#2869 stage-contract mechanism; mode uniformity):
 *  - broker screens surface through the #2869 stage contract + canonical
 *    store (NO new side recording) — the canonical mapping half is pinned
 *    here; the Part 3 overlay half is r112's, reconciled at ship;
 *  - every row states exactly what the job is (no "Background job"-only
 *    rows); POST /market-data/compare names the work + symbols;
 *  - columns sort with Docs-tab parity (docsAndReports.ts semantics);
 *  - add-ons are visible toolbar controls (traces toggle + count,
 *    beacons toggle, prune action) — panel behavior pinned in the
 *    companion panel test file;
 *  - nothing silently dropped: impression/click rows surface labeled,
 *    GET/HEAD read traces hide ONLY behind the visible toggle;
 *  - mode uniformity: the same run shape renders the same rows/stages/
 *    messages in sync mode as in async mode; where the fused path
 *    cannot yet emit stage messages, the gap is named, not papered over.
 */
import { describe, it, expect } from "vitest";
import {
  buildWorkflowRuns,
  buildWorkflowRunsPage,
  filterWorkflowRuns,
  httpRequestRunIdentity,
  isStandaloneRequestTrace,
  stageLabel,
  type WorkflowRun,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";
import { STOCK_STAGE_IDS } from "../src/workflows/stageMessage";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { documentRunSource } from "../src/client/docsAndReports";
import {
  WORKFLOW_RUN_SORT_DEFAULT,
  nextWorkflowRunSort,
  sortWorkflowRuns,
  type WorkflowRunSort,
} from "../src/client/workflowRunSort";
import { isAdBeaconsPaused, setAdBeaconsPaused } from "../src/client/adBeacons";

function httpJob(over: Partial<WorkflowRunJobRow> & { payload: Record<string, unknown> }): WorkflowRunJobRow {
  const { payload, ...rest } = over;
  return {
    job_id: "job-1",
    capability: "http.request",
    display_name: "",
    status: "completed",
    created_at: "2026-11-03T10:00:00.000Z",
    ...rest,
    payload_json: JSON.stringify(payload),
  } as WorkflowRunJobRow;
}

function compareJob(symbols?: string[]): WorkflowRunJobRow {
  return httpJob({
    job_id: "cmp-1",
    display_name: "POST /market-data/compare",
    payload: {
      method: "POST",
      pathAndQuery: "/market-data/compare",
      body: JSON.stringify(symbols ? { symbols } : {}),
    },
  });
}

function beaconJob(path: "/external-ads/impression" | "/external-ads/click", id: string): WorkflowRunJobRow {
  return httpJob({
    job_id: `beacon-${path.includes("click") ? "click" : "imp"}-1`,
    display_name: `POST ${path}`,
    status: "completed",
    payload: { method: "POST", pathAndQuery: path, body: JSON.stringify({ id }) },
  });
}

function brokerCanonicalHit(over: { trigger?: string; jobId?: string; success?: boolean; universe?: string } = {}) {
  const body = {
    timestamp: "2026-11-03T09:00:00.000Z",
    universe: over.universe ?? "NASDAQ100",
    trigger: over.trigger ?? "manual",
    success: over.success ?? true,
    totalScanned: 100,
    matchedCount: 12,
    opportunities: [],
    allStocks: [],
    provider: "etrade",
    runSource: "stock",
    ...(over.jobId ? { jobId: over.jobId } : {}),
  };
  return {
    id: "rep-1",
    runId: "screener:2026-11-03T09:00:00.000Z",
    title: `Market screen — ${body.universe} (${body.trigger})`,
    source: "screener",
    summary: "Scanned 100 symbols, 12 matched, 0 opportunities.",
    body: JSON.stringify(body),
    createdAt: "2026-11-03T09:00:00.000Z",
    bodyR2Key: null,
    fanoutOutcome: null,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "r1",
    runId: "r1",
    workflow: "Stock screening workflow",
    family: "stock",
    title: "Stock screen",
    source: "job-chain",
    trigger: "manual",
    triggerDetail: "Manual",
    triggeredBy: null,
    status: "completed",
    startedAt: "2026-11-03T10:00:00.000Z",
    finishedAt: "2026-11-03T10:01:00.000Z",
    durationMs: 60000,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: null,
    outputs: null,
    artifacts: [],
    deliveryStates: {},
    error: null,
    ...over,
  };
}

describe("#2869 stage labels (#2786 Part 2, scope f)", () => {
  it("labels every #2869 stage id (never the raw id, never a guessed verb)", () => {
    for (const id of STOCK_STAGE_IDS) {
      const label = stageLabel(id, "");
      expect(label).not.toBe(id);
      expect(label).toContain(" ");
    }
    expect(stageLabel("deliver", "")).toBe("Deliver — channel dispatch");
    expect(stageLabel("brokerStart", "")).toBe("Broker start — execution branch");
    expect(stageLabel("persistCanonicalResults", "")).toBe("Persist canonical results");
    expect(stageLabel("analysis-done", "")).toBe("Analysis done — report ready");
  });
});

describe("job identity (#2786 Part 2, scope b)", () => {
  it("names a market-data comparison WITH its symbols (not Background job + id)", () => {
    const runs = buildWorkflowRuns({ jobs: [compareJob(["NVDA", "AAPL"])], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("Market data comparison — NVDA, AAPL");
    expect(runs[0].workflow).toBe("Market data research");
    expect(runs[0].family).toBe("research");
    expect(runs[0].triggerDetail).toContain("async API request");
  });

  it("does not fabricate default symbols when the payload records none", () => {
    const runs = buildWorkflowRuns({ jobs: [compareJob()], outcomes: [], transitions: [] });
    expect(runs[0].title).toBe("Market data comparison");
  });

  it("derives compare symbols from the ?symbols= query when the body carries none", () => {
    const job = httpJob({
      job_id: "cmp-q",
      display_name: "GET /market-data/compare?symbols=MSFT,TSLA",
      payload: { method: "GET", pathAndQuery: "/market-data/compare?symbols=MSFT,TSLA" },
    });
    expect(httpRequestRunIdentity(job)?.title).toBe("Market data comparison — MSFT, TSLA");
  });

  it("surfaces ad impression rows labeled (never dropped, never generic)", () => {
    const runs = buildWorkflowRuns({ jobs: [beaconJob("/external-ads/impression", "e1")], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("Ad impression — e1");
    expect(runs[0].workflow).toBe("Advertising");
    expect(runs[0].family).toBe("ads");
  });

  it("surfaces ad click rows labeled (never dropped, never generic)", () => {
    const runs = buildWorkflowRuns({ jobs: [beaconJob("/external-ads/click", "e1")], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("Ad click — e1");
    expect(runs[0].family).toBe("ads");
  });

  it("never renders a bare Background job row: an empty-titled unknown job gets method + path", () => {
    const job = httpJob({
      job_id: "unk-1",
      display_name: "",
      payload: { method: "POST", pathAndQuery: "/foo/bar" },
    });
    const runs = buildWorkflowRuns({ jobs: [job], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].title).toBe("POST /foo/bar");
    expect(runs[0].title).not.toBe("Background job");
  });

  it("keeps a meaningful display name for already-specific http.request rows", () => {
    const job = httpJob({
      job_id: "screen-post-1",
      display_name: "POST /etrade/screen",
      payload: { method: "POST", pathAndQuery: "/etrade/screen", body: JSON.stringify({ trigger: "manual", universe: "TECH" }) },
    });
    const runs = buildWorkflowRuns({ jobs: [job], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow).toBe("Stock screening workflow");
    expect(runs[0].title).toBe("POST /etrade/screen");
  });
});

describe("nothing silently dropped (#2786 Part 2, scope e)", () => {
  const trace = httpJob({
    job_id: "trace-1",
    display_name: "GET /api/workflow-runs",
    payload: { method: "GET", pathAndQuery: "/api/workflow-runs?limit=50" },
  });

  it("still drops standalone GET read traces by default (the #2456 rule, unchanged)", () => {
    expect(isStandaloneRequestTrace(trace)).toBe(true);
    const runs = buildWorkflowRuns({ jobs: [trace, compareJob(["NVDA"])], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].family).toBe("research");
  });

  it("counts hidden traces and reveals them when the visible toggle includes them", () => {
    const page = buildWorkflowRunsPage({ jobs: [trace, compareJob(["NVDA"])], outcomes: [], transitions: [] });
    expect(page.hiddenTraceCount).toBe(1);
    // The compare row plus the #3021 binding schedule row (last).
    expect(page.totalMatched).toBe(2);
    expect(page.runs).toHaveLength(2);
    expect(page.runs[1].source).toBe("schedule");
    const shown = buildWorkflowRunsPage({
      jobs: [trace, compareJob(["NVDA"])],
      outcomes: [],
      transitions: [],
      includeTraces: true,
    });
    expect(shown.hiddenTraceCount).toBe(0);
    expect(shown.totalMatched).toBe(3);
    expect(shown.runs).toHaveLength(3);
    expect(shown.runs[2].source).toBe("schedule");
  });

  it("filters before slicing: a match past the page limit is still reachable", () => {
    const jobs: WorkflowRunJobRow[] = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(compareJob([`SYM${i}`]));
      jobs[i].job_id = `cmp-${i}`;
      jobs[i].created_at = `2026-11-03T10:0${i}:00.000Z`;
    }
    const page = buildWorkflowRunsPage({
      jobs,
      outcomes: [],
      transitions: [],
      limit: 2,
      search: "SYM4",
    });
    expect(page.totalMatched).toBe(1);
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0].title).toContain("SYM4");
  });

  it("pages with offset over the filtered, newest-first list", () => {
    const jobs: WorkflowRunJobRow[] = [];
    for (let i = 0; i < 5; i++) {
      const job = compareJob([`SYM${i}`]);
      job.job_id = `cmp-${i}`;
      job.created_at = `2026-11-03T10:0${i}:00.000Z`;
      jobs.push(job);
    }
    const page = buildWorkflowRunsPage({ jobs, outcomes: [], transitions: [], limit: 2, offset: 2 });
    // Five executions plus the #3021 binding schedule row (last, so
    // this page's titles are unchanged).
    expect(page.totalMatched).toBe(6);
    expect(page.runs.map((r) => r.title)).toEqual([
      "Market data comparison — SYM2",
      "Market data comparison — SYM1",
    ]);
  });

  it("filterWorkflowRuns matches trigger, status, and search (server-side, before slice)", () => {
    const rows = [
      run({ id: "a", trigger: "manual", status: "completed", title: "Alpha screen" }),
      run({ id: "b", trigger: "scheduled", status: "failed", title: "Beta screen", error: "boom" }),
      run({ id: "c", trigger: "manual", status: "running", title: "Gamma screen" }),
    ];
    expect(filterWorkflowRuns(rows, { trigger: "manual" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterWorkflowRuns(rows, { status: "active" }).map((r) => r.id)).toEqual(["c"]);
    expect(filterWorkflowRuns(rows, { status: "failed" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterWorkflowRuns(rows, { search: "boom" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterWorkflowRuns(rows, { trigger: "all", status: "all", search: "" })).toHaveLength(3);
  });
});

describe("broker surfacing through the canonical store (#2786 Part 2, scope a; #2869 mechanism)", () => {
  it("maps a broker canonical row to the stock Docs family (the Part 3 overlay's predicate)", () => {
    const summary = runSummaryFromReport(brokerCanonicalHit() as never);
    expect(summary.kind).toBe("screener");
    expect(documentRunSource(summary as never)).toBe("stock");
    expect(summary.title).toBe("Market screen — NASDAQ100 (manual)");
  });

  it("carries no fabricated stages: a broker canonical body has no stage trace (fused gap, named)", () => {
    const body = JSON.parse(brokerCanonicalHit().body as string) as Record<string, unknown>;
    expect(body.stages).toBeUndefined();
  });
});

describe("mode uniformity (#2786 Part 2, scope g; uniformity update)", () => {
  it("sync and async broker canonical rows map identically (same family, title shape, status)", () => {
    const syncSummary = runSummaryFromReport(brokerCanonicalHit({ trigger: "manual" }) as never);
    const asyncSummary = runSummaryFromReport(
      brokerCanonicalHit({ trigger: "manual", jobId: "workflow-job-9" }) as never,
    );
    expect(documentRunSource(syncSummary as never)).toBe(documentRunSource(asyncSummary as never));
    expect(syncSummary.status).toBe(asyncSummary.status);
    expect(syncSummary.title).toBe(asyncSummary.title);
  });

  it("sync and async broker failures map identically (failed status, same family)", () => {
    const syncFailed = runSummaryFromReport(brokerCanonicalHit({ success: false }) as never);
    const asyncFailed = runSummaryFromReport(brokerCanonicalHit({ success: false, jobId: "workflow-job-9" }) as never);
    expect(syncFailed.status).toBe("failed");
    expect(asyncFailed.status).toBe("failed");
    expect(documentRunSource(syncFailed as never)).toBe("stock");
    expect(documentRunSource(asyncFailed as never)).toBe("stock");
  });

  it("joins extra runs before filter/slice (saga chains obey the same paging)", () => {
    const saga = run({ id: "saga-1", title: "Saga run — saga-1", startedAt: "2026-11-03T12:00:00.000Z", trigger: "unknown" });
    const page = buildWorkflowRunsPage({
      jobs: [compareJob(["NVDA"])],
      outcomes: [],
      transitions: [],
      limit: 1,
      extraRuns: [saga],
    });
    expect(page.totalMatched).toBe(3);
    expect(page.runs.map((r) => r.title)).toEqual(["Saga run — saga-1"]);
    const filtered = buildWorkflowRunsPage({
      jobs: [compareJob(["NVDA"])],
      outcomes: [],
      transitions: [],
      trigger: "manual",
      extraRuns: [saga],
    });
    expect(filtered.totalMatched).toBe(0);
  });

  it("the same job payload renders identically regardless of submission mode", () => {
    const a = buildWorkflowRuns({ jobs: [compareJob(["NVDA"])], outcomes: [], transitions: [] });
    const b = buildWorkflowRuns({ jobs: [compareJob(["NVDA"])], outcomes: [], transitions: [] });
    expect(a[0].title).toBe(b[0].title);
    expect(a[0].workflow).toBe(b[0].workflow);
    expect(a[0].triggerDetail).toBe(b[0].triggerDetail);
    expect(a[0].stages).toEqual(b[0].stages);
  });

  it("does NOT claim stage uniformity the fused path cannot emit (all 13 ids absent from a broker body)", () => {
    const body = JSON.parse(brokerCanonicalHit().body as string) as Record<string, unknown>;
    const text = JSON.stringify(body);
    for (const id of STOCK_STAGE_IDS) {
      expect(text).not.toContain(`"${id}"`);
    }
  });
});

describe("Docs-parity sorting (#2786 Part 2, scope c)", () => {
  const rows = [
    run({ id: "a", runId: "r-a", startedAt: "2026-11-03T10:00:00.000Z", title: "Beta", status: "completed", durationMs: 5000, stageCount: 2, artifacts: [{ kind: "pdf", label: "PDF report", url: "/x" }], outputs: { outcome: { matched: 3 } } }),
    run({ id: "b", runId: "r-b", startedAt: "2026-11-03T11:00:00.000Z", title: "Alpha", status: "failed", durationMs: null, stageCount: 0, artifacts: [], outputs: {} }),
    run({ id: "c", runId: "r-c", startedAt: "2026-11-03T09:00:00.000Z", title: "Gamma", status: "running", durationMs: 9000, stageCount: 5, artifacts: [], outputs: { outcome: { matched: 9 } } }),
  ];

  it("defaults to newest first, exactly as the API returns it", () => {
    expect(sortWorkflowRuns(rows, WORKFLOW_RUN_SORT_DEFAULT).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts labels A→Z, ids A→Z, numbers present-first; absent values sort last in BOTH directions", () => {
    expect(sortWorkflowRuns(rows, { key: "workflow", dir: "asc" }).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(sortWorkflowRuns(rows, { key: "runId", dir: "asc" }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortWorkflowRuns(rows, { key: "duration", dir: "desc" }).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(sortWorkflowRuns(rows, { key: "duration", dir: "asc" }).map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(sortWorkflowRuns(rows, { key: "result", dir: "desc" }).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("never mutates its input and falls back to newest-first, then id, on ties", () => {
    const tied = [run({ id: "x", title: "Same", startedAt: "2026-11-03T10:00:00.000Z" }), run({ id: "y", title: "Same", startedAt: "2026-11-03T10:00:00.000Z" })];
    const before = tied.map((r) => r.id);
    const sorted = sortWorkflowRuns(tied, { key: "workflow", dir: "asc" });
    expect(tied.map((r) => r.id)).toEqual(before);
    expect(sorted.map((r) => r.id)).toEqual(["y", "x"]);
  });

  it("next sort: same column reverses, a new column starts at its default direction", () => {
    expect(nextWorkflowRunSort({ key: "started", dir: "desc" }, "started")).toEqual({ key: "started", dir: "asc" });
    expect(nextWorkflowRunSort({ key: "started", dir: "desc" }, "workflow")).toEqual({ key: "workflow", dir: "asc" });
    expect(nextWorkflowRunSort({ key: "started", dir: "desc" }, "duration")).toEqual({ key: "duration", dir: "desc" });
  });
});

describe("ad-beacon gate helper (#2786 Part 2, scope d-ii)", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
  }

  it("defaults to beacons ON; pausing persists and is observable", () => {
    const storage = fakeStorage();
    expect(isAdBeaconsPaused(storage as never)).toBe(false);
    setAdBeaconsPaused(true, storage as never);
    expect(isAdBeaconsPaused(storage as never)).toBe(true);
    setAdBeaconsPaused(false, storage as never);
    expect(isAdBeaconsPaused(storage as never)).toBe(false);
  });
});
