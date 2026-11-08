/**
 * new-page scaffold generator test (issue #3080).
 *
 * Runs scripts/new-page.mjs against temp copies of the files it edits
 * and asserts every write — never the real repo tree. Proves the
 * generator keeps a scaffolded page conformant by construction:
 * route sorted + wired to TAB_CONTENT + gate entries + pin test +
 * fragment + count pins bumped.
 */
import { describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = join(__dirname, "..");
const SCRIPT = join(HERE, "scripts", "new-page.mjs");
const SOURCES = [
  "src/client/nav-config.json",
  "src/client/Chat.tsx",
  "src/client/components/NavigationMenu.tsx",
  "tests/ux_conformance_gates_3047.test.ts",
  "tests/nav_config_data_2977.test.ts",
  "tests/route_table.test.ts",
  "tests/nav_unique_icons_badges.test.ts",
];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "new-page-"));
  for (const rel of SOURCES) {
    const src = join(HERE, rel);
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: false });
  }
  return dir;
}

function run(tmp: string, args: string[]): string {
  return execFileSync("node", [SCRIPT, "--root", tmp, ...args], {
    encoding: "utf8",
    timeout: 30000,
  });
}

function read(tmp: string, rel: string): string {
  return readFileSync(join(tmp, rel), "utf8");
}

function cleanup(tmp: string): void {
  rmSync(tmp, { recursive: true, force: true });
}

describe("new-page scaffold (issue #3080)", () => {
  it("scaffolds a conformant page without a nav entry", () => {
    const tmp = makeTmp();
    try {
      run(tmp, [
        "--id", "scaffold-probe",
        "--title", "Scaffold probe",
        "--description", "Probe page for the scaffold generator",
        "--category", "Platform",
        "--issue", "3080",
      ]);
      const nav = JSON.parse(read(tmp, "src/client/nav-config.json")) as {
        routes: { id: string; navEntry?: unknown }[];
      };
      const ids = nav.routes.map((r) => r.id);
      expect(ids).toContain("scaffold-probe");
      expect([...ids].sort()).toEqual(ids);
      expect(
        nav.routes.find((r) => r.id === "scaffold-probe")!.navEntry,
      ).toBeUndefined();
      const chat = read(tmp, "src/client/Chat.tsx");
      expect(chat).toContain('import { ScaffoldProbePanel } from "./ScaffoldProbePanel";');
      expect(chat).toContain('    "scaffold-probe": (');
      expect(chat).toContain("<ScaffoldProbePanel />");
      const gate = read(tmp, "tests/ux_conformance_gates_3047.test.ts");
      expect(gate).toContain('"scaffold-probe": "src/client/ScaffoldProbePanel.tsx"');
      expect(gate).toContain('"scaffold-probe",');
      const panel = read(tmp, "src/client/ScaffoldProbePanel.tsx");
      expect(panel).toContain('<PageShell title="Scaffold probe"');
      // Built, not literal, so this test file itself carries no inline-style text.
      expect(panel).not.toContain("style" + "{{");
      expect(panel).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(existsSync(join(tmp, "tests/ux_scaffold_scaffold-probe.test.ts"))).toBe(true);
      expect(existsSync(join(tmp, "changelog.d/3080-scaffold-probe.md"))).toBe(true);
      // No nav entry: the nav-count pins are untouched (route count itself is
      // asserted dynamically, ROUTES vs nav-config.json, so it needs no bump).
      const navData = read(tmp, "tests/nav_config_data_2977.test.ts");
      expect(navData).toContain("expect(orders).toHaveLength(31);");
      const routeTable = read(tmp, "tests/route_table.test.ts");
      expect(routeTable).toContain("expect(nav).toHaveLength(31);");
      // EXPECTED_IDS gains the new id in sorted position (between
      // risk-analysis and scanner).
      expect(routeTable.replace(/\r\n/g, "\n")).toContain('  "scaffold-probe",\n  "scanner",');
      const badges = read(tmp, "tests/nav_unique_icons_badges.test.ts");
      expect(badges).toContain("const NAV_COUNT = 31;");
      // Duplicate id fails instead of overwriting.
      expect(() =>
        run(tmp, [
          "--id", "scaffold-probe",
          "--title", "Again",
          "--description", "x",
          "--category", "Platform",
        ]),
      ).toThrow();
    } finally {
      cleanup(tmp);
    }
  });

  it("scaffolds a nav entry with --nav, bumping every nav pin", () => {
    const tmp = makeTmp();
    try {
      run(tmp, [
        "--id", "scaffold-nav-probe",
        "--title", "Scaffold nav probe",
        "--description", "Nav probe page",
        "--category", "Platform",
        "--issue", "3080",
        "--nav",
        "--icon", "Reports",
        "--badge", "Probe",
      ]);
      const nav = JSON.parse(read(tmp, "src/client/nav-config.json")) as {
        routes: { id: string; navEntry?: { navOrder: number; badge: string; badgeType: string } }[];
      };
      const entry = nav.routes.find((r) => r.id === "scaffold-nav-probe")!.navEntry!;
      expect(entry.navOrder).toBe(31);
      expect(entry.badge).toBe("Probe");
      expect(entry.badgeType).toBe("neutral");
      const navData = read(tmp, "tests/nav_config_data_2977.test.ts");
      expect(navData).toContain("expect(orders).toHaveLength(32);");
      expect(navData).toContain("Array.from({ length: 32 }");
      const routeTable = read(tmp, "tests/route_table.test.ts");
      expect(routeTable).toContain("expect(nav).toHaveLength(32);");
      expect(routeTable).toContain("Array.from({ length: 32 }");
      expect(routeTable.replace(/\r\n/g, "\n")).toContain('  "scaffold-nav-probe",\n  "scanner",');
      const badges = read(tmp, "tests/nav_unique_icons_badges.test.ts");
      expect(badges).toContain("const NAV_COUNT = 32;");
    } finally {
      cleanup(tmp);
    }
  });

  it("rejects a bad category and a colliding badge", () => {
    const tmp = makeTmp();
    try {
      expect(() =>
        run(tmp, [
          "--id", "bad-cat",
          "--title", "Bad",
          "--description", "x",
          "--category", "Nope",
        ]),
      ).toThrow();
      expect(() =>
        run(tmp, [
          "--id", "bad-badge",
          "--title", "Bad",
          "--description", "x",
          "--category", "Platform",
          "--nav",
          "--icon", "Reports",
          "--badge", "PDF",
        ]),
      ).toThrow();
    } finally {
      cleanup(tmp);
    }
  });
});
