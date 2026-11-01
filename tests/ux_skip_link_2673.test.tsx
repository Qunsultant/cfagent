/** @vitest-environment jsdom */
import React from "react";
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SkipLink } from "../src/client/components/ui/SkipLink";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));

describe("SkipLink (#2673 slice 6)", () => {
  it("renders an anchor to main content", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<SkipLink />);
    });
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("#main-content");
    expect(anchor?.textContent).toContain("Skip to main content");
    expect(anchor?.className).toContain("ui-skip-link");
  });

  it("has a visually-hidden-until-focus treatment in primitives.css", () => {
    const css = readFileSync(
      join(here, "..", "src", "client", "components", "ui", "primitives.css"),
      "utf8",
    );
    expect(css).toContain(".ui-skip-link");
    expect(css).toContain(".ui-skip-link:focus-visible");
  });

  it("is the first child of the app root and targets a labeled main region", () => {
    const chat = readFileSync(join(here, "..", "src", "client", "Chat.tsx"), "utf8");
    expect(chat).toContain("<SkipLink");
    expect(chat).toContain('id="main-content"');
  });
});
