// @vitest-environment jsdom
/**
 * Issue #6473 — the report's shareable link in UX.
 *
 * Pins:
 *  - 6473-P04 the row shows an openable link to the report AND the URL in text
 *    (a browser with no clipboard and no Web Share can still take the link);
 *  - 6473-P05 Share uses Web Share where the platform provides it;
 *  - 6473-P06 without Web Share it copies the URL and says so;
 *  - 6473-P07 a refused clipboard says to copy the link, never that it copied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReportLinkRow } from "../src/client/ReportLinkRow";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const URL_6473 = "https://agent.internal/api/opportunity-hunt/report/abc-6473.pdf";
let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render() {
  root = createRoot(container);
  await act(async () => {
    root!.render(<ReportLinkRow url={URL_6473} />);
  });
  await flush();
}

function shareButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Share");
  if (!button) throw new Error("Share button not rendered");
  return button as HTMLButtonElement;
}

async function clickShare() {
  await act(async () => {
    shareButton().click();
    await Promise.resolve();
  });
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
  root = null;
  vi.restoreAllMocks();
  delete (navigator as any).share;
  delete (navigator as any).clipboard;
});

describe("#6473 — the report link row", () => {
  it("P04: renders an openable link and the URL as text", async () => {
    await render();
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(URL_6473);
    expect(anchor?.textContent).toBe("Open report");
    expect(container.textContent).toContain(URL_6473);
  });

  it("P05: Share prefers Web Share where the platform provides it", async () => {
    const share = vi.fn(async () => {});
    (navigator as any).share = share;
    await render();
    await clickShare();
    expect(share).toHaveBeenCalledWith({ url: URL_6473, title: "Opportunity Hunt report" });
    expect(container.textContent).toContain("Shared.");
  });

  it("P06: without Web Share it copies the URL and says so", async () => {
    const writeText = vi.fn(async () => {});
    (navigator as any).clipboard = { writeText };
    await render();
    await clickShare();
    expect(writeText).toHaveBeenCalledWith(URL_6473);
    expect(container.textContent).toContain("Report link copied.");
  });

  it("P07: a refused clipboard says to copy the link, never that it copied", async () => {
    (navigator as any).clipboard = {
      writeText: vi.fn(async () => {
        throw new Error("denied");
      }),
    };
    await render();
    await clickShare();
    expect(container.textContent).toContain("Copy the link from the line below.");
    expect(container.textContent).not.toContain("Report link copied.");
  });
});
