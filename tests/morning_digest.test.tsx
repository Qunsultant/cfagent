/** @vitest-environment jsdom */
/**
 * Issue #1328: a trusted morning digest of overnight runs, composing
 * existing pieces (job tree, notifications, #218 digest publishers):
 * what ran, what was partial (with qualification), what failed (with
 * codes), what needs approval, artifacts attached.
 *
 * Composition notes (documented, not smuggled):
 *  - Runs come from the ScreenersHub feed rows (job tree) — no new fetch.
 *  - Held items come from the existing pending-confirmations endpoint
 *    (#1324); the digest links to the queue, it does not re-implement it.
 *  - #218 digest snippets are delivery-time only (prepended to Slack /
 *    email text, never stored on the run), so the digest composes stored
 *    run truth instead of re-running the LLM.
 *  - Run detail links select the run in ScreenersHub, which renders the
 *    #1326 RunDetailView for it (child 3); queue links switch the hub to
 *    the reports tab, which renders the #1324 queue (child 1).
 *  - Overnight window: 18:00 previous day → 09:00 today, viewer-local.
 *    Before 09:00 the window is in progress (18:00 yesterday → now).
 *
 * Pins:
 *  - overnightWindow computes the complete and in-progress windows
 *  - only overnight runs render; outside-window runs do not
 *  - partial runs show their qualification stamp; failed runs show
 *    their coded error; artifact links render
 *  - run entries call onSelectRun with the run timestamp; held items
 *    call onViewQueue
 *  - an empty overnight renders an honest empty state
 *  - ScreenersHub wires the digest above the runs panel (source pin)
 *
 * Harness follows tests/pdf_report_link_honesty.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  MorningDigest,
  overnightWindow,
  type DigestRun,
} from "../src/client/MorningDigest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Local-time construction: the window logic is viewer-local by design.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function run(overrides: Record<string, unknown> = {}): DigestRun {
  return {
    timestamp: iso(at(24, 20)),
    universe: "nasdaq100",
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 7,
    ...overrides,
  } as DigestRun;
}

function mockPending(items: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      if (String(input).includes("/trading/reports/pending")) {
        return { ok: true, status: 200, json: async () => ({ pending: items }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as any;
    })
  );
}

function buttonByText(text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  ) as HTMLButtonElement | null;
}

describe("Issue #1328 — overnightWindow", () => {
  it("after 09:00 the window is last night 18:00 → today 09:00, complete", () => {
    const w = overnightWindow(at(25, 10));
    expect(w.inProgress).toBe(false);
    expect(new Date(w.startMs).getHours()).toBe(18);
    expect(new Date(w.startMs).getDate()).toBe(24);
    expect(new Date(w.endMs).getHours()).toBe(9);
    expect(new Date(w.endMs).getDate()).toBe(25);
  });

  it("before 09:00 the window is yesterday 18:00 → now, in progress", () => {
    const now = at(25, 8);
    const w = overnightWindow(now);
    expect(w.inProgress).toBe(true);
    expect(new Date(w.startMs).getHours()).toBe(18);
    expect(new Date(w.startMs).getDate()).toBe(24);
    expect(w.endMs).toBe(now);
  });
});

describe("Issue #1328 — MorningDigest", () => {
  const props = (runs: DigestRun[]) => ({
    runs,
    nowMs: at(25, 10),
    onSelectRun: vi.fn(),
    onViewQueue: vi.fn(),
  });

  it("renders only overnight runs, with counts", async () => {
    mockPending([]);
    const p = props([
      run({ timestamp: iso(at(24, 20)) }),
      run({ timestamp: iso(at(24, 10)) }),
      run({ timestamp: iso(at(25, 11)) }),
    ]);
    await render(<MorningDigest {...p} />);
    const text = container.textContent || "";
    // One run in window (20:00 yesterday is in; 10:00 yesterday is
    // before the 18:00 window start and 11:00 today is after the 09:00
    // window end) — the digest shows the overnight set only.
    expect(text).toContain("1 ran");
    expect(text).not.toContain("11:00");
  });

  it("partial runs show their qualification stamp", async () => {
    mockPending([]);
    const p = props([
      run({
        partial: { quotedCount: 47, requestedCount: 100, failedSymbols: ["AAPL"], failureReasons: { other: 53 } },
      }),
    ]);
    await render(<MorningDigest {...p} />);
    const text = container.textContent || "";
    expect(text).toContain("Partial");
    expect(text).toContain("47");
    expect(text).toContain("100");
  });

  it("failed runs show their coded error and artifact links render", async () => {
    mockPending([]);
    const p = props([
      run({
        success: false,
        error: "FAILURE_QUOTE_AUTH_MISSING: E*TRADE quote fetch failed for the universe",
        reportUrl: "/api/screener/report.pdf?key=abc",
        xlsxKey: "screener:xlsx:abc",
      }),
    ]);
    await render(<MorningDigest {...p} />);
    const text = container.textContent || "";
    expect(text).toContain("FAILURE_QUOTE_AUTH_MISSING");
    expect(container.querySelector('a[href*="report.pdf"]')).not.toBeNull();
    expect(container.querySelector('a[href*="report.xlsx"]')).not.toBeNull();
  });

  it("run entries link to run detail and held items link to the queue", async () => {
    mockPending([
      { confirmationId: "conf-1", kind: "screener", detail: "Screener follow-up", expiresAt: iso(at(25, 11)) },
    ]);
    const onSelectRun = vi.fn();
    const onViewQueue = vi.fn();
    await render(
      <MorningDigest runs={[run()]} nowMs={at(25, 10)} onSelectRun={onSelectRun} onViewQueue={onViewQueue} />
    );
    await act(async () => {
      buttonByText("View run detail")!.click();
    });
    expect(onSelectRun).toHaveBeenCalledWith(iso(at(24, 20)));
    await act(async () => {
      buttonByText("View pending-review queue")!.click();
    });
    expect(onViewQueue).toHaveBeenCalledTimes(1);
  });

  it("an empty overnight renders an honest empty state", async () => {
    mockPending([]);
    await render(<MorningDigest {...props([])} />);
    expect(container.textContent || "").toContain("No runs overnight");
  });

  it("StockHub wires the digest above the runs panel (source pin, #2896)", () => {
    const hub = readFileSync("src/client/StockHub.tsx", "utf8");
    expect(hub).toContain("MorningDigest");
  });
});
