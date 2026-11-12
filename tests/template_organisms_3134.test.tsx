/** @vitest-environment jsdom */
/**
 * Template organisms III (#3134, Part of #2150): WorkspaceGrid,
 * ActionBar, QueueFeed — the grid, the closing actions, and the
 * closing queue the beautiful pages hand-roll today (order ticket
 * 1.4fr/1fr layout, per-page button rows, approvals queue below the
 * ticket), rebuilt as primitives with token-only styling.
 *
 * Each organism reproduces its hand-rolled original's structure
 * (verified against styles.css `.order-ticket-layout` :4460,
 * OrderTicketPanel.tsx's button rows, and ApprovalsPanel as rendered
 * in Chat.tsx:972): same children in the same order, same 1.4fr/1fr
 * ratio with the same 900px collapse, same primary-right /
 * secondary-left action placement, same queue surface. Deliberate
 * deltas, all required by design-system §1.6b: no outer margin on
 * any organism (slot spacing is the template's Stack gap); the
 * list-detail ratio is a primitives.css class, not a bespoke
 * stylesheet rule; QueueFeed's empty state is the EmptyState
 * primitive, not a hand-rolled empty card. No page migrates in this
 * slice (Wave 1, #3138–#3140), so nothing visual changes anywhere.
 *
 * Rule of three: workspace/list-detail/feed are THE grid variants,
 * no fourth — pinned below.
 *
 * Rendered through React, same harness as template_organisms_3132.test.tsx.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceGrid } from "../src/client/components/ui/WorkspaceGrid";
import { ActionBar } from "../src/client/components/ui/ActionBar";
import { QueueFeed } from "../src/client/components/ui/QueueFeed";
import { Button } from "../src/client/components/ui/Button";
import { PageTemplate } from "../src/client/components/ui/PageTemplate";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
}

afterEach(() => {
  if (root) root.unmount();
  root = undefined as any;
  container?.remove();
});

describe("WorkspaceGrid (#3134 — order ticket layout, styles.css:4460)", () => {
  it("workspace variant renders sections in an auto-fit grid", () => {
    render(
      <WorkspaceGrid variant="workspace">
        <div>section one</div>
        <div>section two</div>
      </WorkspaceGrid>,
    );
    const grid = document.querySelector(".ui-grid.autofit-md.ui-workspace-grid.variant-workspace");
    expect(grid).not.toBeNull();
    expect(document.body.textContent).toContain("section one");
    expect(document.body.textContent).toContain("section two");
    // The order-workspace gap is the default (Stack gap 4).
    expect(grid?.classList.contains("gap-4")).toBe(true);
  });

  it("workspace variant honors an explicit floor and gap", () => {
    render(
      <WorkspaceGrid variant="workspace" minColumnWidth="lg" gap="2">
        <div>section one</div>
      </WorkspaceGrid>,
    );
    expect(document.querySelector(".ui-grid.autofit-lg")).not.toBeNull();
    expect(document.querySelector(".ui-grid.gap-2")).not.toBeNull();
  });

  it("list-detail variant carries the 1.4fr/1fr hook (Grid is equal columns only)", () => {
    render(
      <WorkspaceGrid variant="list-detail">
        <div>detail</div>
        <div>list</div>
      </WorkspaceGrid>,
    );
    const grid = document.querySelector(".ui-grid.ui-workspace-grid.variant-list-detail");
    expect(grid).not.toBeNull();
    expect(document.body.textContent).toContain("detail");
    expect(document.body.textContent).toContain("list");
  });

  it("feed variant renders a single column", () => {
    render(
      <WorkspaceGrid variant="feed">
        <div>row one</div>
        <div>row two</div>
      </WorkspaceGrid>,
    );
    expect(document.querySelector(".ui-grid.cols-1.ui-workspace-grid.variant-feed")).not.toBeNull();
  });

  it("renders nothing with no children (slot rule, §1.6b)", () => {
    render(<WorkspaceGrid variant="workspace">{null}</WorkspaceGrid>);
    expect(document.querySelector(".ui-workspace-grid")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
});

describe("WorkspaceGrid breakpoints + rule of three (#3134, §1.6b)", () => {
  it("the three variants are exactly workspace, list-detail, feed — no fourth", () => {
    render(
      <>
        <WorkspaceGrid variant="workspace">
          <div>w</div>
        </WorkspaceGrid>
        <WorkspaceGrid variant="list-detail">
          <div>d</div>
        </WorkspaceGrid>
        <WorkspaceGrid variant="feed">
          <div>f</div>
        </WorkspaceGrid>
      </>,
    );
    const variants = [...document.querySelectorAll(".ui-workspace-grid")]
      .map((el) => [...el.classList].find((c) => c.startsWith("variant-")))
      .sort();
    expect(variants).toEqual(["variant-feed", "variant-list-detail", "variant-workspace"]);
  });

  it("list-detail collapses below 900px — the compact breakpoint, in primitives.css", () => {
    const css = readFileSync(
      join(process.cwd(), "src/client/components/ui/primitives.css"),
      "utf8",
    );
    expect(css).toContain(".ui-workspace-grid.variant-list-detail { grid-template-columns: 1.4fr 1fr; }");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain(".ui-workspace-grid.variant-list-detail { grid-template-columns: 1fr; }");
  });

  it("the breakpoint scale is named in the spec (§1.6b)", () => {
    const spec = readFileSync(
      join(process.cwd(), "docs/architecture/UX/consolidated-design-system.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(spec).toContain("compact <900px");
    expect(spec).toContain("medium 900–1440px");
    expect(spec).toContain("expanded >1440px");
  });
});

describe("ActionBar (#3134 — per-page button rows)", () => {
  it("renders secondary left, primary right (pushed), both as Buttons", () => {
    render(
      <ActionBar
        primary={<Button variant="primary">Submit order</Button>}
        secondary={<Button variant="secondary">Save draft</Button>}
      />,
    );
    expect(document.querySelector(".ui-action-bar")).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Save draft")).toBeLessThan(text.indexOf("Submit order"));
    // Primary is pushed right with .ui-push; secondary reads first.
    expect(document.querySelector(".ui-action-bar .ui-push")?.textContent).toBe("Submit order");
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.classList.contains("ui-btn")).toBe(true);
    }
  });

  it("renders a primary-only bar pushed right, and a secondary-only bar on the left", () => {
    render(
      <ActionBar primary={<Button variant="primary">Submit order</Button>} />,
    );
    expect(document.querySelector(".ui-action-bar .ui-push")?.textContent).toBe("Submit order");
    act(() => { root.unmount(); });
    container.remove();
    render(
      <ActionBar secondary={<Button variant="secondary">Save draft</Button>} />,
    );
    expect(document.querySelector(".ui-action-bar .ui-push")).toBeNull();
    expect(document.body.textContent).toContain("Save draft");
  });

  it("renders nothing with neither action (slot rule, §1.6b)", () => {
    render(<ActionBar />);
    expect(document.querySelector(".ui-action-bar")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("renders no raw controls — every button is the Button primitive", () => {
    render(
      <ActionBar
        primary={<Button variant="primary">Submit order</Button>}
        secondary={
          <>
            <Button variant="secondary">Save draft</Button>
            <Button variant="ghost">Cancel</Button>
          </>
        }
      />,
    );
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.classList.contains("ui-btn"))).toBe(true);
  });
});

describe("QueueFeed (#3134 — approvals queue, Chat.tsx:972)", () => {
  const items = [
    { id: "a1", content: "Order A — $3,383.20 — expires in 12:00" },
    { id: "a2", content: "Order B — $1,204.00 — expires in 08:30" },
  ];

  it("renders title + meta through CardHeader, items in order", () => {
    render(<QueueFeed title="Approvals" meta="3 pending" items={items} />);
    expect(document.querySelector(".ui-queue-feed")).not.toBeNull();
    expect(document.querySelector(".ui-card-header h4")?.textContent).toBe("Approvals");
    expect(document.querySelector(".ui-card-header .ui-push")?.textContent).toBe("3 pending");
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Order A")).toBeLessThan(text.indexOf("Order B"));
    expect(text).toContain("expires in 12:00");
  });

  it("renders items without a title — no header, only the feed", () => {
    render(<QueueFeed items={items} />);
    expect(document.querySelector(".ui-queue-feed")).not.toBeNull();
    expect(document.querySelector(".ui-card-header")).toBeNull();
    expect(document.body.textContent).toContain("Order A");
  });

  it("empty queue shows the EmptyState, not a blank card", () => {
    render(<QueueFeed title="Approvals" items={[]} />);
    expect(document.querySelector(".ui-queue-feed .ui-empty")).not.toBeNull();
    expect(document.querySelector(".ui-empty-title")?.textContent).toBe("Nothing in the queue");
  });

  it("empty state honors a custom title and description", () => {
    render(
      <QueueFeed
        title="Approvals"
        items={[]}
        emptyTitle="All caught up"
        emptyDescription="No orders are waiting for approval."
      />,
    );
    expect(document.querySelector(".ui-empty-title")?.textContent).toBe("All caught up");
    expect(document.body.textContent).toContain("No orders are waiting for approval.");
  });
});

describe("no organism sets its own outer margin or inline style (#3134, §1.6b)", () => {
  it("workspace grid, action bar, and queue feed roots carry no inline style", () => {
    render(
      <>
        <WorkspaceGrid variant="workspace">
          <div>section</div>
        </WorkspaceGrid>
        <ActionBar primary={<Button variant="primary">Go</Button>} />
        <QueueFeed title="Approvals" items={[{ id: "a1", content: "Order A" }]} />
      </>,
    );
    for (const hook of [".ui-workspace-grid", ".ui-action-bar", ".ui-queue-feed"]) {
      expect(document.querySelector(hook)?.getAttribute("style")).toBeNull();
    }
  });
});

describe("organisms drop into PageTemplate slots in canonical order", () => {
  it("workspace grid, then action bar, then queue rail — no movement, no new chrome", () => {
    render(
      <PageTemplate
        title="T"
        actionBar={<ActionBar primary={<Button variant="primary">Submit order</Button>} />}
        queueRail={<QueueFeed title="Approvals" items={[{ id: "a1", content: "Order A" }]} />}
      >
        <WorkspaceGrid variant="workspace">
          <div>workspace section</div>
        </WorkspaceGrid>
      </PageTemplate>,
    );
    const text = document.body.textContent ?? "";
    expect(text.indexOf("workspace section")).toBeGreaterThan(-1);
    expect(text.indexOf("Submit order")).toBeGreaterThan(text.indexOf("workspace section"));
    expect(text.indexOf("Order A")).toBeGreaterThan(text.indexOf("Submit order"));
  });
});
