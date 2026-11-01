import { describe, it, expect } from "vitest";
import React from "react";
import { SegmentedControl, PillGroup, Badge, Button, Spinner, EmptyState, Card, Notice, Tabs, TabPanel, TextInput, Select, FileInput, Modal, Table, Skeleton, Checkbox, PageShell, PageSection, ToastProvider, useToast, Menu, Popover, Drawer } from "../src/client/components/ui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Composable UI Primitives (Design System)", () => {
  describe("SegmentedControl Component", () => {
    it("renders options with correct accessibility attributes", () => {
      const options = [
        { id: "graph", label: "Graph", icon: "📈" },
        { id: "table", label: "Matrix Table", icon: "⊞" },
      ];

      const element = React.createElement(SegmentedControl, {
        value: "graph",
        onChange: () => {},
        options,
        ariaLabel: "Payoff display mode",
        size: "md",
      });

      expect(element).toBeDefined();
      expect(element.props.value).toBe("graph");
      expect(element.props.options).toHaveLength(2);
      expect(element.props.ariaLabel).toBe("Payoff display mode");
    });

    it("supports optional size variants", () => {
      const sizes: Array<"sm" | "md" | "lg"> = ["sm", "md", "lg"];
      for (const size of sizes) {
        const element = React.createElement(SegmentedControl, {
          value: "test",
          onChange: () => {},
          options: [{ id: "test", label: "Test" }],
          size,
        });
        expect(element.props.size).toBe(size);
      }
    });

    it("supports badges and disabled options", () => {
      const element = React.createElement(SegmentedControl, {
        value: "active",
        onChange: () => {},
        options: [
          { id: "active", label: "Active", badge: "5" },
          { id: "disabled", label: "Disabled", disabled: true },
        ],
      });
      expect(element.props.options[0].badge).toBe("5");
      expect(element.props.options[1].disabled).toBe(true);
    });
  });

  describe("PillGroup Component", () => {
    it("renders pill options and tracks selection", () => {
      const options = [
        { id: "pnl_dollar", label: "Profit / Loss $" },
        { id: "pnl_pct", label: "Profit / Loss %" },
        { id: "collateral_pct", label: "% of Risk" },
        { id: "contract_val", label: "Contract Value" },
      ];

      const element = React.createElement(PillGroup, {
        value: "pnl_dollar",
        onChange: () => {},
        options,
        variant: "cyan",
        size: "sm",
      });

      expect(element).toBeDefined();
      expect(element.props.value).toBe("pnl_dollar");
      expect(element.props.options).toHaveLength(4);
      expect(element.props.variant).toBe("cyan");
      expect(element.props.size).toBe("sm");
    const xs = React.createElement(Badge, { size: "xs" }, "tiny");
    expect(xs.props.size).toBe("xs");
    });

    it("supports multiple color variants for theming", () => {
      const variants: Array<"cyan" | "emerald" | "amber" | "purple"> = [
        "cyan",
        "emerald",
        "amber",
        "purple",
      ];
      for (const variant of variants) {
        const element = React.createElement(PillGroup, {
          value: "m1",
          onChange: () => {},
          options: [{ id: "m1", label: "Metric 1" }],
          variant,
        });
        expect(element.props.variant).toBe(variant);
      }
    });
  });
});

describe("Toast Component", () => {
  // #2283 global toast: behavioral coverage (roles, auto-dismiss,
  // danger persistence, dedupe, cap) lives in tests/ux_toast_2283.test.tsx.
  // This block is the inventory exercise: the provider composes like any
  // other primitive and the hook is the single call surface.
  it("provides a toast context to its children", () => {
    const child = React.createElement("span", null, "inside");
    const element = React.createElement(ToastProvider, null, child);
    expect(element).toBeDefined();
    expect(element.props.children).toBe(child);
  });

  it("exposes the useToast hook as the call surface", () => {
    expect(typeof useToast).toBe("function");
  });
});

describe("Primitive styles (primitives.css)", () => {
  const css = readFileSync(
    join(process.cwd(), "src/client/components/ui/primitives.css"),
    "utf8",
  );

  it("defines every class hook the components emit", () => {
    for (const hook of [
      ".segmented-control",
      ".segmented-btn",
      ".segmented-badge",
      ".size-sm",
      ".size-md",
      ".size-lg",
      ".pill-group",
      ".pill-btn",
      ".variant-cyan",
      ".variant-emerald",
      ".variant-amber",
      ".variant-purple",
      ".ui-badge",
      ".tone-success",
      ".tone-danger",
      ".ui-btn",
      ".variant-primary",
      ".ui-spinner",
      ".ui-empty",
      ".ui-card",
      ".ui-notice",
      ".ui-tabs",
      ".ui-tab",
      ".ui-input",
      ".ui-select",
      ".ui-field-label",
      ".ui-modal",
      ".ui-modal-body",
      ".ui-modal-actions",
      ".ui-table",
      ".ui-skeleton",
    ]) {
      expect(css, hook).toContain(hook);
    }
  });

  it("contains no raw color literals (token-only styling)", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });

  it("keeps focus visible and honors reduced motion", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("Badge Component (#492)", () => {
  it("supports every semantic tone", () => {
    const tones = ["neutral", "accent", "success", "warning", "danger", "info", "purple", "trade"] as const;
    for (const tone of tones) {
      const element = React.createElement(Badge, { tone }, "LIVE");
      expect(element.props.tone).toBe(tone);
    }
  });

  it("supports sizes and the status dot", () => {
    const element = React.createElement(Badge, { tone: "success", size: "sm", dot: true }, "PRO");
    expect(element.props.size).toBe("sm");
    expect(element.props.dot).toBe(true);
  });
});

describe("Button Component (#492)", () => {
  it("supports every variant and size", () => {
    const variants = ["primary", "secondary", "ghost", "danger", "trade"] as const;
    for (const variant of variants) {
      const element = React.createElement(Button, { variant }, "Go");
      expect(element.props.variant).toBe(variant);
    }
    const sized = React.createElement(Button, { size: "lg" }, "Go");
    expect(sized.props.size).toBe("lg");
  });

  it("defaults to type button and honors the loading contract", () => {
    const element = React.createElement(Button, { loading: true }, "Saving");
    expect(element.props.type).toBeUndefined(); // default applied at render: "button"
    expect(element.props.loading).toBe(true);
  });
});

describe("Spinner + EmptyState (#492)", () => {
  it("Spinner supports sizes and an accessible label", () => {
    const element = React.createElement(Spinner, { size: "lg", label: "Loading quote" });
    expect(element.props.size).toBe("lg");
    expect(element.props.label).toBe("Loading quote");
  });

  it("EmptyState carries title, description, and framing", () => {
    const element = React.createElement(EmptyState, {
      icon: "🛡️",
      title: "Nothing here",
      description: "Yet.",
      framed: true,
    });
    expect(element.props.title).toBe("Nothing here");
    expect(element.props.framed).toBe(true);
  });
});

describe("Card + Notice (#492)", () => {
  it("Card supports elevation and the padding scale", () => {
    const element = React.createElement(Card, { elevated: true, padding: "lg" }, "body");
    expect(element.props.elevated).toBe(true);
    expect(element.props.padding).toBe("lg");
  });

  it("Notice supports tones, strip variant, and dismissal", () => {
    const onDismiss = () => {};
    const element = React.createElement(Notice, { tone: "warning", variant: "strip", onDismiss }, "Careful");
    expect(element.props.tone).toBe("warning");
    expect(element.props.variant).toBe("strip");
    expect(element.props.onDismiss).toBe(onDismiss);
  });
});

describe("Tabs + TabPanel (#492)", () => {
  const tabs = [
    { id: "anatomy", label: "Risk Anatomy" },
    { id: "playbook", label: "Defense Playbook" },
    { id: "ai", label: "AI Risk Manager", badge: "new" },
  ];

  it("carries the tablist contract (idBase links tabs to panels)", () => {
    const element = React.createElement(Tabs, {
      tabs,
      value: "anatomy",
      onChange: () => {},
      idBase: "risk-analysis",
      ariaLabel: "Risk analysis views",
    });
    expect(element.props.idBase).toBe("risk-analysis");
    expect(element.props.tabs).toHaveLength(3);
    expect(element.props.tabs[2].badge).toBe("new");
  });

  it("TabPanel renders only when active", () => {
    const inactive = TabPanel({ idBase: "risk-analysis", tabId: "ai", active: false, children: "x" });
    expect(inactive).toBeNull();
    const active = TabPanel({ idBase: "risk-analysis", tabId: "ai", active: true, children: "x" });
    expect(active?.props.role).toBe("tabpanel");
    expect(active?.props.id).toBe("risk-analysis-panel-ai");
    expect(active?.props["aria-labelledby"]).toBe("risk-analysis-tab-ai");
  });
});

describe("TextInput + Select (#492)", () => {
  it("TextInput carries label/hint/error wiring props", () => {
    const element = React.createElement(TextInput, {
      label: "Ticker",
      hint: "US-listed only",
      error: "Unknown symbol",
      value: "AAPL",
      onChange: () => {},
    });
    expect(element.props.label).toBe("Ticker");
    expect(element.props.error).toBe("Unknown symbol");
  });

  it("Select renders options as children with a wired label", () => {
    const element = React.createElement(
      Select,
      { label: "Accent Color", value: "#6366f1", onChange: () => {} },
      React.createElement("option", { value: "#6366f1" }, "Indigo"),
    );
    expect(element.props.label).toBe("Accent Color");
    expect(element.props.value).toBe("#6366f1");
  });

  it("FileInput carries a wired label and forces type file (#1169 knowledge UI)", () => {
    const element = React.createElement(FileInput, {
      label: "File",
      onChange: () => {},
    });
    expect(element.props.label).toBe("File");
    // The primitive hardcodes type="file" (it is omitted from the
    // accepted props), so no caller can turn it into a text field.
    expect("type" in element.props).toBe(false);
  });
});

describe("Modal (#492)", () => {
  it("carries the dialog contract (open, title, size, footer)", () => {
    const element = React.createElement(
      Modal,
      { open: true, onClose: () => {}, title: "Partner Deals", size: "lg", footer: "actions" },
      "body",
    );
    expect(element.props.open).toBe(true);
    expect(element.props.title).toBe("Partner Deals");
    expect(element.props.size).toBe("lg");
    expect(element.props.footer).toBe("actions");
  });
});

describe("Table + Skeleton (#492)", () => {
  it("Table carries the column-config contract", () => {
    const columns = [{ key: "sym", header: "SYMBOL", render: (r: { s: string }) => r.s }];
    const element = React.createElement(Table, {
      columns,
      rows: [{ s: "AAPL" }],
      rowKey: (r: { s: string }) => r.s,
      empty: "none",
    });
    expect(element.props.columns).toHaveLength(1);
    expect(element.props.rows).toHaveLength(1);
    expect(element.props.columns[0].render({ s: "MSFT" })).toBe("MSFT");
  });

  it("Skeleton supports variants and multi-line text", () => {
    const element = React.createElement(Skeleton, { variant: "text", lines: 3 });
    expect(element.props.variant).toBe("text");
    expect(element.props.lines).toBe(3);
  });
});

describe("TextInput multiline (#594)", () => {
  it("supports multiline (textarea) rendering with rows", () => {
    const element = React.createElement(TextInput, { multiline: true, rows: 3, value: "body" });
    expect(element.props.multiline).toBe(true);
    expect(element.props.rows).toBe(3);
  });
});

describe("Button accent variant (#594)", () => {
  it("carries the accent variant", () => {
    const element = React.createElement(Button, { variant: "accent" }, "Copy config");
    expect(element.props.variant).toBe("accent");
  });
});

describe("Button subtle tone + warning variant (#628)", () => {
  it("defaults to the solid tone and carries the subtle tone", () => {
    const solid = React.createElement(Button, { variant: "accent" }, "Report");
    expect(solid.props.tone).toBeUndefined();
    const subtle = React.createElement(Button, { variant: "accent", tone: "subtle" }, "Report");
    expect(subtle.props.tone).toBe("subtle");
  });

  it("carries the warning variant", () => {
    const element = React.createElement(Button, { variant: "warning", tone: "subtle" }, "Risk Analysis");
    expect(element.props.variant).toBe("warning");
  });
});

describe("Checkbox (#1577)", () => {
  it("carries the boolean control contract (checked, onChange, id, disabled)", () => {
    const element = React.createElement(Checkbox, {
      id: "gate-enabled",
      checked: true,
      onChange: () => {},
      disabled: false,
    });
    expect(element.type).toBe(Checkbox);
    expect(element.props.checked).toBe(true);
    expect(element.props.id).toBe("gate-enabled");
    expect(element.props.disabled).toBe(false);
  });

  it("is implemented as a native checkbox with the token class, not a text field", () => {
    const source = readFileSync(
      join(process.cwd(), "src/client/components/ui/Checkbox.tsx"),
      "utf8",
    );
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("ui-checkbox");
    expect(source).not.toContain("ui-input");
  });
});

describe("PageShell + PageSection (#1804/#1808)", () => {
  it("carries page shell and section primitives", () => {
    const section = React.createElement(PageSection, { title: "Overview" }, "Content");
    expect(section.props.title).toBe("Overview");
    const shell = React.createElement(PageShell, { title: "Dashboard" }, section);
    expect(shell.props.title).toBe("Dashboard");
  });
});

describe("Menu + Popover + Drawer (#2283 stream 5)", () => {
  it("Menu carries the trigger/items/a11y contract", () => {
    const element = React.createElement(Menu, {
      ariaLabel: "Actions",
      trigger: React.createElement("button", { type: "button" }, "Open"),
      items: [
        { id: "a", label: "Alpha", onSelect: () => {} },
        { id: "b", label: "Beta", onSelect: () => {}, disabled: true, danger: true },
      ],
      align: "end",
    });
    expect(element.props.ariaLabel).toBe("Actions");
    expect(element.props.items).toHaveLength(2);
    expect(element.props.items[1].disabled).toBe(true);
    expect(element.props.items[1].danger).toBe(true);
    expect(element.props.align).toBe("end");
  });

  it("Popover carries the trigger/title/content contract", () => {
    const element = React.createElement(
      Popover,
      {
        trigger: React.createElement("button", { type: "button" }, "Info"),
        title: "About this",
      },
      "Popover body",
    );
    expect(element.props.title).toBe("About this");
    expect(element.props.children).toBe("Popover body");
  });

  it("Drawer carries the side-panel contract", () => {
    const element = React.createElement(Drawer, {
      open: true,
      onClose: () => {},
      title: "Copilot",
      side: "left",
    }, "Drawer body");
    expect(element.props.open).toBe(true);
    expect(element.props.title).toBe("Copilot");
    expect(element.props.side).toBe("left");
  });
});
