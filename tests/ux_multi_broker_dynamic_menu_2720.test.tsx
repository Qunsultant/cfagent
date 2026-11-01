/**
 * @vitest-environment jsdom
 *
 * Issue #2720: Multi-broker harmonization, compact single-line controls,
 * and tuning overflow fix for ETradeDynamicMenu / SettingsMenu.
 */
import { describe, expect, it, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsMenu } from "../src/client/ETradeDynamicMenu";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const menuSrc = readFileSync(
  join(here, "..", "src", "client", "ETradeDynamicMenu.tsx"),
  "utf8",
);
const stylesSrc = readFileSync(
  join(here, "..", "src", "client", "styles.css"),
  "utf8",
);

describe("multi-broker dynamic menu harmonization (#2720)", () => {
  it("source defines broker-neutral engine tuning and single-line classes", () => {
    // Broker neutral button title
    expect(menuSrc).toContain("⚙️ Engine Tuning");
    expect(menuSrc).not.toContain("⚙️ ETAPI Engine Tuning");

    // Single-line controls containers
    expect(menuSrc).toContain("etrade-controls-single-line");
    expect(menuSrc).toContain("ticker-controls-single-line");

    // Scoped CSS styles exist
    expect(stylesSrc).toContain(".etrade-controls-single-line");
    expect(stylesSrc).toContain(".btn-env-mini");
    expect(stylesSrc).toContain(".btn-action-mini");
    expect(stylesSrc).toContain(".ticker-controls-single-line");
    expect(stylesSrc).toContain(".etrade-env-badge.offline");
  });

  describe("component rendering and broker switching", () => {
    let container: HTMLDivElement;
    let root: Root | null = null;

    async function openMenu() {
      root = createRoot(container);
      await act(async () => {
        root.render(<SettingsMenu />);
      });
      const trigger = container.querySelector(".etrade-dynamic-menu-trigger") as HTMLButtonElement;
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      localStorage.clear();
    });

    it("renders offline status badge when disconnected instead of PROD (LIVE)", async () => {
      await openMenu();

      const badge = container.querySelector(".etrade-env-badge");
      expect(badge).not.toBeNull();
      expect(badge?.classList.contains("offline")).toBe(true);
      expect(badge?.textContent).toContain("OFFLINE");
      expect(badge?.textContent).not.toBe("PROD (LIVE)");

      act(() => {
        root?.unmount();
      });
      root = null;
    });

    it("renders compact single-line environment and connection buttons", async () => {
      await openMenu();

      const singleLine = container.querySelector(".etrade-controls-single-line");
      expect(singleLine).not.toBeNull();

      const testBtn = singleLine?.querySelector(".btn-env-mini");
      expect(testBtn).not.toBeNull();

      const syncBtn = singleLine?.querySelector(".btn-action-mini.sync");
      expect(syncBtn).not.toBeNull();
      expect(syncBtn?.textContent).toContain("Sync");

      const connectBtn = singleLine?.querySelector(".btn-action-mini.connect");
      expect(connectBtn).not.toBeNull();
      expect(connectBtn?.textContent).toContain("Connect");

      act(() => {
        root?.unmount();
      });
      root = null;
    });

    it("renders ticker configuration on a single line", async () => {
      await openMenu();

      const tickerLine = container.querySelector(".ticker-controls-single-line");
      expect(tickerLine).not.toBeNull();

      const quoteSelect = tickerLine?.querySelector('select[aria-label="Quote source"]');
      expect(quoteSelect).not.toBeNull();

      const tapeSelect = tickerLine?.querySelector('select[aria-label="Tape set"]');
      expect(tapeSelect).not.toBeNull();

      act(() => {
        root?.unmount();
      });
      root = null;
    });
  });
});
