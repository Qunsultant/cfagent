/** @vitest-environment jsdom */
/**
 * PageTemplate contract (#3131, Part of #2150): the template layer
 * between primitives and pages. Slots as props in canonical order —
 * header (PageShell title + scope note), context strip, KPI ribbon,
 * workspace (children), action bar, queue rail — with the PageShell
 * states carried through and the three chrome hosts preserved
 * (page/tab/nested, #3125): the SAME template renders in all three
 * hosts with zero changes to itself.
 *
 * Rendered through React: PageTemplate renders PageShell, which reads
 * its chrome mode from PageChromeContext via useContext.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageTemplate } from "../src/client/components/ui/PageTemplate";
import { PageChromeContext } from "../src/client/components/ui/PageShell";

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

function slotOrder(): number[] {
  const text = document.body.textContent ?? "";
  return ["context", "kpi", "workspace", "actions", "queue"].map((s) =>
    text.indexOf(s),
  );
}

describe("PageTemplate", () => {
  it("renders title, scope note, and workspace children in the page host", () => {
    render(
      <PageTemplate title="Risk Analysis" scopeNote="Symbol-based risk profile">
        <section>workspace content</section>
      </PageTemplate>,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Risk Analysis");
    expect(document.body.textContent).toContain("Symbol-based risk profile");
    expect(document.body.textContent).toContain("workspace content");
  });

  it("renders slots in canonical order: context strip, KPI ribbon, workspace, action bar, queue rail", () => {
    render(
      <PageTemplate
        title="T"
        contextStrip={<div>context</div>}
        kpiRibbon={<div>kpi</div>}
        actionBar={<div>actions</div>}
        queueRail={<div>queue</div>}
      >
        <div>workspace</div>
      </PageTemplate>,
    );
    const order = slotOrder();
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders with no slots: children are the workspace", () => {
    render(
      <PageTemplate title="T">
        <div>only workspace</div>
      </PageTemplate>,
    );
    expect(document.body.textContent).toContain("only workspace");
  });

  it("loading shows a Spinner and hides slots and children", () => {
    render(
      <PageTemplate title="T" loading loadingLabel="Waiting" contextStrip={<div>context</div>}>
        child
      </PageTemplate>,
    );
    expect(document.querySelector(".ui-page-shell-state")).not.toBeNull();
    expect(document.body.textContent).not.toContain("child");
    expect(document.body.textContent).not.toContain("context");
  });

  it("error shows a danger Notice and hides children", () => {
    render(
      <PageTemplate title="T" error="Something broke">
        child
      </PageTemplate>,
    );
    expect(document.body.textContent).toContain("Something broke");
    expect(document.body.textContent).not.toContain("child");
  });

  it("empty shows EmptyState and hides children", () => {
    render(
      <PageTemplate title="T" empty emptyTitle="Nothing here yet">
        child
      </PageTemplate>,
    );
    expect(document.body.textContent).toContain("Nothing here yet");
    expect(document.body.textContent).not.toContain("child");
  });

  it("tab host: no h1, content only — the same template, no edits", () => {
    render(
      <PageChromeContext.Provider value="tab">
        <PageTemplate title="Risk Analysis" scopeNote="scope">
          <div>workspace content</div>
        </PageTemplate>
      </PageChromeContext.Provider>,
    );
    expect(document.querySelector("h1")).toBeNull();
    expect(document.body.textContent).toContain("workspace content");
  });

  it("nested host: Card surface with the title as card heading, never a second h1", () => {
    render(
      <PageChromeContext.Provider value="nested">
        <PageTemplate title="Risk Analysis" scopeNote="scope">
          <div>workspace content</div>
        </PageTemplate>
      </PageChromeContext.Provider>,
    );
    expect(document.querySelector("h1")).toBeNull();
    expect(document.querySelector(".ui-card")).not.toBeNull();
    expect(document.querySelector("h2")?.textContent).toBe("Risk Analysis");
    expect(document.body.textContent).toContain("workspace content");
  });
});
