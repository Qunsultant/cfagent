/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveTapeSelection,
  TAPE_SELECTION_CHANGED_EVENT,
} from "../src/client/quotes/symbolSetResolver";

const here = dirname(fileURLToPath(import.meta.url));
const tapeSrc = readFileSync(
  join(here, "..", "src", "client", "components", "MarketTickerTape.tsx"),
  "utf8",
);
const panelSrc = readFileSync(
  join(here, "..", "src", "client", "ETradeDynamicMenu.tsx"),
  "utf8",
);

describe("Ticker controls move (#2689)", () => {
  it("the tape bar carries no configuration dropdowns", () => {
    expect(tapeSrc).not.toContain("<Select");
    expect(tapeSrc).not.toContain('aria-label="Quote source"');
    expect(tapeSrc).not.toContain('aria-label="Tape set"');
  });

  it("the tape bar still renders the prices strip and status badge", () => {
    expect(tapeSrc).toContain("ticker-tape-chips-viewport");
    expect(tapeSrc).toContain("ticker-live-text");
  });

  it("the SettingsMenu panel carries both controls", () => {
    expect(panelSrc).toContain('aria-label="Quote source"');
    expect(panelSrc).toContain('aria-label="Tape set"');
  });

  it("the tape subscribes to selection changes from the panel", () => {
    expect(tapeSrc).toContain("subscribeTapeSelection");
  });

  it("saving a selection notifies subscribers", () => {
    const listener = vi.fn();
    const handler = (event: Event) => {
      listener((event as CustomEvent).detail);
    };
    window.addEventListener(TAPE_SELECTION_CHANGED_EVENT, handler);
    try {
      const store = new Map<string, string>();
      saveTapeSelection(
        { kind: "preset", preset: "indices" },
        {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        },
      );
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "preset", preset: "indices" }),
      );
    } finally {
      window.removeEventListener(TAPE_SELECTION_CHANGED_EVENT, handler);
    }
  });
});
