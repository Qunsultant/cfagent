/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownContent } from "../src/client/chat/MarkdownContent";

/**
 * OWASP ASI-03 untrusted content (Qunsultant/cfagent#1773, item 7):
 * agent responses render through MarkdownContent, so unsafe links
 * and HTML in model output must not execute. The renderer is safe
 * by construction today — it builds React text nodes (bold, inline
 * code, code blocks, lists), parses no links, and uses no innerHTML
 * — but nothing pinned that property, so a future renderer change
 * could silently introduce link/HTML handling. This suite pins it:
 * hostile model output renders as inert text, with no script, img,
 * svg, iframe, or anchor element created, and no executable href.
 *
 * This is a verification pin, not a behavior change: the assertions
 * pass on the current renderer. The negative control at the end
 * proves the assertions bite — the same queries detect an unsafe
 * renderer that injects the same payloads as HTML.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderMarkdown(text: string): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<MarkdownContent text={text} />);
  });
  return { container, root };
}

function unmount(rendered: { container: HTMLDivElement; root: Root }): void {
  act(() => {
    rendered.root.unmount();
  });
  rendered.container.remove();
  document.body.innerHTML = "";
}

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "<iframe src=javascript:alert(1)></iframe>",
  "[click me](javascript:alert(1))",
  "[click me](data:text/html,<script>alert(1)</script>)",
  "[click me](vbscript:msgbox(1))",
  "<a href=\"javascript:alert(1)\">click me</a>",
  "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">click me</a>",
  "<math><mi//xlink:href=\"data:x,<script>alert(1)</script>\">",
].join("\n\n");

describe("MarkdownContent safe rendering (#1773, ASI-03)", () => {
  it("creates no script, img, svg, iframe, or anchor element from hostile model output", () => {
    const rendered = renderMarkdown(HOSTILE);
    try {
      for (const tag of ["script", "img", "svg", "iframe", "a", "form", "object", "embed"]) {
        expect(
          rendered.container.querySelector(tag),
          `hostile markdown must not create a <${tag}> element`,
        ).toBeNull();
      }
    } finally {
      unmount(rendered);
    }
  });

  it("creates no executable href anywhere in the rendered output", () => {
    const rendered = renderMarkdown(HOSTILE);
    try {
      for (const anchor of Array.from(rendered.container.querySelectorAll("[href]"))) {
        const href = (anchor.getAttribute("href") ?? "").trim().toLowerCase();
        expect(href).not.toMatch(/^(javascript|data|vbscript):/);
      }
      // Structural, not substring: escaped text legitimately contains
      // the literal "onerror=" inside &lt;…&gt; text. What must not
      // exist is an element CARRYING an event-handler attribute.
      for (const el of Array.from(rendered.container.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes).map((a) => a.name.toLowerCase())) {
          expect(attr.startsWith("on"), `no element may carry an ${attr} handler attribute`).toBe(false);
        }
      }
    } finally {
      unmount(rendered);
    }
  });

  it("renders the hostile payloads as inert text, not as markup", () => {
    const rendered = renderMarkdown("<script>alert(1)</script>");
    try {
      expect(rendered.container.textContent ?? "").toContain("alert(1)");
      expect(rendered.container.querySelector("script")).toBeNull();
    } finally {
      unmount(rendered);
    }
  });

  it("keeps legitimate markdown working: bold, inline code, and code blocks", () => {
    const rendered = renderMarkdown("Hello **bold** and `code`.\n\n```json\n{\"a\": 1}\n```");
    try {
      expect(rendered.container.querySelector("strong")?.textContent).toBe("bold");
      expect(rendered.container.querySelector("code")?.textContent).toContain("code");
      expect(rendered.container.querySelector("pre")?.textContent).toContain('{"a": 1}');
    } finally {
      unmount(rendered);
    }
  });

  it("pins the renderer source: no innerHTML in the markdown path", () => {
    const root = join(__dirname, "..");
    for (const file of ["src/client/chat/MarkdownContent.tsx", "src/client/chat/renderInlineFormatted.tsx"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, `${file} must not use innerHTML`).not.toContain("dangerouslySetInnerHTML");
      expect(source, `${file} must not use innerHTML`).not.toContain("innerHTML");
    }
  });

  it("negative control: the same queries detect an unsafe renderer", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      container.innerHTML = HOSTILE;
      expect(container.querySelector("script")).not.toBeNull();
      expect(container.querySelector("img")).not.toBeNull();
      expect(container.querySelector("a[href^=\"javascript:\"]")).not.toBeNull();
    } finally {
      container.remove();
      document.body.innerHTML = "";
    }
  });
});
