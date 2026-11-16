/**
 * Shared template-route tree helpers (issue #4825).
 *
 * The general template-conformance rule is about the route's COMPOSED
 * surface, not one file: a route fills a template slot (a PageTemplate
 * prop on its own page file) or renders a card composition (a
 * CardHeader / WorkCard / DetailCard anywhere in its render tree —
 * the DetailCards' CardHeaders live in the panels' files, not the
 * hub, per the #3136 Q6 note). A file-level scan would false-fail
 * OptionsHub (0 slots, 0 cards in its own file; its cards live in
 * ScannerPanel / OptionsResearchPanel) and false-pass nothing, so
 * the rule walks the render tree: transitively follow relative
 * .tsx imports whose binding is used as a JSX element, excluding
 * anything under src/client/components/ui/ (the barrel would pull
 * in the Card definitions and make every route pass trivially).
 *
 * A "card composition" is a CardHeader, WorkCard, or DetailCard —
 * NOT a bare <Card>: a bare Card can be a Notice wrapper (the
 * product catalog's Teaser-rules card) or a bespoke container (the
 * audit vault's pre-#4825 cards). CardHeader only appears inside a
 * composed card, and WorkCard / DetailCard carry a header by
 * construction, so their count is the composition count.
 *
 * Used by tests/template_conformance_3136.test.ts (the general rule),
 * tests/ux_conformance_gates_3047.test.ts (the tightened S-U1
 * definition, template-state route files only), and
 * tests/template_composed_gate_4825.test.tsx (the dead-layout-class
 * set for the DOM check: `bespokeCssClasses` minus the classes the
 * `ui/` primitives render by design (`primitiveClasses`), scoped to
 * the classes the route owns (`routeOwnedBespokeClasses`)).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const HERE = join(__dirname, "..");
const CLIENT_DIR = join(HERE, "src", "client");
const TESTS_DIR = __dirname;

export const TEMPLATE_SLOTS = [
  "contextStrip=",
  "kpiRibbon=",
  "actionBar=",
  "queueRail=",
] as const;

/** A card composition: a header-bearing card (see the module doc). */
export const COMPOSITION_TAGS = [
  "<CardHeader",
  "<WorkCard",
  "<DetailCard",
] as const;

export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export interface TemplateEntry {
  state: string;
  file?: string;
  reason: string;
  wave?: string;
}

export function loadTemplateRegister(): Record<string, TemplateEntry> {
  const register = JSON.parse(
    readFileSync(join(TESTS_DIR, "ux_shell_exceptions_3047.json"), "utf8"),
  ) as { template?: Record<string, TemplateEntry> };
  return register.template ?? {};
}

/** Template-state routes (state "template"), with their page files. */
export function templateRoutes(): { id: string; file: string }[] {
  return Object.entries(loadTemplateRegister())
    .filter(([, e]) => e.state === "template")
    .map(([id, e]) => ({ id, file: e.file as string }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function resolveImport(
  baseFileRelToClient: string,
  spec: string,
): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = dirname(join(CLIENT_DIR, baseFileRelToClient));
  const target = normalize(join(dir, spec));
  for (const cand of [
    `${target}.tsx`,
    `${target}.ts`,
    join(target, "index.tsx"),
    join(target, "index.ts"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function importsOf(code: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  for (const m of code.matchAll(
    /import\s+(?:(\w+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    const names = m[2]
      .split(",")
      .map((n) => n.trim().split(" as ").pop()?.trim() ?? "")
      .filter(Boolean);
    out.push({ spec: m[3], names });
  }
  for (const m of code.matchAll(
    /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g,
  )) {
    out.push({ spec: m[2], names: [m[1]] });
  }
  return out;
}

function jsxUsed(code: string, names: string[]): Set<string> {
  const used = new Set<string>();
  for (const n of names) {
    if (new RegExp(`<${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s/>]`).test(code)) {
      used.add(n);
    }
  }
  return used;
}

/**
 * The route's render tree: the page file plus every relative .tsx
 * import whose binding is used as a JSX element, transitively.
 * Anything under src/client/components/ui/ is excluded (the barrel
 * would pull in the Card definitions). Paths are repo-relative
 * (src/client/...). `startFile` is repo-relative, e.g.
 * "src/client/OptionsHub.tsx".
 */
export function walkRouteTree(startFile: string): string[] {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  const queue = [startFile];
  while (queue.length > 0) {
    const f = queue.shift() as string;
    if (seenSet.has(f)) continue;
    seenSet.add(f);
    seen.push(f);
    let raw: string;
    try {
      raw = readFileSync(join(HERE, f), "utf8");
    } catch {
      continue;
    }
    const code = stripComments(raw);
    const relToClient = f.startsWith("src/client/")
      ? f.slice("src/client/".length)
      : f;
    for (const { spec, names } of importsOf(code)) {
      const used = jsxUsed(code, names);
      if (used.size === 0) continue;
      const tgt = resolveImport(relToClient, spec);
      if (!tgt || !tgt.endsWith(".tsx")) continue;
      const repoRel = tgt.startsWith(HERE)
        ? tgt.slice(HERE.length + 1)
        : tgt;
      if (repoRel.startsWith("src/client/components/ui/")) continue;
      if (!seenSet.has(repoRel)) queue.push(repoRel);
    }
  }
  return seen;
}

export interface RouteConformance {
  /** Template slots filled on the route's own PageTemplate. */
  slots: number;
  /** Which slot props the route file fills (e.g. ["kpiRibbon="]). */
  slotNames: string[];
  /** Card compositions (CardHeader / WorkCard / DetailCard) in the tree. */
  compositions: number;
  /** Files in the render tree (the route file first). */
  files: string[];
}

/**
 * The #4825 bar for one template-state route: slots on its own
 * PageTemplate, compositions across its render tree. A route meets
 * the rule when slots >= 1 or compositions >= 1.
 */
export function routeConformance(routeFile: string): RouteConformance {
  const routeSrc = stripComments(readFileSync(join(HERE, routeFile), "utf8"));
  const slotNames = TEMPLATE_SLOTS.filter(
    (slot) => countOccurrences(routeSrc, slot) > 0,
  );
  const slots = slotNames.length;
  const files = walkRouteTree(routeFile);
  let compositions = 0;
  for (const f of files) {
    const code = stripComments(readFileSync(join(HERE, f), "utf8"));
    for (const tag of COMPOSITION_TAGS) {
      compositions += countOccurrences(code, tag);
    }
  }
  return { slots, slotNames, compositions, files };
}

/** Classes defined in the bespoke stylesheets (freeze-scanner set). */
function targetClasses(selector: string): string[] {
  const out: string[] = [];
  for (const part of selector.split(",")) {
    const segments = part.trim().split(/\s*[>+~]\s*|\s+/);
    const last = segments[segments.length - 1] ?? "";
    const base = last.split(/[:\[]/)[0];
    for (const m of base.matchAll(/\.([a-zA-Z_][\w-]*)/g)) out.push(m[1]);
  }
  return out;
}

function walkCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkCss(p, out);
    else if (entry.isFile() && entry.name.endsWith(".css")) out.push(p);
  }
  return out;
}

/**
 * Every non-`ui-` class defined in a stylesheet other than
 * tokens.css / primitives.css — the same set the bespoke-class
 * freeze scanner reads. A conforming page renders none of these.
 */
export function bespokeCssClasses(): Set<string> {
  const found = new Set<string>();
  for (const abs of walkCss(CLIENT_DIR)) {
    const rel = abs.startsWith(HERE) ? abs.slice(HERE.length + 1) : abs;
    if (
      rel === "src/client/tokens.css" ||
      rel === "src/client/components/ui/primitives.css"
    ) {
      continue;
    }
    const text = readFileSync(abs, "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    for (const m of text.matchAll(/([^{}@]+?)\s*\{([^}]*)\}/g)) {
      for (const cls of targetClasses(m[1])) {
        if (!cls.startsWith("ui-")) found.add(cls);
      }
    }
  }
  return found;
}

/**
 * Non-`ui-` class tokens in a file's `className=` attributes.
 * Quoted strings and template-literal contents inside the attribute
 * value are split on whitespace and interpolation boundaries; the
 * caller intersects with the bespoke-CSS set, which filters
 * identifiers and other non-class words out. `cellClassName` is
 * excluded — the S-U1 carve-out (the token-mapping census counts
 * `className=` only). Brace expressions are read through a 600-char
 * window, which covers the primitives' and pages' expressions; a
 * longer expression would under-count, and the S-U1 source gate is
 * the backstop for per-file bespoke.
 */
function classNameTokens(code: string): Set<string> {
  const out = new Set<string>();
  const re = /([A-Za-z]*className)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[1] === "cellClassName") continue;
    const rest = code.slice(m.index + m[0].length);
    let window = "";
    if (
      rest.startsWith('"') ||
      rest.startsWith("'") ||
      rest.startsWith("`")
    ) {
      const q = rest[0];
      const end = rest.indexOf(q, 1);
      window = end === -1 ? rest : rest.slice(0, end + 1);
    } else if (rest.startsWith("{")) {
      window = rest.slice(0, 600);
    } else {
      continue;
    }
    for (const s of window.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      const text = s[1] ?? s[2] ?? s[3] ?? "";
      for (const tok of text.split(/[\s${}"'`?:;,\(\)\[\]]+/)) {
        if (/^[a-zA-Z_][\w-]*$/.test(tok) && !tok.startsWith("ui-")) {
          out.add(tok);
        }
      }
    }
  }
  return out;
}

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkTsx(p, out);
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Reverse import index over src/client: imported repo path -> importers. */
function importersIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const abs of walkTsx(CLIENT_DIR)) {
    const importer = abs.startsWith(HERE) ? abs.slice(HERE.length + 1) : abs;
    const relToClient = importer.slice("src/client/".length);
    let code: string;
    try {
      code = stripComments(readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    for (const { spec } of importsOf(code)) {
      const tgt = resolveImport(relToClient, spec);
      if (!tgt) continue;
      const repoRel = tgt.startsWith(HERE) ? tgt.slice(HERE.length + 1) : tgt;
      if (!index.has(repoRel)) index.set(repoRel, new Set());
      index.get(repoRel)!.add(importer);
    }
  }
  return index;
}

/**
 * Classes the `ui/` primitives render by design (the Tabs
 * primitive's `selected`, Card's `emphasized`): non-`ui-`
 * tokens in the primitives' `className=` expressions that coincide
 * with a bespoke-CSS definition. They are the design system's own
 * classes, not dead layout classes the page renders.
 */
export function primitiveClasses(): Set<string> {
  const bespoke = bespokeCssClasses();
  const out = new Set<string>();
  const uiDir = join(CLIENT_DIR, "components", "ui");
  for (const abs of walkTsx(uiDir)) {
    let code: string;
    try {
      code = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const tok of classNameTokens(stripComments(code))) {
      if (bespoke.has(tok)) out.add(tok);
    }
  }
  return out;
}

/**
 * Bespoke classes the route OWNS: tokens in the route file plus in
 * walk files dedicated to the route (every importer of the file is
 * itself in the route's walk). Classes from shared components
 * (CapabilityNavBar, used by eight hubs) and hub chrome are NOT
 * owned by the route — their migration is separate burn-down work,
 * not this gate's business. The route file is owned by definition.
 * A bespoke class in a dedicated component (the audit vault's
 * AuditEventCard) IS owned, so the composed gate catches it where
 * the S-U1 per-file gate cannot (that component is not a surface).
 *
 * A class is the route's only when NO file outside the owned set
 * uses the same name: the DOM cannot attribute a class to the file
 * that rendered it, so a name shared with a shared component is not
 * exclusively the route's. (The options flows hub's `active` is
 * also rendered by CapabilityNavBar's tab buttons; flagging it
 * would blame the route for a shared component's class.)
 */
export function routeOwnedBespokeClasses(routeFile: string): Set<string> {
  const bespoke = bespokeCssClasses();
  const files = walkRouteTree(routeFile);
  const walkSet = new Set(files);
  const index = importersIndex();
  const owned = new Set<string>([routeFile]);
  for (const f of files) {
    if (f === routeFile) continue;
    const importers = index.get(f) ?? new Set<string>();
    if ([...importers].every((imp) => walkSet.has(imp))) owned.add(f);
  }
  const ownedTokens = new Set<string>();
  const otherTokens = new Set<string>();
  for (const abs of walkTsx(CLIENT_DIR)) {
    const repoRel = abs.startsWith(HERE) ? abs.slice(HERE.length + 1) : abs;
    let code: string;
    try {
      code = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const tok of classNameTokens(stripComments(code))) {
      if (!bespoke.has(tok)) continue;
      if (owned.has(repoRel)) ownedTokens.add(tok);
      else otherTokens.add(tok);
    }
  }
  const out = new Set<string>();
  for (const tok of ownedTokens) {
    if (!otherTokens.has(tok)) out.add(tok);
  }
  return out;
}
