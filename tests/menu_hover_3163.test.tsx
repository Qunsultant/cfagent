/** @vitest-environment jsdom */
/**
 * Menu hover-open (issue #3163).
 *
 * The Menu primitive opens on click only. With `hoverOpen`, hovering
 * the trigger opens the panel, and the panel stays open while the
 * pointer is over the trigger or the panel (the panel is portaled,
 * so leaving the trigger starts a short close delay that entering
 * the panel cancels). Click still toggles (the touch path), and
 * Escape dismisses without hover immediately reopening.
 */
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { Menu, type MenuItem } from "../src/client/components/ui/Menu";
import { Button } from "../src/client/components/ui";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: MenuItem[] = [
  { id: "one", label: "One", onSelect: vi.fn() },
  { id: "two", label: "Two", onSelect: vi.fn() },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll('[role="menu"]').forEach((el) => el.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderMenu(hoverOpen?: boolean) {
  await act(async () => {
    root.render(
      <Menu
        trigger={<Button>Parent</Button>}
        items={ITEMS}
        ariaLabel="Parent menu"
        hoverOpen={hoverOpen}
      />,
    );
  });
}

function trigger(): HTMLButtonElement {
  return container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
}

function panel(): HTMLElement | null {
  return document.body.querySelector('[role="menu"]');
}

function over(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

function out(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("Menu hoverOpen (#3163)", () => {
  it("stays click-only without hoverOpen", async () => {
    await renderMenu();
    over(trigger());
    expect(panel()).toBeNull();
    await act(async () => {
      trigger().click();
    });
    expect(panel()).not.toBeNull();
  });

  it("opens on trigger hover", async () => {
    await renderMenu(true);
    over(trigger());
    expect(panel()).not.toBeNull();
  });

  it("closes after the delay when the pointer leaves the trigger", async () => {
    await renderMenu(true);
    over(trigger());
    expect(panel()).not.toBeNull();
    out(trigger());
    await advance(100);
    expect(panel()).not.toBeNull();
    await advance(200);
    expect(panel()).toBeNull();
  });

  it("stays open when the pointer moves onto the panel", async () => {
    await renderMenu(true);
    over(trigger());
    const menu = panel() as HTMLElement;
    out(trigger());
    over(menu);
    await advance(500);
    expect(panel()).not.toBeNull();
    out(menu);
    await advance(500);
    expect(panel()).toBeNull();
  });

  it("click still toggles (touch path) with hoverOpen", async () => {
    await renderMenu(true);
    await act(async () => {
      trigger().click();
    });
    expect(panel()).not.toBeNull();
    await act(async () => {
      trigger().click();
    });
    expect(panel()).toBeNull();
  });

  it("Escape dismisses and hover does not immediately reopen", async () => {
    await renderMenu(true);
    over(trigger());
    expect(panel()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();
    await advance(500);
    expect(panel()).toBeNull();
    out(trigger());
    over(trigger());
    expect(panel()).not.toBeNull();
  });
});
