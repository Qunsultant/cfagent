/** @vitest-environment jsdom */
/**
 * Issue #2247 (AOP P1): a failed-PDF row in ReportsPanel renders its
 * catalog error via the Notice primitive, not a bare span.
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReportsPanel } from "../src/client/ReportsPanel";

vi.mock("../src/client/apiFetch", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../src/client/apiFetch";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  vi.resetAllMocks();
});

describe("ReportsPanel PDF-unavailable (#2247)", () => {
  it("renders a failed PDF's catalog error via Notice, not a bare span", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.includes("/api/runs")) {
        return {
          ok: true,
          json: async () => ({
            runs: [
              {
                id: "r1",
                runId: "run-1",
                title: "Test run",
                source: "screener",
                summary: "",
                createdAt: "2026-10-25T10:00:00.000Z",
                reportUrl: undefined,
                pdfStatus: "failed",
                pdfError: "[FAILURE_REPORT_PDF_GENERATION] The PDF report could not be generated. — boom",
              },
            ],
          }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ReportsPanel />);
    });
    await flush();
    const text = container.textContent || "";
    expect(text).toContain("FAILURE_REPORT_PDF_GENERATION");
    // The bespoke `report-pdf-unavailable` class hook is gone after the
    // #3051 primitives migration (Notice takes no bespoke class); the
    // error still renders inside the Notice primitive itself.
    const notices = [...container.querySelectorAll(".ui-notice")];
    expect(notices.length).toBeGreaterThan(0);
    expect(
      notices.some((n) => (n.textContent || "").includes("FAILURE_REPORT_PDF_GENERATION")),
    ).toBe(true);
    expect(container.querySelector("span.report-pdf-unavailable")).toBeNull();
  });
});
