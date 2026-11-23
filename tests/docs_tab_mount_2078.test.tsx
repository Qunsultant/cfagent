/** @vitest-environment jsdom */
/**
 * Issue #2078: the Docs and Reports page must mount inside the real Chat
 * shell at `?tab=docs`, and must never render as an empty viewport.
 *
 * The unit tests pin the table's content; this pin covers the shell
 * integration — route id → Chat branch → mounted page heading — which is
 * exactly the layer that can silently disappear while every panel test
 * still passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Chat } from "../src/client/Chat";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | undefined;

beforeEach(() => {
  window.history.replaceState({}, "", "/?tab=docs&view=stocks");
  (window as any).__FEATURES__ = { screener: true };
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("/api/runs")) {
      return Response.json({
        count: 1,
        runs: [
          {
            kind: "screener",
            id: "rep-1",
            runId: "screener:2026-10-27T13:05:00.000Z",
            title: "Market screen — NASDAQ100",
            summary: "Scanned 100 symbols, 12 matched.",
            trigger: "scheduled",
            createdAt: "2026-10-27T13:05:00.000Z",
            status: "completed",
            resultCount: 12,
            reportUrl: "/api/screener/report.pdf?key=screener%3Apdf%3Arep-1",
            xlsxUrl: null,
            csvUrl: null,
            source: "screener",
            runSource: "stock",
          },
        ],
      });
    }
    return Response.json({});
  }) as any;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
});

describe("Chat docs tab (#2078)", () => {
  it("mounts the Docs and Reports page and its document table", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Chat user={{ login: "tester", name: "Tester", avatar: "" }} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Docs & Reports");
    expect(text).toContain("Every document set produced by a screener-workflow run");
    expect(container.querySelector(".ui-page-frame")).not.toBeNull();
    expect(
      [...container.querySelectorAll("th button > span:first-child")].map((el) => el.textContent),
      // Issue #5102 (F5 of #5094): the Account column sits after Run
      // Source, before the artifact columns.
    ).toEqual(["Date-Time", "Run Type", "Run Source", "Account", "PDF", "XLSX", "CSV", "Run ID"]);
    expect(text).toContain("screener:2026-10-27T13:05:00.000Z");
    expect(text).toContain("Scheduled");
    expect(text).toContain("Stock");
  });
});
