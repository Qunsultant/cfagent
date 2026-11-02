import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import * as ts from "typescript";

/**
 * Phase 4 CI enforcement pin — negative test (#1772, parent #1717).
 *
 * The live enforcement pin is the #1580 freeze
 * (tests/ux_primitive_usage_freeze_1580.test.ts): any .tsx/.jsx file
 * under src/client, outside components/ui, rendering a raw control
 * (button/input/select/textarea/table) that is not in the allowlist
 * fails CI, and the allowlist is empty. This file is #1772's own
 * negative proof for that pin, so the acceptance criterion "a new raw
 * control outside the primitives directory fails CI" is tested, not
 * asserted:
 *
 * - The freeze test file and the empty allowlist are asserted present
 *   (the pin cannot silently disappear or gain exemptions).
 * - A simulated new-file scan over a temp client tree flags exactly
 *   the files that render raw controls — including a nested file —
 *   and does not flag a primitive-only file or a file that merely
 *   mentions raw tags in comments/strings.
 *
 * The temp-tree scan deliberately re-implements the freeze's AST
 * counting here (same control set) instead of importing the freeze
 * test file, so this pin stays independent of that file's internals
 * and does not double-run its suite. The freeze itself was additionally
 * proved by a live probe run on the audit base: a temporary
 * src/client/__1772_pin_probe.tsx with one raw <button> failed the
 * freeze test with "NEW raw controls ... renders 1 raw control(s)
 * but is not in the allowlist" (see
 * docs/architecture/security/ux-primitives-1772-verification.md).
 * No file is deleted by this slice.
 */

const ROOT = process.cwd();
const FREEZE_TEST = join(ROOT, "tests", "ux_primitive_usage_freeze_1580.test.ts");
const ALLOWLIST_PATH = join(ROOT, "tests", "ux_primitive_usage_allowlist_1580.json");
const EXCEPTIONS_PIN = join(ROOT, "tests", "ux_primitives_exceptions_1772.test.ts");

const RAW_CONTROLS = new Set(["button", "input", "select", "textarea", "table"]);

function countRawControls(source: string, fileName: string): number {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (RAW_CONTROLS.has(node.tagName.getText(sourceFile))) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

/** Scan a client tree the way the freeze does: .tsx/.jsx, raw count > 0. */
function scanClientTree(dir: string): Map<string, number> {
  const flagged = new Map<string, number>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|jsx)$/.test(entry.name)) {
        const count = countRawControls(readFileSync(full, "utf8"), full);
        if (count > 0) flagged.set(relative(dir, full).split(sep).join("/"), count);
      }
    }
  };
  walk(dir);
  return flagged;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("Phase 4 CI enforcement pin (#1772)", () => {
  it("the #1580 freeze pin is present and its allowlist is empty (no exemptions)", () => {
    expect(existsSync(FREEZE_TEST), "freeze test must exist").toBe(true);
    const freeze = readFileSync(FREEZE_TEST, "utf8");
    expect(freeze).toContain("NEW raw controls");
    for (const control of ["button", "input", "select", "textarea", "table"]) {
      expect(freeze, `freeze must count ${control}`).toContain(`"${control}"`);
    }
    expect(existsSync(ALLOWLIST_PATH), "allowlist must exist").toBe(true);
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as { files?: Record<string, number> };
    expect(allowlist.files).toEqual({});
  });

  it("the phases 1-3 exceptions pin is present (Phase 4 builds on it, not instead of it)", () => {
    expect(existsSync(EXCEPTIONS_PIN), "44-file pin must exist").toBe(true);
    expect(readFileSync(EXCEPTIONS_PIN, "utf8")).toContain("ZERO_PRIMITIVE_28");
  });

  it("a new raw-control file is flagged, a nested one too, primitives and mentions are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "1772-pin-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "GoodPanel.tsx"),
      `import { Button, TextInput } from "./components/ui";\nexport const G = () => (<><Button>Go</Button><TextInput /></>);`,
    );
    writeFileSync(
      join(dir, "BadPanel.tsx"),
      `export const B = () => (<><button>Go</button><input type="text" /></>);`,
    );
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "nested", "BadTable.tsx"),
      `export const T = () => (<table><tr><th>H</th><td>V</td></tr></table>);`,
    );
    writeFileSync(
      join(dir, "MentionOnly.tsx"),
      `// <button> in a comment\nconst label = "<input> in a string";\nexport const M = () => (<div>{label}</div>);`,
    );
    const flagged = scanClientTree(dir);
    expect(Object.fromEntries(flagged)).toEqual({
      "BadPanel.tsx": 2,
      "nested/BadTable.tsx": 1,
    });
  });

  it("a raw control added to a previously clean file turns that file flagged (regression shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "1772-pin-regression-"));
    tempDirs.push(dir);
    const file = join(dir, "Panel.tsx");
    const clean = `import { Button } from "./components/ui";\nexport const P = () => (<Button>Go</Button>);`;
    writeFileSync(file, clean);
    expect(scanClientTree(dir).size).toBe(0);
    // Regression: the same file gains a raw <button> and a raw <select>.
    writeFileSync(file, `export const P = () => (<><button>Go</button><select><option>X</option></select></>);`);
    const flagged = scanClientTree(dir);
    expect(flagged.get("Panel.tsx")).toBe(2);
  });
});
