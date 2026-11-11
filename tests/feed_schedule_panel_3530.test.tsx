/** @vitest-environment jsdom */
/**
 * Issue #3530 (scheduling-config slice) — the Data Providers panel's
 * per-job schedule editor:
 *
 * - The schedule line renders the STORED pipeline schedule the API
 *   serves on the job's surface view (enabled + interval/cron) —
 *   not the registry cadence and not a client-side guess.
 * - A job whose view carries no schedule renders "Schedule:
 *   unknown" with NO edit controls — never a fabricated cadence.
 * - Saving posts { enabled, intervalMinutes } to
 *   POST /api/data-providers/:id/feed-jobs/:jobId/schedule and
 *   reloads; Disable posts { enabled: false }.
 * - A server refusal surfaces verbatim in the panel's error Notice.
 *
 * Harness follows tests/feed_status_ux_3530.test.tsx: the REAL
 * apiFetch driven against a stubbed global fetch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  postFeedJobSchedule,
  type DataProviderView,
  type FeedJobView,
} from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

const JOB_WITH_SCHEDULE: FeedJobView = {
  jobId: "yahoo-nasdaq100-quotes",
  sourceId: "yahoo",
  dataset: "quotes",
  label: "Yahoo quotes — Nasdaq-100",
  feed: null,
  pipeline: { state: "idle", currentRunId: null, lastRunStatus: "completed", lastRunAt: "2026-11-07T08:00:04.000Z" },
  nextScheduledRun: null,
  schedule: { enabled: true, interval: "every 60 minutes", cron: null },
};

const JOB_NO_SCHEDULE: FeedJobView = {
  ...JOB_WITH_SCHEDULE,
  schedule: null,
};

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface StubOptions {
  lists: Array<{ providers: DataProviderView[]; routes: [] }>;
  scheduleStatus?: number;
  scheduleBody?: unknown;
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
    if (method === "POST" && url.includes("/schedule")) {
      return Response.json(opts.scheduleBody ?? { jobId: JOB_WITH_SCHEDULE.jobId, schedule: { enabled: true, interval: "every 15 minutes", cron: null } }, { status: opts.scheduleStatus ?? 200 });
    }
    if (method === "POST" && url.includes("/api/data-providers/")) {
      return Response.json({ provider: {} }, { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

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
  // #3978: the feed-job schedule editor lives on the provider tab now;
  // the overview shows the summary columns only. Every test in this
  // file renders the yahoo provider (config has no display name, so
  // the tab label is the id).
  await click(container, "yahoo");
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

describe("feed job schedule editor (#3530 scheduling-config)", () => {
  it("renders the stored schedule from the served view", async () => {
    installFetch({ lists: [{ providers: [provider({ feedJobs: [JOB_WITH_SCHEDULE] })], routes: [] }] });
    await renderPanel();
    const item = providerItem("yahoo");
    expect(item.textContent).toContain("Schedule: every 60 minutes");
    const input = item.querySelector<HTMLInputElement>("[data-feed-schedule-minutes]");
    expect(input?.value).toBe("60");
  });

  it("no stored schedule renders unknown, with no edit controls", async () => {
    installFetch({ lists: [{ providers: [provider({ feedJobs: [JOB_NO_SCHEDULE] })], routes: [] }] });
    await renderPanel();
    const item = providerItem("yahoo");
    expect(item.textContent).toContain("Schedule: unknown");
    expect(item.querySelector("[data-feed-schedule-minutes]")).toBeNull();
  });

  it("a disabled schedule renders off and offers Enable", async () => {
    const disabled: FeedJobView = { ...JOB_WITH_SCHEDULE, schedule: { enabled: false, interval: "every 60 minutes", cron: null } };
    installFetch({ lists: [{ providers: [provider({ feedJobs: [disabled] })], routes: [] }] });
    await renderPanel();
    const item = providerItem("yahoo");
    expect(item.textContent).toContain("Schedule: off");
    expect([...item.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Enable schedule")).toBe(true);
  });

  it("Save posts the edited interval to the schedule route and reloads", async () => {
    const calls = installFetch({
      lists: [
        { providers: [provider({ feedJobs: [JOB_WITH_SCHEDULE] })], routes: [] },
        { providers: [provider({ feedJobs: [{ ...JOB_WITH_SCHEDULE, schedule: { enabled: true, interval: "every 15 minutes", cron: null } }] })], routes: [] },
      ],
    });
    await renderPanel();
    const item = providerItem("yahoo");
    const input = item.querySelector<HTMLInputElement>("[data-feed-schedule-minutes]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "15");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await flush(30);
    await click(providerItem("yahoo"), "Save schedule");
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/schedule"));
    expect(post?.url).toContain("/api/data-providers/yahoo/feed-jobs/yahoo-nasdaq100-quotes/schedule");
    expect(post?.body).toEqual({ enabled: true, intervalMinutes: 15 });
    expect(providerItem("yahoo").textContent).toContain("Schedule: every 15 minutes");
  });

  it("Disable posts { enabled: false } only", async () => {
    const calls = installFetch({ lists: [{ providers: [provider({ feedJobs: [JOB_WITH_SCHEDULE] })], routes: [] }] });
    await renderPanel();
    await click(providerItem("yahoo"), "Disable schedule");
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/schedule"));
    expect(post?.body).toEqual({ enabled: false });
  });

  it("a server refusal surfaces verbatim", async () => {
    installFetch({
      lists: [{ providers: [provider({ feedJobs: [JOB_WITH_SCHEDULE] })], routes: [] }],
      scheduleStatus: 400,
      scheduleBody: { error: "Schedule field \"intervalMinutes\" must be a positive whole number of minutes.", code: "FEED_JOB_SCHEDULE_INVALID" },
    });
    await renderPanel();
    await click(providerItem("yahoo"), "Save schedule");
    expect(container.textContent).toContain("must be a positive whole number of minutes");
  });

  it("postFeedJobSchedule posts the exact body through the API seam", async () => {
    const calls = installFetch({ lists: [{ providers: [], routes: [] }] });
    await postFeedJobSchedule("yahoo", "yahoo-nasdaq100-quotes", { enabled: true, intervalMinutes: 30 });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/api/data-providers/yahoo/feed-jobs/yahoo-nasdaq100-quotes/schedule");
    expect(post?.body).toEqual({ enabled: true, intervalMinutes: 30 });
  });
});
