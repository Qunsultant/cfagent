/** @vitest-environment jsdom */
/**
 * Issue #3530 (status-UX slice): the Data Providers panel renders
 * each source's FEED-JOB status from the S1 `feed` block the list /
 * detail API already serves (providerView's feed field —
 * feedViewFor / buildFeedStatus in the server), and wires "Run now"
 * to the EXISTING S1 run route (POST /data-providers/:id/feed-run).
 *
 * Why this surface exists beside the #3535 pipeline blocks: the
 * pipeline list is best-effort — an unbound/unreachable pipeline
 * host yields feedJobs: [] while the S1 block still reports the
 * dataset truth. On main before this slice the panel rendered only
 * feedJobs, so a provider WITH a registered job and a persisted
 * copy showed "No feed jobs", and Nasdaq's genuinely jobless state
 * was the identical string. These pins hold the honest states
 * apart: never-run ≠ failed ≠ stale ≠ fresh ≠ not-configured ≠
 * no-job, and a failed run is never dressed as success.
 *
 * Harness follows tests/data_providers_panel_e4.test.ts: the REAL
 * apiFetch driven against a stubbed global fetch; fixtures typed
 * against the client view of the real server shapes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  postFeedRun,
  type DataProviderView,
  type FeedDatasetStatusView,
  type FeedJobRunRecordView,
  type FeedJobView,
} from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -------------------------------------------------------------------

const HEALTH = {
  status: "no-data" as const,
  totalCaptures: 0,
  capturedCount: 0,
  failedCount: 0,
  failureRate: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
  totalRawBytes: 0,
  capturesLast24h: 0,
  failuresLast24h: 0,
  byCapability: {},
};

function provider(overrides: Partial<DataProviderView>): DataProviderView {
  return {
    id: "yahoo",
    adapterKind: "yahoo",
    lifecycleState: "enabled",
    enabled: true,
    precedence: 2,
    credentialRef: "env:YAHOO_API_KEY",
    config: {},
    createdAt: "2026-11-06T09:05:00.000Z",
    updatedAt: "2026-11-06T09:05:00.000Z",
    declaredCapabilities: ["quotes"],
    verification: null,
    serving: false,
    health: HEALTH,
    feed: null,
    feedJobs: [],
    ...overrides,
  };
}

const RUN_COMPLETED: FeedJobRunRecordView = {
  runId: "feed-run-1",
  trigger: "manual",
  startedAt: "2026-11-07T08:00:00.000Z",
  finishedAt: "2026-11-07T08:00:04.000Z",
  status: "completed",
  requested: 100,
  received: 100,
  failed: 0,
  missingSymbols: [],
  codedError: null,
  errorMessage: null,
};

const FEED_NEVER_RUN: FeedDatasetStatusView = {
  jobId: "yahoo-nasdaq100-quotes",
  sourceId: "yahoo",
  dataset: "quotes",
  elements: ["quotes"],
  universeLabel: "Nasdaq-100",
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
  state: "never-run",
  lastRun: null,
  history: [],
  snapshot: null,
};

const FEED_FRESH: FeedDatasetStatusView = {
  ...FEED_NEVER_RUN,
  state: "ready",
  lastRun: RUN_COMPLETED,
  history: [RUN_COMPLETED],
  snapshot: {
    artifactId: "artifact-1",
    asOf: "2026-11-07T08:00:04.000Z",
    ageSeconds: 120,
    rowsPersisted: 100,
    stale: false,
  },
};

const FEED_STALE: FeedDatasetStatusView = {
  ...FEED_FRESH,
  snapshot: {
    artifactId: "artifact-0",
    asOf: "2026-11-06T20:00:04.000Z",
    ageSeconds: 43_200,
    rowsPersisted: 98,
    stale: true,
  },
};

const RUN_FAILED: FeedJobRunRecordView = {
  runId: "feed-run-2",
  trigger: "scheduled",
  startedAt: "2026-11-07T07:30:00.000Z",
  finishedAt: "2026-11-07T07:30:03.000Z",
  status: "failed",
  requested: 100,
  received: 0,
  failed: 100,
  missingSymbols: ["AAPL", "MSFT"],
  codedError: "FEED_FETCH_FAILED",
  errorMessage: "Yahoo batch quotes HTTP 503",
};

const FEED_FAILED: FeedDatasetStatusView = {
  ...FEED_NEVER_RUN,
  state: "ready",
  lastRun: RUN_FAILED,
  history: [RUN_FAILED],
  snapshot: null,
};

const RUN_PARTIAL: FeedJobRunRecordView = {
  ...RUN_COMPLETED,
  runId: "feed-run-3",
  status: "partial",
  received: 97,
  failed: 3,
  missingSymbols: ["XYZ", "ABC", "DEF"],
};

const FEED_NOT_CONFIGURED: FeedDatasetStatusView = {
  jobId: "yahoo-nasdaq100-quotes",
  sourceId: "yahoo",
  dataset: "quotes",
  elements: ["quotes"],
  universeLabel: "Nasdaq-100",
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
  state: "not-configured",
  lastRun: null,
  snapshot: null,
  // NOTE: no `history` key — the server's not-configured shape omits it.
};

const PIPELINE_JOB: FeedJobView = {
  jobId: "yahoo-nasdaq100-quotes",
  sourceId: "yahoo",
  dataset: "quotes",
  label: "Yahoo quotes — Nasdaq-100",
  feed: FEED_FRESH,
  pipeline: { state: "idle", currentRunId: null, lastRunStatus: "completed", lastRunAt: "2026-11-07T08:00:04.000Z" },
  nextScheduledRun: null,
};

const NASDAQ_UNIVERSE_JOB: FeedJobView = {
  jobId: "nasdaq100-universe",
  sourceId: "nasdaq",
  dataset: "universe",
  label: "Nasdaq-100 universe (stored index list)",
  feed: null,
  pipeline: { state: "idle", currentRunId: null, lastRunStatus: null, lastRunAt: null },
  nextScheduledRun: null,
};

// Fetch stub -----------------------------------------------------------------

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface StubOptions {
  /** List responses, consumed in order; the last one repeats. */
  lists: Array<{ providers: DataProviderView[]; routes: [] }>;
  feedRunStatus?: number;
  feedRunBody?: unknown;
  /** When set, the feed-run POST hangs until the test resolves it. */
  feedRunGate?: Promise<void>;
}

function installFetch(opts: StubOptions) {
  const calls: RecordedCall[] = [];
  let listIdx = 0;
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.includes("/api/etrade/oauth/status")) {
      return Response.json({ authenticated: false, tokenScopes: null }, { status: 200 });
    }
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/data-providers")) {
      const list = opts.lists[Math.min(listIdx, opts.lists.length - 1)];
      listIdx += 1;
      return Response.json(list, { status: 200 });
    }
    if (method === "POST" && /\/api\/data-providers\/[^/]+\/feed-run$/.test(url)) {
      if (opts.feedRunGate) await opts.feedRunGate;
      return Response.json(opts.feedRunBody ?? {}, { status: opts.feedRunStatus ?? 200 });
    }
    if (method === "POST" && url.includes("/api/data-providers/")) {
      return Response.json({ provider: {} }, { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

// DOM helpers ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ToastProvider, null, React.createElement(DataProvidersPanel)));
  });
  await flush(60);
}

function providerItem(id: string): Element {
  const item = container.querySelector(`[data-provider-id="${id}"]`);
  if (!item) throw new Error(`No provider item rendered for "${id}". Panel: ${container.textContent?.slice(0, 600)}`);
  return item;
}

function buttonWithText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!btn) {
    throw new Error(`No button "${text}". Buttons: ${[...scope.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(", ")}`);
  }
  return btn as HTMLButtonElement;
}

async function click(scope: ParentNode, text: string) {
  const btn = buttonWithText(scope, text);
  await act(async () => {
    btn.click();
  });
  await flush(60);
}

function feedBlock(id: string): Element {
  const block = providerItem(id).querySelector(".dpp-feed-status");
  if (!block) throw new Error(`No .dpp-feed-status block for "${id}". Row: ${providerItem(id).textContent?.slice(0, 600)}`);
  return block;
}

beforeEach(() => {
  document.body.innerHTML = "";
  // #3978: panel tabs are URL-synced, so a tab click in one test writes
  // ?providerTab= into the shared jsdom URL and would leak into the
  // next test's initial tab. Every test starts from a clean URL.
  window.history.replaceState(null, "", "/");
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

// Rendering pins ---------------------------------------------------------------

describe("feed status block rendering (issue #3530 status UX)", () => {
  it("never-run: chip + dataset facts + Run now, no last-run or local-copy lines", async () => {
    installFetch({ lists: [{ providers: [provider({ feed: FEED_NEVER_RUN })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    expect(block.querySelector(".dpp-feed-status-chip-never-run")).not.toBeNull();
    expect(block.textContent).toContain("yahoo-nasdaq100-quotes");
    expect(block.textContent).toContain("Universe: Nasdaq-100");
    expect(block.textContent).toContain("Cadence: every 60m");
    expect(block.textContent).toContain("Never run — no local copy yet.");
    expect(block.textContent).not.toContain("Last run:");
    expect(block.textContent).not.toContain("Local copy:");
    expect(buttonWithText(block, "Run now")).toBeTruthy();
    // The false empty state from the pipeline list must not appear.
    expect(providerItem("yahoo").textContent).not.toContain("No feed jobs");
  });

  it("ready + fresh copy: last run with trigger/counts, copy age, no STALE", async () => {
    installFetch({ lists: [{ providers: [provider({ feed: FEED_FRESH })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    expect(block.querySelector(".dpp-feed-status-chip-ready")).not.toBeNull();
    expect(block.textContent).toContain("Last run: completed");
    expect(block.textContent).toContain("manual");
    expect(block.textContent).toContain("100/100 rows");
    expect(block.textContent).toContain("Local copy: 100 rows");
    expect(block.textContent).toContain("2m old");
    expect(block.textContent).not.toContain("STALE");
  });

  it("ready + stale copy: STALE marker + stale chip, visually distinct", async () => {
    installFetch({ lists: [{ providers: [provider({ feed: FEED_STALE })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    expect(block.querySelector(".dpp-feed-status-chip-stale")).not.toBeNull();
    expect(block.querySelector(".dpp-feed-status-chip-ready")).toBeNull();
    expect(block.textContent).toContain("Local copy: 98 rows");
    expect(block.textContent).toContain("STALE");
  });

  it("ready + failed last run + no usable copy: failure rendered as failure, with its stable code", async () => {
    installFetch({ lists: [{ providers: [provider({ feed: FEED_FAILED })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    expect(block.querySelector(".dpp-feed-status-chip-failed")).not.toBeNull();
    expect(block.textContent).toContain("Last run: failed");
    expect(block.textContent).toContain("scheduled");
    expect(block.textContent).toContain("0/100 rows");
    expect(block.textContent).toContain("FEED_FETCH_FAILED");
    expect(block.textContent).toContain("Yahoo batch quotes HTTP 503");
    expect(block.textContent).toContain("Local copy: none usable");
    expect(block.textContent).not.toContain("Last run: completed");
  });

  it("partial run renders as partial, never completed", async () => {
    const feed: FeedDatasetStatusView = {
      ...FEED_FRESH,
      lastRun: RUN_PARTIAL,
      history: [RUN_PARTIAL],
      snapshot: { artifactId: "artifact-2", asOf: "2026-11-07T08:00:04.000Z", ageSeconds: 60, rowsPersisted: 97, stale: false },
    };
    installFetch({ lists: [{ providers: [provider({ feed })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    expect(block.textContent).toContain("Last run: partial");
    expect(block.textContent).toContain("97/100 rows");
    expect(block.textContent).not.toContain("Last run: completed");
  });

  it("not-configured: honest state, dataset facts, and NO Run now button", async () => {
    installFetch({ lists: [{ providers: [provider({ feed: FEED_NOT_CONFIGURED })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    expect(block.querySelector(".dpp-feed-status-chip-not-configured")).not.toBeNull();
    expect(block.textContent).toContain("no dataset store is wired on this host");
    expect(block.textContent).toContain("Universe: Nasdaq-100");
    expect([...block.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Run now");
  });

  it("nasdaq (feed null, no pipeline jobs): the honest no-job state WITH the recorded reason", async () => {
    installFetch({
      lists: [{ providers: [provider({ id: "nasdaq", adapterKind: "nasdaq", feed: null, feedJobs: [] })], routes: [] }],
    });
    await renderPanel();
    await click(container, "nasdaq");
    const row = providerItem("nasdaq");
    expect(row.textContent).toContain("No feed job for this source");
    expect(row.textContent).toContain("listed-securities universe");
    expect(row.textContent).toContain("(issue 3530)");
    expect(row.textContent).not.toContain("No feed jobs");
    expect(row.querySelector(".dpp-feed-status")).toBeNull();
  });

  it("another jobless provider (public) gets the bare honest line, not nasdaq's reason", async () => {
    installFetch({
      lists: [{ providers: [provider({ id: "public", adapterKind: "public", feed: null, feedJobs: [] })], routes: [] }],
    });
    await renderPanel();
    await click(container, "public");
    const row = providerItem("public");
    expect(row.textContent).toContain("No feed job for this source");
    expect(row.textContent).not.toContain("listed-securities universe");
  });

  it("feed null but pipeline jobs present (nasdaq universe job): pipeline block renders, no-job block does not", async () => {
    installFetch({
      lists: [{ providers: [provider({ id: "nasdaq", adapterKind: "nasdaq", feed: null, feedJobs: [NASDAQ_UNIVERSE_JOB] })], routes: [] }],
    });
    await renderPanel();
    await click(container, "nasdaq");
    const row = providerItem("nasdaq");
    expect(row.textContent).toContain("Nasdaq-100 universe (stored index list)");
    expect(row.textContent).not.toContain("No feed job for this source");
    expect(row.querySelector(".dpp-feed-status")).toBeNull();
  });

  it("feed block and pipeline blocks coexist: both render, pipeline actions intact", async () => {
    installFetch({
      lists: [{ providers: [provider({ feed: FEED_FRESH, feedJobs: [PIPELINE_JOB] })], routes: [] }],
    });
    await renderPanel();
    await click(container, "yahoo");
    const row = providerItem("yahoo");
    expect(row.querySelector(".dpp-feed-status")).not.toBeNull();
    expect(row.textContent).toContain("Yahoo quotes — Nasdaq-100");
    // The pipeline block's own Run button and the status block's Run now.
    expect(buttonWithText(row, "Run")).toBeTruthy();
    expect(buttonWithText(row, "Run now")).toBeTruthy();
  });

  it("feed block renders even when capture health says no-data (the two facts are not conflated)", async () => {
    installFetch({ lists: [{ providers: [provider({ feed: FEED_FRESH, health: HEALTH })], routes: [] }] });
    await renderPanel();
    await click(container, "yahoo");
    const row = providerItem("yahoo");
    expect(row.textContent).toContain("No data yet");
    expect(row.querySelector(".dpp-feed-status")).not.toBeNull();
    expect(feedBlock("yahoo").textContent).toContain("Last run: completed");
  });
});

// Run-now wiring ---------------------------------------------------------------

describe("Run now — the S1 feed-run route (issue #3530 status UX)", () => {
  const RUN_RESPONSE = {
    run: {
      jobId: "yahoo-nasdaq100-quotes",
      runId: "feed-run-9",
      status: "completed",
      artifactId: "artifact-9",
      requested: 100,
      received: 100,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      startedAt: "2026-11-07T09:00:00.000Z",
      finishedAt: "2026-11-07T09:00:05.000Z",
    },
    feed: FEED_FRESH,
  };

  it("POSTs the exact feed-run URL, disables while in flight, then reloads and shows the outcome", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const after: FeedDatasetStatusView = {
      ...FEED_FRESH,
      lastRun: { ...RUN_COMPLETED, runId: "feed-run-9" },
    };
    const calls = installFetch({
      lists: [
        { providers: [provider({ feed: FEED_NEVER_RUN })], routes: [] },
        { providers: [provider({ feed: after })], routes: [] },
      ],
      feedRunBody: RUN_RESPONSE,
      feedRunGate: gate,
    });
    await renderPanel();
    await click(container, "yahoo");
    const block = feedBlock("yahoo");
    const btn = buttonWithText(block, "Run now");
    await act(async () => {
      btn.click();
    });
    await flush(30);
    expect(buttonWithText(feedBlock("yahoo"), "Run now").disabled).toBe(true);
    release();
    await flush(80);
    const runCalls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/data-providers/yahoo/feed-run"));
    expect(runCalls).toHaveLength(1);
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/data-providers")).length).toBeGreaterThanOrEqual(2);
    // The reloaded block reflects the server's fresh status.
    expect(feedBlock("yahoo").textContent).toContain("Last run: completed");
    expect(feedBlock("yahoo").textContent).toContain("100/100 rows");
    expect(feedBlock("yahoo").textContent).not.toContain("Never run — no local copy yet.");
    expect(document.body.textContent).toContain('Feed job "yahoo-nasdaq100-quotes" run completed (100/100 rows).');
  });

  it("a run that comes back failed (HTTP 200) surfaces as a failure with its code — never a success", async () => {
    installFetch({
      lists: [
        { providers: [provider({ feed: FEED_NEVER_RUN })], routes: [] },
        { providers: [provider({ feed: FEED_FAILED })], routes: [] },
      ],
      feedRunBody: {
        run: {
          jobId: "yahoo-nasdaq100-quotes",
          runId: "feed-run-10",
          status: "failed",
          artifactId: "artifact-10",
          requested: 100,
          received: 0,
          failed: 100,
          missingSymbols: ["AAPL"],
          codedError: "FEED_FETCH_FAILED",
          startedAt: "2026-11-07T09:00:00.000Z",
          finishedAt: "2026-11-07T09:00:02.000Z",
        },
        feed: FEED_FAILED,
      },
    });
    await renderPanel();
    await click(container, "yahoo");
    await click(feedBlock("yahoo"), "Run now");
    await flush(80);
    expect(container.textContent).toContain("run failed");
    expect(container.textContent).toContain("FEED_FETCH_FAILED");
    expect(document.body.textContent).not.toContain("run completed");
    expect(feedBlock("yahoo").querySelector(".dpp-feed-status-chip-failed")).not.toBeNull();
  });

  it("a partial run outcome is surfaced as partial (warning), with its counts", async () => {
    installFetch({
      lists: [
        { providers: [provider({ feed: FEED_NEVER_RUN })], routes: [] },
        { providers: [provider({ feed: FEED_FRESH })], routes: [] },
      ],
      feedRunBody: {
        run: { ...RUN_RESPONSE.run, status: "partial", received: 97, failed: 3, missingSymbols: ["A", "B", "C"] },
        feed: FEED_FRESH,
      },
    });
    await renderPanel();
    await click(container, "yahoo");
    await click(feedBlock("yahoo"), "Run now");
    await flush(80);
    expect(document.body.textContent).toContain("partially completed (97/100 rows)");
  });

  it("an HTTP refusal surfaces the server's error verbatim (500 FEED_JOB_NOT_CONFIGURED)", async () => {
    installFetch({
      lists: [{ providers: [provider({ feed: FEED_NEVER_RUN })], routes: [] }],
      feedRunStatus: 500,
      feedRunBody: {
        error: "Feed-job wiring is incomplete on this host (dataset store, universe store, or provider missing); the run was refused rather than fetching through an unwired path.",
        code: "FEED_JOB_NOT_CONFIGURED",
      },
    });
    await renderPanel();
    await click(container, "yahoo");
    await click(feedBlock("yahoo"), "Run now");
    await flush(80);
    expect(container.textContent).toContain("Feed-job wiring is incomplete on this host");
    expect(container.textContent).toContain("the run was refused");
  });

  it("a 401 refusal surfaces the server's session error", async () => {
    installFetch({
      lists: [{ providers: [provider({ feed: FEED_NEVER_RUN })], routes: [] }],
      feedRunStatus: 401,
      feedRunBody: { error: "A verified session is required to run a feed job." },
    });
    await renderPanel();
    await click(container, "yahoo");
    await click(feedBlock("yahoo"), "Run now");
    await flush(80);
    expect(container.textContent).toContain("A verified session is required to run a feed job.");
  });
});

// API client pins ---------------------------------------------------------------

describe("postFeedRun client (issue #3530 status UX)", () => {
  it("POSTs the feed-run route and returns the typed {run, feed}", async () => {
    const calls = installFetch({
      lists: [{ providers: [], routes: [] }],
      feedRunBody: {
        run: { jobId: "yahoo-nasdaq100-quotes", runId: "r1", status: "completed", artifactId: "a1", requested: 3, received: 3, failed: 0, missingSymbols: [], codedError: null, startedAt: "s", finishedAt: "f" },
        feed: FEED_FRESH,
      },
    });
    const out = await postFeedRun("yahoo");
    expect(out.run.status).toBe("completed");
    expect(out.run.received).toBe(3);
    expect(out.feed.state).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/data-providers/yahoo/feed-run");
  });

  it("a refusal rejects with the server's message AND its stable code preserved", async () => {
    installFetch({
      lists: [{ providers: [], routes: [] }],
      feedRunStatus: 404,
      feedRunBody: { error: 'No feed job is registered for provider "nasdaq".', code: "FEED_JOB_NOT_FOUND" },
    });
    await expect(postFeedRun("nasdaq")).rejects.toMatchObject({
      message: 'No feed job is registered for provider "nasdaq".',
      code: "FEED_JOB_NOT_FOUND",
    });
  });
});
