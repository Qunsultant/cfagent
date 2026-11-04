/**
 * UX uniformity, epic #3046 slice #3048 — layout primitives.
 *
 * Stack/Flex/Grid are the componentized form of the hand-rolled flex
 * layouts that dominate the hubs (ResearchHub 71 inline styles,
 * WorkflowsHub 81, all token-valued but none componentized). Props take
 * token-scale names only — no raw values at call sites — and every
 * prop maps to a class in primitives.css, so a migrated element drops
 * its style={{ }} entirely (the #3047 gate counts occurrences).
 */
import { describe, it, expect } from "vitest";
import { Stack, Flex, Grid } from "../src/client/components/ui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(process.cwd(), "src", "client", "components", "ui");
const CLIENT_DIR = join(process.cwd(), "src", "client");

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i) && (i === 0 || src[i - 1] !== ":")) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j;
    } else if (src.startsWith("/*", i)) {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      out += "\n".repeat(src.slice(i, end).split("\n").length - 1);
      i = end;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

function inlineStyleCount(file: string): number {
  const src = stripComments(readFileSync(join(CLIENT_DIR, file), "utf8"));
  return (src.match(/style=\{\{/g) ?? []).length;
}

describe("Layout primitives (#3048)", () => {
  describe("Stack", () => {
    it("maps gap scale to classes, defaulting to gap-0", () => {
      const el = Stack({ gap: "5", children: [] });
      expect(el.props.className).toContain("ui-stack");
      expect(el.props.className).toContain("gap-5");
      const def = Stack({ children: [] });
      expect(def.props.className).toContain("gap-0");
    });

    it("maps align and justify modifiers", () => {
      const el = Stack({ align: "center", justify: "between", children: [] });
      expect(el.props.className).toContain("align-center");
      expect(el.props.className).toContain("justify-between");
    });

    it("passes div attributes through (tabpanel semantics survive migration)", () => {
      const el = Stack({ gap: "5", role: "tabpanel", id: "workflows-panel-faq", "aria-labelledby": "workflows-tab-faq", children: [] });
      expect(el.props.role).toBe("tabpanel");
      expect(el.props.id).toBe("workflows-panel-faq");
      expect(el.props["aria-labelledby"]).toBe("workflows-tab-faq");
    });
  });

  describe("Flex", () => {
    it("renders a block flex row by default, inline and wrap on request", () => {
      const row = Flex({ gap: "2", children: [] });
      expect(row.props.className).toContain("ui-flex");
      expect(row.props.className).not.toContain("inline");
      expect(row.props.className).not.toContain("wrap");
      const inline = Flex({ inline: true, gap: "1-5", align: "center", children: [] });
      expect(inline.props.className).toContain("inline");
      expect(inline.props.className).toContain("gap-1-5");
      expect(inline.props.className).toContain("align-center");
      const wrapped = Flex({ wrap: true, gap: "3", children: [] });
      expect(wrapped.props.className).toContain("wrap");
    });

    it("renders a span when as='span' (inline-flex rows inside text flow)", () => {
      const el = Flex({ as: "span", gap: "1-5", align: "center", children: [] });
      expect(el.type).toBe("span");
    });
  });

  describe("Grid", () => {
    it("maps a column count to a cols class", () => {
      const el = Grid({ columns: 3, gap: "3", children: [] });
      expect(el.props.className).toContain("ui-grid");
      expect(el.props.className).toContain("cols-3");
    });

    it("maps auto-fit min-width presets to autofit classes", () => {
      const el = Grid({ autoFit: true, minColumnWidth: "lg", gap: "5", children: [] });
      expect(el.props.className).toContain("autofit-lg");
      expect(el.props.className).toContain("gap-5");
    });
  });

  describe("primitives.css carries every mapped class", () => {
    it("defines layout base classes, gap rules, modifiers, cols and autofit presets", () => {
      const css = readFileSync(join(UI_DIR, "primitives.css"), "utf8");
      for (const cls of ["ui-stack", "ui-flex", "ui-grid"]) {
        expect(css).toContain(`.${cls}`);
      }
      for (const scale of ["0", "1-5", "2", "3", "5"]) {
        expect(css).toContain(`gap-${scale}`);
      }
      for (const cls of ["align-center", "justify-between", "justify-center", "wrap", "inline", "cols-3", "autofit-lg"]) {
        expect(css).toContain(cls);
      }
    });
  });

  describe("proving migration (#3048)", () => {
    it("exports Stack, Flex, Grid from the ui index", () => {
      const index = readFileSync(join(UI_DIR, "index.ts"), "utf8");
      expect(index).toContain("Stack");
      expect(index).toContain("Flex");
      expect(index).toContain("Grid");
    });

    it("both hubs import the layout primitives", () => {
      for (const hub of ["MarketDataResearchHub.tsx", "WorkflowsHub.tsx"]) {
        const src = readFileSync(join(CLIENT_DIR, hub), "utf8");
        const importLine = src.split("\n").find((l) => l.includes("./components/ui"));
        expect(importLine).toContain("Stack");
        expect(importLine).toContain("Flex");
        expect(importLine).toContain("Grid");
      }
    });

    it("both hubs' inline counts drop (pure-layout blocks migrated, no visual change)", () => {
      expect(inlineStyleCount("MarketDataResearchHub.tsx")).toBeLessThanOrEqual(60);
      expect(inlineStyleCount("WorkflowsHub.tsx")).toBeLessThanOrEqual(70);
    });
  });
});
