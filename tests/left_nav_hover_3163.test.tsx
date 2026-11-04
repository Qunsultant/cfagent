/** @vitest-environment jsdom */
/**
 * Left-nav hover + click-to-pin (issue #3163).
 *
 * Expanded sidebar today shows a sub-menu only when its chevron
 * toggles it. Required: hovering a row shows its sub-menu, and the
 * chevron click pins it open (click again unpins). Collapsed
 * flyouts get the same pin rule: a clicked-open flyout survives
 * mouse-leave until toggled closed or Escape.
 *
 * Harness follows tests/left_nav_bar.test.tsx: DEFAULT_LEFT_NAV_CONFIG,
 * jsdom render, native event dispatch (React simulates enter/leave
 * from mouseover/mouseout).
 */
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { LeftNavBar } from "../src/client/components/LeftNavBar";
import { DEFAULT_LEFT_NAV_CONFIG } from "../src/client/navConfig";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.pushState(null, "", "/?tab=autopilot");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderNavBar(collapsed: boolean) {
  await act(async () => {
    root.render(
      <LeftNavBar
        config={DEFAULT_LEFT_NAV_CONFIG}
        activeTab={"autopilot" as any}
        onSelectTab={vi.fn()}
        collapsed={collapsed}
      />,
    );
  });
}

function rowWrapper(label: string): HTMLElement {
  // Expanded rows render the label as text; collapsed rows render
  // icons only, with the label on the button's aria-label.
  const byLabel = [...container.querySelectorAll(".sidebar-nav-item-wrapper")].find(
    (w) => (w.textContent ?? "").includes(label),
  ) as HTMLElement | undefined;
  if (byLabel) return byLabel;
  const byAria = container.querySelector(
    `.sidebar-nav-item-wrapper [aria-label="${label}"]`,
  ) as HTMLElement | null;
  const found = byAria?.closest(".sidebar-nav-item-wrapper") as HTMLElement | undefined;
  expect(found).toBeDefined();
  return found!;
}

function chevron(label: string, action: "Expand" | "Collapse" | "Open" | "Close"): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === `${action} ${label} sub-menu`,
  ) as HTMLButtonElement | undefined;
  expect(found).toBeDefined();
  return found!;
}

function submenu(id: string): HTMLElement | null {
  return container.querySelector(`#submenu-${id}`);
}

function flyout(id: string): HTMLElement | null {
  return container.querySelector(`#flyout-submenu-${id}`);
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

describe("Left-nav hover + pin (#3163)", () => {
  it("expanded: hover shows the sub-menu, leaving hides it when unpinned", async () => {
    await renderNavBar(false);
    const row = rowWrapper("Options Screener");
    expect(submenu("options-screener")).toBeNull();
    over(row);
    expect(submenu("options-screener")).not.toBeNull();
    out(row);
    expect(submenu("options-screener")).toBeNull();
  });

  it("expanded: chevron click pins the sub-menu across mouse-leave, click again unpins", async () => {
    await renderNavBar(false);
    const row = rowWrapper("Options Screener");
    await act(async () => {
      chevron("Options Screener", "Expand").click();
    });
    expect(submenu("options-screener")).not.toBeNull();
    out(row);
    expect(submenu("options-screener")).not.toBeNull();
    await act(async () => {
      chevron("Options Screener", "Collapse").click();
    });
    expect(submenu("options-screener")).toBeNull();
  });

  it("expanded: hover then chevron pins, so leaving keeps it shown", async () => {
    await renderNavBar(false);
    const row = rowWrapper("Options Screener");
    over(row);
    expect(submenu("options-screener")).not.toBeNull();
    await act(async () => {
      chevron("Options Screener", "Collapse").click();
    });
    out(row);
    expect(submenu("options-screener")).not.toBeNull();
  });

  it("collapsed: hover shows the flyout, leaving the flyout hides it when unpinned", async () => {
    await renderNavBar(true);
    const row = rowWrapper("Options Screener");
    expect(flyout("options-screener")).toBeNull();
    over(row);
    const panel = flyout("options-screener");
    expect(panel).not.toBeNull();
    out(panel as HTMLElement);
    expect(flyout("options-screener")).toBeNull();
  });

  it("collapsed: clicked-open flyout survives mouse-leave until toggled", async () => {
    await renderNavBar(true);
    await act(async () => {
      chevron("Options Screener", "Open").click();
    });
    const panel = flyout("options-screener");
    expect(panel).not.toBeNull();
    out(panel as HTMLElement);
    expect(flyout("options-screener")).not.toBeNull();
    await act(async () => {
      chevron("Options Screener", "Close").click();
    });
    expect(flyout("options-screener")).toBeNull();
  });
});
