import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * UI primitives inventory pin (#492, Direction 4).
 *
 * The composable-UX program only holds if the primitive set is the single
 * place recurring elements live. This pin keeps a REVIEWED inventory:
 *
 * - Every component file in src/client/components/ui/ must be listed
 *   below (a new primitive joins the inventory in its own PR, with tests).
 * - Every inventoried primitive must be exported from the ui barrel and
 *   exercised in tests/composable_ui_primitives.test.ts.
 * - No file outside components/ui may define a component with a
 *   primitive's name (no page-local duplicates of a primitive's role).
 */

const ROOT = process.cwd();
const UI_DIR = join(ROOT, "src/client/components/ui");
const CLIENT_DIR = join(ROOT, "src/client");

/** Reviewed inventory: ui source file -> exported primitive components. */
const INVENTORY: Record<string, string[]> = {
  "SegmentedControl.tsx": ["SegmentedControl"],
  "PillGroup.tsx": ["PillGroup"],
  "Badge.tsx": ["Badge"],
  "Button.tsx": ["Button"],
  "Spinner.tsx": ["Spinner"],
  "EmptyState.tsx": ["EmptyState"],
  "Card.tsx": ["Card"],
  "Notice.tsx": ["Notice"],
  "Tabs.tsx": ["Tabs", "TabPanel"],
  "TextInput.tsx": ["TextInput"],
  "Select.tsx": ["Select"],
  // #1169 knowledge UI (disclosed inventory update): the file
  // picker joins as a primitive so no tab renders a raw control.
  "FileInput.tsx": ["FileInput"],
  "Checkbox.tsx": ["Checkbox"],
  "Modal.tsx": ["Modal"],
  "Table.tsx": ["Table"],
  "Skeleton.tsx": ["Skeleton"],
  "PageShell.tsx": ["PageShell", "PageSection"],
  // #2283 global toast: the single home for transient feedback.
  "Toast.tsx": ["ToastProvider", "useToast"],
  // #2283 stream 5: anchored surfaces join as primitives.
  "Menu.tsx": ["Menu"],
  "Popover.tsx": ["Popover"],
  "Drawer.tsx": ["Drawer"],
};

/** Non-primitive files allowed in components/ui (helpers + styles). */
const HELPERS = new Set(["Field.tsx", "segmentedNavigation.ts", "index.ts", "primitives.css", "anchorPosition.ts"]);

const ALL_PRIMITIVES = Object.values(INVENTORY).flat();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("UI primitives inventory pin (#492)", () => {
  it("every inventoried primitive file exists and is exported + tested", () => {
    const barrel = readFileSync(join(UI_DIR, "index.ts"), "utf8");
    const primitiveTests = readFileSync(join(ROOT, "tests/composable_ui_primitives.test.ts"), "utf8");
    for (const [file, names] of Object.entries(INVENTORY)) {
      expect(existsSync(join(UI_DIR, file)), file).toBe(true);
      for (const name of names) {
        expect(barrel, `${name} exported from ui barrel`).toContain(name);
        expect(primitiveTests, `${name} exercised in composable_ui_primitives.test.ts`).toContain(name);
      }
    }
  });

  it("no unreviewed files in components/ui", () => {
    const onDisk = readdirSync(UI_DIR);
    for (const file of onDisk) {
      expect(
        file in INVENTORY || HELPERS.has(file),
        `${file} must join the reviewed inventory (with tests) or the helpers list`,
      ).toBe(true);
    }
  });

  it("no component outside components/ui duplicates a primitive's name", () => {
    const offenders: string[] = [];
    const defRe = new RegExp(
      `export\\s+(?:function|const|class)\\s+(${ALL_PRIMITIVES.join("|")})\\b`,
    );
    for (const file of walk(CLIENT_DIR)) {
      if (file.startsWith(UI_DIR)) continue;
      if (!/\.(tsx|ts)$/.test(file)) continue;
      if (defRe.test(readFileSync(file, "utf8"))) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
