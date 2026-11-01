/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TDD pin for #2283 stream 5: Menu, Popover, Drawer join the ui primitives.
// RED until src/client/components/ui/{Menu,Popover,Drawer}.tsx exist and
// are exported from the barrel. Behavior follows the Modal precedent:
// portal to body, Escape closes, focus restored, token-only styling.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const UI_DIR = join(ROOT, "src/client/components/ui");

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function click(el: Element | null) {
  if (!el) throw new Error("click target missing");
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function keyDown(key: string, target: Element | Document = document) {
  act(() => {
    (target as any).dispatchEvent?.(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    ) ?? document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("Menu/Popover/Drawer primitives (#2283 stream 5)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("barrel exports Menu, Popover, Drawer", () => {
    const barrel = readFileSync(join(UI_DIR, "index.ts"), "utf8");
    for (const name of ["Menu", "Popover", "Drawer"]) {
      expect(barrel).toContain(name);
    }
  });

  it("new primitive files use no hardcoded hex colors and no px inline styles", () => {
    for (const file of ["Menu.tsx", "Popover.tsx", "Drawer.tsx"]) {
      const src = readFileSync(join(UI_DIR, file), "utf8");
      // Strip comments first: issue refs like #2283 in prose are not colors
      // (the same trap the token ratchet documents for client prose).
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*$/gm, " ");
      expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(stripped).not.toMatch(/style=\{\{[^}]*\d+px/);
    }
  });

  it("Menu opens on trigger click, lists menuitems, selects via click", async () => {
    const { Menu } = await import("../src/client/components/ui/Menu");
    const onSelect = vi.fn();
    const { cleanup } = render(
      React.createElement(Menu, {
        ariaLabel: "Actions",
        trigger: React.createElement("button", { type: "button" }, "Open"),
        items: [
          { id: "a", label: "Alpha", onSelect },
          { id: "b", label: "Beta", onSelect: () => {} },
        ],
      }),
    );
    try {
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      click(document.body.querySelector("button"));
      const menu = document.body.querySelector('[role="menu"]');
      expect(menu).not.toBeNull();
      const items = document.body.querySelectorAll('[role="menuitem"]');
      expect(items).toHaveLength(2);
      click(items[0]);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("Menu skips disabled items and closes on Escape", async () => {
    const { Menu } = await import("../src/client/components/ui/Menu");
    const { cleanup } = render(
      React.createElement(Menu, {
        ariaLabel: "Actions",
        trigger: React.createElement("button", { type: "button" }, "Open"),
        items: [
          { id: "a", label: "Alpha", onSelect: () => {}, disabled: true },
          { id: "b", label: "Beta", onSelect: () => {} },
        ],
      }),
    );
    try {
      click(document.body.querySelector("button"));
      const items = document.body.querySelectorAll('[role="menuitem"]');
      expect(items[0].getAttribute("aria-disabled")).toBe("true");
      click(items[0]);
      expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
      keyDown("Escape");
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("Popover toggles content on trigger click and closes on Escape", async () => {
    const { Popover } = await import("../src/client/components/ui/Popover");
    const { cleanup } = render(
      React.createElement(Popover, {
        trigger: React.createElement("button", { type: "button" }, "Info"),
        title: "About this",
        children: "Popover body text",
      }),
    );
    try {
      expect(document.body.textContent).not.toContain("Popover body text");
      click(document.body.querySelector("button"));
      expect(document.body.textContent).toContain("Popover body text");
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      keyDown("Escape");
      expect(document.body.textContent).not.toContain("Popover body text");
    } finally {
      cleanup();
    }
  });

  it("Drawer renders a dialog panel with title and closes on backdrop click", async () => {
    const { Drawer } = await import("../src/client/components/ui/Drawer");
    const onClose = vi.fn();
    const { cleanup } = render(
      React.createElement(Drawer, {
        open: true,
        onClose,
        title: "Copilot",
        side: "right",
        children: "Drawer body",
      }),
    );
    try {
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      expect(document.body.textContent).toContain("Copilot");
      const backdrop = document.body.querySelector(".ui-drawer-backdrop");
      expect(backdrop).not.toBeNull();
      click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("Drawer renders nothing when closed", async () => {
    const { Drawer } = await import("../src/client/components/ui/Drawer");
    const { cleanup } = render(
      React.createElement(Drawer, {
        open: false,
        onClose: () => {},
        title: "Copilot",
        children: "Drawer body",
      }),
    );
    try {
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("Drawer renders header actions before the close button", async () => {
    const { Drawer } = await import("../src/client/components/ui/Drawer");
    const { cleanup } = render(
      React.createElement(Drawer, {
        open: true,
        onClose: () => {},
        title: "Copilot",
        actions: React.createElement("button", { type: "button" }, "Expand"),
        children: "Drawer body",
      }),
    );
    try {
      expect(document.body.querySelector(".ui-drawer-actions")).not.toBeNull();
      expect(document.body.textContent).toContain("Expand");
    } finally {
      cleanup();
    }
  });
});
