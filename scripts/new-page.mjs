#!/usr/bin/env node
/**
 * Scaffold a new shell-conforming page (UX-as-product creation-time
 * enforcement). A page created by hand must touch six places, several
 * guarded by exact-count pins; this generator touches all of them so a
 * new page is conformant by construction and the suite stays green.
 *
 * Usage:
 *   node scripts/new-page.mjs --id risk-limits --title "Risk limits" \
 *     --description "…" --category Execution [--issue 30xx] [--nav ...]
 *
 * What it writes:
 *   1. src/client/<Component>Panel.tsx — PageShell + PageSection, primitives
 *      only, zero inline styles, zero hex (token ratchet + inline budgets).
 *   2. src/client/nav-config.json — route entry, ids kept sorted ascending
 *      (nav_config_data_2977 pin). Without --nav the route has no navEntry:
 *      it renders via TAB_CONTENT and is reachable by ?tab=<id>, but it
 *      does not consume a nav slot, icon, badge, or navOrder.
 *   3. src/client/Chat.tsx — panel import (with the other top-level panel
 *      imports) + TAB_CONTENT entry (route_content_switch_1804 pin).
 *   4. tests/ux_conformance_gates_3047.test.ts — CONFORMING_ROUTES entry and
 *      EXPECTED_TAB_CONTENT_KEYS entry (route shell conformance gate).
 *   5. tests/ux_scaffold_<id>.test.ts — pin test asserting 1–4.
 *   6. changelog.d/<issue>-<id>.md (or new-page-<id>.md) — Policy Gate
 *      fragment (first line must be `### <Section>`).
 *   7. With --nav additionally: navOrder = max + 1, nav-count pins bumped
 *      (nav_config_data_2977 navOrders, route_table nav entries, NAV_COUNT
 *      — all move together, cross-checked). The route count itself needs no
 *      bump: it is asserted dynamically (nav_config_data_2977 compares
 *      ROUTES against nav-config.json). Badge + icon uniqueness guarded.
 *
 * Guards (fail, do not overwrite): id already a route / gate entry /
 * TAB_CONTENT key, panel or test file already exists, bad category,
 * title/description containing characters illegal in a JSX attribute
 * string (", <, >, newline). With --nav: badge collision
 * (case-insensitive), icon reuse, or an icon key missing from
 * NavigationMenu's NavIcons map all fail with instructions.
 *
 * Flags:
 *   --id <kebab-case>        (required) route id, e.g. risk-limits
 *   --title <string>         (required) PageShell title + nav label default
 *   --description <string>   (required) scopeNote + route description
 *   --category <cat>         (required) Execution|Intelligence|Platform|
 *                            Billing|Marketing
 *   --label <string>         nav label (default: --title)
 *   --short-label <string>   nav short label (default: --label)
 *   --badge <string>         nav badge (default: --short-label; --nav only)
 *   --badge-type <t>         pro|live|ai|mcp|new|neutral (default neutral)
 *   --icon <Key>             NavIcons key (default Docs; --nav: must be new
 *                            and present in NavigationMenu)
 *   --issue <number>         issue number for the changelog fragment name
 *   --nav                    also add a left-nav entry (see guards above)
 *   --dry-run                print planned writes without writing
 *   --root <path>            repo root (default: parent of scripts/)
 *   --help                   print usage
 *
 * Conformance references: docs/agents/ux-architecture.md §20,
 * docs/agents/gitops.md §5 (issue template) and §7 (pins in the same PR).
 * This script writes files only; it does not open the PR. Run the
 * targeted tests after scaffolding:
 *   npx vitest run tests/ux_scaffold_<id>.test.ts \
 *     tests/ux_conformance_gates_3047.test.ts \
 *     tests/nav_config_data_2977.test.ts \
 *     tests/nav_unique_icons_badges.test.ts tests/route_content_switch_1804.test.ts
 * then tsc and the full suite before opening the PR.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ["Execution", "Intelligence", "Platform", "Billing", "Marketing"];
const BADGE_TYPES = ["pro", "live", "ai", "mcp", "new", "neutral"];

function fail(msg) {
  console.error(`new-page: error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") return { help: true };
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--nav") { out.nav = true; continue; }
    if (!a.startsWith("--")) fail(`unexpected argument: ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) fail(`--${a.slice(2)} needs a value`);
    out[key] = val;
  }
  return out;
}

function toComponent(id) {
  return id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("") + "Panel";
}

function insertBeforeClosing(lines, startPattern, closing, insertLines, what) {
  const start = lines.findIndex((l) => startPattern.test(l));
  if (start === -1) fail(`anchor not found: ${what}`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === closing) { end = i; break; }
  }
  if (end === -1) fail(`closing ${closing} not found for ${what}`);
  lines.splice(end, 0, ...insertLines);
}

function bumpCount(content, regex, label) {
  const m = content.match(regex);
  if (!m) fail(`count anchor not found: ${label}`);
  const n = Number(m[1]);
  return { updated: content.replace(regex, (s) => s.replace(String(n), String(n + 1))), from: n, to: n + 1 };
}

// Insert a route id into route_table.test.ts's sorted EXPECTED_IDS array.
// The array must stay sorted: ROUTES (from nav-config.json, sorted by the
// generator) is compared against it exactly.
function insertSortedId(content, id) {
  const start = content.indexOf("const EXPECTED_IDS = [");
  if (start === -1) fail("EXPECTED_IDS anchor not found in route_table.test.ts");
  const end = content.indexOf("];", start);
  if (end === -1) fail("EXPECTED_IDS closing not found in route_table.test.ts");
  const block = content.slice(start, end);
  const entries = [...block.matchAll(/^  "([^"]+)",$/gm)].map((m) => m[1]);
  if (entries.includes(id)) fail(`route id "${id}" already in EXPECTED_IDS`);
  const line = `  "${id}",\n`;
  const after = entries.find((e) => e > id);
  if (!after) return content.slice(0, end) + line + content.slice(end);
  const at = content.indexOf(`  "${after}",\n`, start);
  return content.slice(0, at) + line + content.slice(at);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/new-page.mjs --id <kebab> --title <t> --description <d> --category <c> [--issue N] [--nav] [--dry-run]");
  process.exit(0);
}

const root = args.root ? path.resolve(args.root) : path.resolve(HERE, "..");
const id = args.id;
const title = args.title;
const description = args.description;
const category = args.category;
if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) fail("--id must be kebab-case (e.g. risk-limits)");
if (!title) fail("--title is required");
if (!description) fail("--description is required");
if (!CATEGORIES.includes(category)) fail(`--category must be one of ${CATEGORIES.join("|")}`);
if (/["<>\n\r]/.test(title) || /["<>\n\r]/.test(description)) {
  fail('title/description must not contain ", <, >, or newlines (JSX attribute strings)');
}
const label = args.label ?? title;
const shortLabel = args.shortLabel ?? label;
const badgeType = args.badgeType ?? "neutral";
if (!BADGE_TYPES.includes(badgeType)) fail(`--badge-type must be one of ${BADGE_TYPES.join("|")}`);
const icon = args.icon ?? "Docs";
if (!/^[A-Za-z]+$/.test(icon)) fail("--icon must be letters only (a NavIcons key)");
const component = toComponent(id);
const panelRel = `src/client/${component}.tsx`;
const panelPath = path.join(root, panelRel);
const navPath = path.join(root, "src/client/nav-config.json");
const chatPath = path.join(root, "src/client/Chat.tsx");
const gatePath = path.join(root, "tests/ux_conformance_gates_3047.test.ts");
const navDataPath = path.join(root, "tests/nav_config_data_2977.test.ts");
const navBadgesPath = path.join(root, "tests/nav_unique_icons_badges.test.ts");
const routeTablePath = path.join(root, "tests/route_table.test.ts");
const pinRel = `tests/ux_scaffold_${id}.test.ts`;
const pinPath = path.join(root, pinRel);
const fragmentName = args.issue ? `${args.issue}-${id}.md` : `new-page-${id}.md`;
const fragmentRel = `changelog.d/${fragmentName}`;
const fragmentPath = path.join(root, fragmentRel);

// ---- read + guards -------------------------------------------------------
const navRaw = readFileSync(navPath, "utf8");
const nav = JSON.parse(navRaw);
const routes = nav.routes;
if (routes.some((r) => r.id === id)) fail(`route id "${id}" already exists in nav-config.json`);
const chatSrc = readFileSync(chatPath, "utf8");
if (new RegExp(`^    "?${id}"?: \\($`, "m").test(chatSrc)) fail(`TAB_CONTENT already has "${id}"`);
if (!chatSrc.includes("const TAB_CONTENT")) fail("TAB_CONTENT anchor not found in Chat.tsx");
const gateSrc = readFileSync(gatePath, "utf8");
if (gateSrc.includes(`"${id}":`)) fail(`conformance gate already mentions "${id}"`);
if (existsSync(panelPath)) fail(`panel file already exists: ${panelRel}`);
if (existsSync(pinPath)) fail(`pin test already exists: ${pinRel}`);
if (existsSync(fragmentPath)) fail(`fragment already exists: ${fragmentRel}`);
const navDataSrc = readFileSync(navDataPath, "utf8");
const navBadgesSrc = args.nav ? readFileSync(navBadgesPath, "utf8") : "";

let navEntry = null;
if (args.nav) {
  const badge = args.badge ?? shortLabel;
  const navRoutes = routes.filter((r) => r.navEntry);
  const badges = navRoutes.map((r) => (r.navEntry.badge ?? "").toLowerCase());
  if (!badge.trim()) fail("--badge must be non-empty");
  if (badges.includes(badge.toLowerCase())) fail(`badge "${badge}" is already used by a nav entry (badges must be unique, case-insensitive)`);
  const icons = navRoutes.map((r) => r.icon);
  if (icons.includes(icon)) fail(`icon "${icon}" is already used by a nav entry (icons must be unique)`);
  const menuSrc = readFileSync(path.join(root, "src/client/components/NavigationMenu.tsx"), "utf8");
  if (!new RegExp(`^\\s+${icon}:`, "m").test(menuSrc)) {
    fail(`icon key "${icon}" not found in NavigationMenu's NavIcons map — add the icon component there first, then re-run with --nav`);
  }
  const maxOrder = Math.max(...navRoutes.map((r) => r.navEntry.navOrder));
  navEntry = { label, shortLabel, navOrder: maxOrder + 1, defaultVisible: true, badge, badgeType };
}

// ---- build new contents --------------------------------------------------
const route = { id, navGroup: id, crumb: title, category, icon, description };
if (navEntry) route.navEntry = navEntry;
const nextRoutes = [...routes, route].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const nextNav = { ...nav, routes: nextRoutes };
// The data file is pure ASCII: non-ASCII characters are \uXXXX escapes.
// Re-escape after stringify so the rewrite touches only the added route.
const nextNavRaw =
  JSON.stringify(nextNav, null, 2).replace(/[\u0080-\uFFFF]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ) + "\n";

const panel = `import { EmptyState } from "./components/ui";
import { PageShell, PageSection } from "./components/ui/PageShell";

/**
 * ${component} — scaffolded page (scripts/new-page.mjs).
 * TODO: replace the Overview section with the page's real content.
 */
export function ${component}() {
  return (
    <PageShell title="${title}" scopeNote="${description}">
      <PageSection title="Overview">
        <EmptyState
          title="Under construction"
          description="This page was scaffolded; its content is not implemented yet."
        />
      </PageSection>
    </PageShell>
  );
}
`;

const chatLines = chatSrc.split("\n");
// Import: with the other top-level panel imports (Chat.tsx imports are
// grouped, not sorted — the panel block is the PascalCase ./*.tsx lines).
const panelImportRe = /^import .* from "\.\/[A-Z][A-Za-z]*";$/;
let at = -1;
chatLines.forEach((l, i) => { if (panelImportRe.test(l)) at = i + 1; });
if (at === -1) {
  const anyLocal = chatLines.map((l, i) => ({ l, i })).filter(({ l }) => /^import .* from "\.\//.test(l));
  at = anyLocal.length ? anyLocal[anyLocal.length - 1].i + 1 : 0;
}
chatLines.splice(at, 0, `import { ${component} } from "./${component}";`);
// TAB_CONTENT entry, right after the record opens. The key MUST be quoted:
// a kebab-case id is not a valid bare identifier (`scaffold-probe: (` is
// parsed as `scaffold - probe:` and breaks tsc).
const tabOpen = chatLines.findIndex((l) => l.includes("const TAB_CONTENT"));
if (tabOpen === -1) fail("TAB_CONTENT anchor not found");
chatLines.splice(tabOpen + 1, 0,
  `    "${id}": (`,
  `      <ErrorBoundary label="${label}">`,
  `        <${component} />`,
  `      </ErrorBoundary>`,
  `    ),`,
);
const nextChat = chatLines.join("\n");

const gateLines = gateSrc.split("\n");
insertBeforeClosing(gateLines, /const CONFORMING_ROUTES/, "};", [`  "${id}": "${panelRel}",`], "CONFORMING_ROUTES");
insertBeforeClosing(gateLines, /const EXPECTED_TAB_CONTENT_KEYS/, "];", [`  "${id}",`], "EXPECTED_TAB_CONTENT_KEYS");
const nextGate = gateLines.join("\n");

const pin = `import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("scaffolded page ${id}", () => {
  it("has a nav-config route wired to TAB_CONTENT and the conformance gate", () => {
    const nav = JSON.parse(src("src/client/nav-config.json")) as {
      routes: { id: string }[];
    };
    expect(nav.routes.map((r) => r.id)).toContain("${id}");
    const chat = src("src/client/Chat.tsx");
    expect(chat).toContain('    "${id}": (');
    expect(chat).toContain("<${component} />");
    const gate = src("tests/ux_conformance_gates_3047.test.ts");
    expect(gate).toContain("\\"${id}\\": \\"${panelRel}\\"");
    expect(gate).toContain("\\"${id}\\",");
    const panel = src("${panelRel}");
    expect(panel).toContain('<PageShell title="${title}"');
  });
});
`;

const fragment = `### Added
- New ${title} page (${id}): scaffolded shell-conforming page wired into navigation and the conformance gate. Content implementation follows in its own issue.
`;

// EXPECTED_IDS (route_table.test.ts) lists every route id: any scaffolded
// route joins it, in sorted order, with or without --nav.
let nextRouteTable = insertSortedId(readFileSync(routeTablePath, "utf8"), id);

// Nav-count pins (only with --nav): the route count itself needs no bump —
// it is asserted dynamically (ROUTES vs nav-config.json in
// nav_config_data_2977). The three nav-count pins must move together.
let nextNavData = navDataSrc;
let nextNavBadges = navBadgesSrc;
if (args.nav) {
  const orders = bumpCount(nextNavData, /expect\(orders\)\.toHaveLength\((\d+)\)/, "navOrders count");
  nextNavData = orders.updated;
  const arr = bumpCount(nextNavData, /Array\.from\(\{\s*length:\s*(\d+) \}/, "navOrders array");
  nextNavData = arr.updated;
  if (orders.to !== arr.to) fail("navOrders count/array mismatch in nav_config_data_2977.test.ts");
  const navCount = bumpCount(nextNavBadges, /const NAV_COUNT = (\d+);/, "NAV_COUNT");
  nextNavBadges = navCount.updated;
  if (navCount.to !== orders.to) fail("NAV_COUNT does not match navOrders count");
  const rtNav = bumpCount(nextRouteTable, /expect\(nav\)\.toHaveLength\((\d+)\)/, "route_table nav count");
  nextRouteTable = rtNav.updated;
  const rtArr = bumpCount(nextRouteTable, /Array\.from\(\{\s*length:\s*(\d+) \}/, "route_table navOrders array");
  nextRouteTable = rtArr.updated;
  if (rtNav.to !== orders.to || rtArr.to !== orders.to) fail("route_table nav count does not match navOrders count");
}

const writes = [
  { file: panelRel, note: "new panel (PageShell + Overview section)" },
  { file: "src/client/nav-config.json", note: `route "${id}"${args.nav ? " with navEntry" : " (no navEntry — reachable by ?tab=" + id + ")"}` },
  { file: "src/client/Chat.tsx", note: "import + TAB_CONTENT entry" },
  { file: "tests/ux_conformance_gates_3047.test.ts", note: "CONFORMING_ROUTES + EXPECTED_TAB_CONTENT_KEYS" },
  { file: pinRel, note: "new pin test" },
  { file: fragmentRel, note: "new changelog fragment" },
  { file: "tests/route_table.test.ts", note: "EXPECTED_IDS entry" + (args.nav ? " + nav entries pin bumped" : "") },
];
if (args.nav) {
  writes.push({ file: "tests/nav_config_data_2977.test.ts", note: "navOrders pins bumped" });
  writes.push({ file: "tests/nav_unique_icons_badges.test.ts", note: "NAV_COUNT bumped" });
}

if (args.dryRun) {
  console.log("new-page dry run — no files written:");
  for (const w of writes) console.log(`  ${w.file} — ${w.note}`);
  process.exit(0);
}
// Write through a helper: the changelog.d / tests parents always exist in
// the repo, but a --root used by tests may not have them yet.
function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
write(panelPath, panel);
write(navPath, nextNavRaw);
write(chatPath, nextChat);
write(gatePath, nextGate);
write(pinPath, pin);
write(fragmentPath, fragment);
write(routeTablePath, nextRouteTable);
if (args.nav) {
  write(navDataPath, nextNavData);
  write(navBadgesPath, nextNavBadges);
}
console.log(`new-page: scaffolded "${id}" (${component})`);
for (const w of writes) console.log(`  wrote ${w.file}`);
console.log("Next: run the targeted tests (see script header), then tsc and the full suite before opening the PR.");
