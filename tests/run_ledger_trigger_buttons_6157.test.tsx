/** @vitest-environment jsdom */
/**
 * Issue #6157 — the run ledger's OODA and Opportunity Hunt buttons.
 *
 * Pins:
 *  - 6157-P01 both buttons render on the ledger's toolbar;
 *  - 6157-P02 "OODA" starts a run through the existing manual door
 *    (`POST /api/research/run`) and reports the run it started — no second
 *    trigger path, no fabricated id;
 *  - 6157-P03 "Opportunity Hunt" starts its goal through the existing goal
 *    trigger (`POST /api/schedule/goals/opportunity-hunt/trigger`);
 *  - 6157-P04 a refusal is reported as a refusal, not as a started run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { ScheduleRunLedgerPanel } from "../src/client/ScheduleRunLedgerPanel";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn());
  window.history.replaceState({}, "", "/?tab=schedules&view=runs");
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
}

interface Call {
  url: string;
  method: string;
}

/** Every fetch answers the ledger read; the two triggers answer by URL. */
function stub(): Call[] {
  const calls: Call[] = [];
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
      if (url.includes("/api/ledger/runs")) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (url.includes("/api/research/run")) {
        return new Response(JSON.stringify({ success: true, engineJobId: "r-6157" }), {
          status: 200,
        });
      }
      if (url.includes("/api/schedule/goals/opportunity-hunt/trigger")) {
        return new Response(
          JSON.stringify({ ok: true, tick: { timestamp: "2026-11-23T00:00:00.000Z", goalsEvaluated: 1, jobsCreated: 1, jobsSkipped: 0, errors: [] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
  return calls;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  );
}

function bodyText(): string {
  return (container!.textContent ?? "").replace(/\s+/g, " ");
}

describe("6157-P01 the buttons are on the ledger", () => {
  it("renders OODA and Opportunity Hunt", async () => {
    stub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    expect(button("OODA")).toBeDefined();
    expect(button("Opportunity Hunt")).toBeDefined();
    // The existing refresh action is untouched.
    expect(button("↻ Refresh")).toBeDefined();
  });
});

describe("6157-P02 OODA starts through the existing manual door", () => {
  it("posts to /api/research/run and names the run it started", async () => {
    const calls = stub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    await act(async () => {
      button("OODA")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    await settle();
    const post = calls.find((c) => c.url.includes("/api/research/run"));
    expect(post).toBeDefined();
    expect(post!.method).toBe("POST");
    expect(bodyText()).toContain("OODA run started: r-6157");
    // The panel refreshes the ledger so the new row appears.
    expect(calls.filter((c) => c.url.includes("/api/ledger/runs")).length).toBeGreaterThan(1);
  });
});

describe("6157-P03 Opportunity Hunt starts through the goal trigger", () => {
  it("posts to the goal's trigger and reports it", async () => {
    const calls = stub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    await act(async () => {
      button("Opportunity Hunt")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    await settle();
    const post = calls.find((c) =>
      c.url.includes("/api/schedule/goals/opportunity-hunt/trigger"),
    );
    expect(post).toBeDefined();
    expect(post!.method).toBe("POST");
    expect(bodyText()).toContain("Opportunity Hunt run started.");
  });
});

describe("6157-P04 a refusal is reported as a refusal", () => {
  it("surfaces the refusal instead of claiming a run", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/ledger/runs")) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (url.includes("/api/research/run")) {
          return new Response(
            JSON.stringify({ success: false, reason: "FAILURE_RESEARCH_OWNER_MISSING" }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    await act(async () => {
      button("OODA")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    await settle();
    expect(bodyText()).toContain("Could not start the run");
    expect(bodyText()).not.toContain("OODA run started");
  });
});
