/** @vitest-environment jsdom */
/**
 * Top-strip hover dropdowns (issue #3163).
 *
 * The #2996 strip dropdowns open on click only. Required: hovering
 * a strip entry shows its dropdown; the panel stays open while the
 * pointer is over the trigger or the panel; click still toggles
 * (the touch path).
 *
 * Harness follows tests/top_menu_submenus_2996.test.tsx: render
 * NavigationMenu layout="top", triggers are buttons with
 * aria-haspopup="menu", the panel is portaled to document.body.
 * The close delay uses fake timers.
 */
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { NavigationMenu } from "../src/client/components/NavigationMenu";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  window.history.pushState(null, "", "/?tab=autopilot");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll('[role="menu"]').forEach((el) => el.remove());
  vi.useRealTimers();
});

async function renderTopStrip() {
  await act(async () => {
    root.render(
      <NavigationMenu
        layout="top"
        onToggleLayout={vi.fn()}
        activeTab={"autopilot" as any}
        onSelectTab={vi.fn()}
        onAskAgent={vi.fn()}
        user={{ login: "tester", name: "Tester", avatar: "" }}
      />,
    );
  });
}

function menuTrigger(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find(
    (b) => (b.textContent ?? "").includes(label),
  ) as HTMLButtonElement | undefined;
  expect(found).toBeDefined();
  return found!;
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

describe("Top-strip hover dropdowns (#3163)", () => {
  it("hovering a strip entry opens its dropdown without a click", async () => {
    await renderTopStrip();
    expect(panel()).toBeNull();
    over(menuTrigger("Options Screener"));
    expect(panel()).not.toBeNull();
    const labels = [...(panel() as HTMLElement).querySelectorAll('[role="menuitem"]')].map(
      (el) => el.textContent,
    );
    expect(labels[0]).toBe("Options Screener");
    expect(labels).toContain("Discovery");
  });

  it("leaving the trigger closes the dropdown after the delay", async () => {
    await renderTopStrip();
    const trigger = menuTrigger("Options Screener");
    over(trigger);
    expect(panel()).not.toBeNull();
    out(trigger);
    await advance(100);
    expect(panel()).not.toBeNull();
    await advance(300);
    expect(panel()).toBeNull();
  });

  it("moving onto the panel keeps the dropdown open", async () => {
    await renderTopStrip();
    const trigger = menuTrigger("Options Screener");
    over(trigger);
    const menu = panel() as HTMLElement;
    out(trigger);
    over(menu);
    await advance(500);
    expect(panel()).not.toBeNull();
  });

  it("click still toggles the dropdown (touch path)", async () => {
    await renderTopStrip();
    const trigger = menuTrigger("Options Screener");
    await act(async () => {
      trigger.click();
    });
    expect(panel()).not.toBeNull();
    await act(async () => {
      trigger.click();
    });
    expect(panel()).toBeNull();
  });
});
