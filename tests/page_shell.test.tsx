/** @vitest-environment jsdom */
/**
 * PageShell contract (#1804 S1, issue #1808): title + scope note +
 * sections, with loading winning over error, error over empty, empty
 * over children — all carried by ui/ primitives, never raw divs.
 *
 * Rendered through React (issue #3125): PageShell reads its chrome
 * mode from PageChromeContext via useContext, so direct function calls
 * no longer work — hooks need a renderer. Default mode is the
 * standalone route (full shell); tab/nested modes are pinned by the
 * #3125 composition tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageShell, PageSection } from "../src/client/components/ui/PageShell";

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

describe("PageShell", () => {
  it("renders title, scope note, and section children", () => {
    render(
      <PageShell title="Social Posting" scopeNote="Today's brief and approvals">
        <PageSection title="Pending">approval cards</PageSection>
      </PageShell>,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Social Posting");
    expect(document.body.textContent).toContain("Today's brief and approvals");
    expect(document.querySelector("h2")?.textContent).toBe("Pending");
    expect(document.body.textContent).toContain("approval cards");
  });

  it("loading shows a Spinner and hides children", () => {
    render(
      <PageShell title="T" loading loadingLabel="Waiting">
        child
      </PageShell>,
    );
    expect(document.querySelector(".ui-page-shell-state")).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Waiting");
    expect(document.body.textContent).not.toContain("child");
  });

  it("error shows a danger Notice and hides children", () => {
    render(
      <PageShell title="T" error="Feed failed">
        child
      </PageShell>,
    );
    expect(document.body.textContent).toContain("Feed failed");
    expect(document.body.textContent).not.toContain("child");
  });

  it("empty shows an EmptyState and hides children", () => {
    render(
      <PageShell title="T" empty emptyTitle="No posts yet" emptyDescription="Nothing submitted">
        child
      </PageShell>,
    );
    expect(document.body.textContent).toContain("No posts yet");
    expect(document.body.textContent).toContain("Nothing submitted");
    expect(document.body.textContent).not.toContain("child");
  });

  it("loading wins over error and empty", () => {
    render(
      <PageShell title="T" loading error="boom" empty>
        child
      </PageShell>,
    );
    expect(document.querySelector(".ui-page-shell-state")).not.toBeNull();
    expect(document.body.textContent).not.toContain("boom");
    expect(document.body.textContent).not.toContain("child");
  });

  it("error wins over empty", () => {
    render(
      <PageShell title="T" error="boom" empty>
        child
      </PageShell>,
    );
    expect(document.body.textContent).toContain("boom");
    expect(document.body.textContent).not.toContain("Nothing here yet");
    expect(document.body.textContent).not.toContain("child");
  });

  it("PageSection renders its title, description, and children", () => {
    render(
      <PageSection title="Token health" description="Per-channel status">
        rows
      </PageSection>,
    );
    expect(document.querySelector("h2")?.textContent).toBe("Token health");
    expect(document.body.textContent).toContain("Per-channel status");
    expect(document.body.textContent).toContain("rows");
  });
});
