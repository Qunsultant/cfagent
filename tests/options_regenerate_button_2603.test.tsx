/** @vitest-environment jsdom */
/**
 * Issue #2603 — the regenerate affordance on a run detail: it posts the
 * stored run id, reports the server's refusal verbatim (the record is
 * incomplete), and is absent when the caller cannot name a stored run.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunDetailView } from "../src/client/RunDetailView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;

function detail(over: Record<string, unknown> = {}) {
  return (
    <RunDetailView
      run={
        {
          id: "report-1",
          success: false,
          timestamp: "2026-11-03T00:00:00.000Z",
          totalScanned: 12,
          matchedCount: 3,
          pdfStatus: "failed",
          pdfError: "pdf renderer failed",
          ...over,
        } as never
      }
      confirmations={[]}
      confirmationsLoading={false}
    />
  );
}

async function render(node: React.ReactElement) {
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("RunDetailView regenerate (#2603)", () => {
  it("is absent when the caller cannot name a stored run", async () => {
    await render(detail());
    expect(buttonByText("Regenerate this run")).toBeUndefined();
  });

  it("posts the stored run id and reports success without overwriting the original", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ status: "regenerated", runId: "options:new" });
    }) as never;
    await render(
      <RunDetailView
        run={
          {
            id: "report-1",
            success: false,
            timestamp: "2026-11-03T00:00:00.000Z",
            totalScanned: 12,
            matchedCount: 3,
          } as never
        }
        confirmations={[]}
        confirmationsLoading={false}
        regenerateRunId="report-1"
      />,
    );
    await act(async () => {
      buttonByText("Regenerate this run")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toEqual([
      { url: "/api/trading/options/regenerate", body: { reportId: "report-1" } },
    ]);
    expect(container.textContent).toContain("Regenerated as a new run");
  });

  it("shows the server's refusal when the stored record cannot be re-run", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        {
          error:
            "This run's stored record names no symbol, so it cannot be re-run as the same request. Start a new screen instead.",
          missing: ["symbol or symbols"],
        },
        { status: 422 },
      ),
    ) as never;
    await render(
      <RunDetailView
        run={
          {
            id: "report-1",
            success: false,
            timestamp: "2026-11-03T00:00:00.000Z",
            totalScanned: 12,
            matchedCount: 3,
          } as never
        }
        confirmations={[]}
        confirmationsLoading={false}
        regenerateRunId="report-1"
      />,
    );
    await act(async () => {
      buttonByText("Regenerate this run")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("names no symbol");
    expect(container.textContent).not.toContain("Regenerated as a new run");
  });
});
