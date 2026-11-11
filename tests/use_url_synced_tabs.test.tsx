/** @vitest-environment jsdom */
/**
 * Shared URL-synced-tabs hook (#1804 S2, issue #2027): one behavior for
 * every tabbed surface — URL read (param, then legacy aliases, then hash),
 * pushState write, back/forward sync, visited-set retention.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useUrlSyncedTabs } from "../src/client/useUrlSyncedTabs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Tab = "stocks" | "options" | "summary";
const isValid = (v: unknown): v is Tab =>
  typeof v === "string" && ["stocks", "options", "summary"].includes(v);

let seen: { active: Tab; visited: Tab[]; change: (t: string) => void } | null = null;

function Probe(props: { param?: string; aliases?: string[]; initialTab?: Tab | null }) {
  const tabs = useUrlSyncedTabs<Tab>({
    param: props.param ?? "view",
    aliases: props.aliases,
    isValid,
    defaultTab: "stocks",
    initialTab: props.initialTab ?? null,
  });
  seen = { active: tabs.activeTab, visited: [...tabs.visitedTabs], change: tabs.handleTabChange };
  return null;
}

describe("useUrlSyncedTabs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const render = (props: React.ComponentProps<typeof Probe>) => {
    act(() => {
      root?.render(React.createElement(Probe, props));
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/screeners");
    seen = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) container.parentNode.removeChild(container);
    root = null;
    container = null;
  });

  it("starts from the ?view= param when valid", () => {
    window.history.replaceState(null, "", "/screeners?view=options");
    render({});
    expect(seen?.active).toBe("options");
    expect(seen?.visited).toEqual(["options"]);
  });

  it("falls back to a legacy alias param", () => {
    window.history.replaceState(null, "", "/screeners?screenerTab=summary");
    render({ aliases: ["screenerTab"] });
    expect(seen?.active).toBe("summary");
  });

  it("lets a valid initialTab prop win at mount and adopts prop changes", () => {
    window.history.replaceState(null, "", "/screeners?view=summary");
    render({ initialTab: "options" });
    expect(seen?.active).toBe("options");
    act(() => {
      seen?.change("summary");
    });
    expect(seen?.active).toBe("summary");
    render({ initialTab: "stocks" });
    expect(seen?.active).toBe("stocks");
  });

  it("falls back to a bare hash tab", () => {
    window.history.replaceState(null, "", "/screeners#options");
    render({});
    expect(seen?.active).toBe("options");
  });

  it("ignores an alias param it was not given and uses the default", () => {
    window.history.replaceState(null, "", "/screeners?screenerTab=summary");
    render({});
    expect(seen?.active).toBe("stocks");
  });

  it("writes pushState on change and grows the visited set", () => {
    render({});
    expect(seen?.active).toBe("stocks");
    act(() => {
      seen?.change("options");
    });
    expect(seen?.active).toBe("options");
    expect(seen?.visited).toEqual(["stocks", "options"]);
    expect(window.location.search).toBe("?view=options");
  });

  it("ignores invalid tab changes", () => {
    render({});
    act(() => {
      seen?.change("bogus");
    });
    expect(seen?.active).toBe("stocks");
    expect(window.location.search).toBe("");
  });

  it("syncs on back/forward (popstate)", () => {
    render({});
    act(() => {
      seen?.change("options");
    });
    expect(seen?.active).toBe("options");
    window.history.replaceState(null, "", "/screeners?view=summary");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(seen?.active).toBe("summary");
    expect(seen?.visited).toEqual(["stocks", "options", "summary"]);
  });

  it("syncs on left-nav navigation (pushState + routechange, issue 2896)", () => {
    render({});
    expect(seen?.active).toBe("stocks");
    act(() => {
      window.history.pushState(null, "", "/screeners?view=options");
      window.dispatchEvent(new Event("routechange"));
    });
    expect(seen?.active).toBe("options");
    expect(seen?.visited).toEqual(["stocks", "options"]);
  });

  it("back/forward to a URL with no tab param adopts the default (#3978)", () => {
    render({});
    act(() => {
      seen?.change("options");
    });
    expect(seen?.active).toBe("options");
    window.history.replaceState(null, "", "/screeners");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(seen?.active).toBe("stocks");
    expect(seen?.visited).toEqual(["stocks", "options"]);
  });
});
