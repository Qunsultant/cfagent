/**
 * Rule-of-three census (#4913, sub of #3695).
 *
 * The design system caps each recurring treatment at three — a fourth
 * treatment fails CI the way the freeze gate fails a new bespoke class.
 * Each axis pins its surviving set BY NAME, and asserts every survivor
 * is actually used (a survivor with zero uses is dead weight, not a cap).
 *
 * Survivors (measured on base cd1fb72; counts in the #4913 build plan):
 * - Button variants: primary / secondary / danger. Danger is KEPT instead
 *   of ghost: the 48 danger sites are overwhelmingly destructive
 *   confirmations where a ghost button would lose the warning signal
 *   (AdminQueueWipePanel, AlpacaCancelAll, ApiKeys revoke, DataLifecycle
 *   deletes, JobsPanel deletes, ScreenerPresetManager delete, ServiceTokens
 *   revoke, cancel trade/payment drafts). Ghost (135) folds to secondary;
 *   accent (25 incl. ternaries) folds to primary (apply/create/selected)
 *   or secondary (quiet); warning (9) folds to secondary; trade (8)
 *   folds to primary (executions) or secondary (navigations).
 * - Button sizes: sm / md (default). lg folds to md (1 Button, the order
 *   submit). `size="small"` is Fluent-only, not a ui-Button size.
 * - Card paddings: default (= md — Card's default IS md) / sm / none.
 *   md folds to default with zero visual change; lg (1 use) folds to
 *   default. `none` stays: edge-to-edge content (tables, scroll regions).
 * - Card treatments: `emphasized` replaces `elevated` + `highlight`
 *   (raised shadow + primary tint, the union). WorkCard folds to an
 *   inline Card + Stack + CardHeader composition (0 uses). SummaryCard
 *   is CAPPED at 1 use, not folded: its sunken surface + emphasized
 *   total row have no primitive equivalent, and folding it into a Card
 *   would nest a card inside the order-ticket Card. DetailCard stays.
 * - Headers: CardHeader (h4) for interiors; SmallHeader (h5/h6) for
 *   sub-section headers; PageSection title (h2) / PageShell title (h1)
 *   for page/section titles; Modal title prop for dialog titles. Zero
 *   hand-rolled h2/h3/h4/h5/h6 outside ui/ and landing.ts (landing.ts
 *   is the C10 #4739 surface, out of scope). h5/h6 migrated by #5004
 *   to the SmallHeader primitive (Ceos's decision 2026-11-23: keep it
 *   as a primitive, be consistent). Survivors for interiors are now
 *   CardHeader (h4) + SmallHeader (h5/h6).
 * - Fluent: REMOVED (#5843, owner decision 2026-11-20: tokens.css and
 *   primitives.css only). AgentChatTabContent and ChatComposerVoiceControl
 *   were the #3146 experiment; both now use ui/ primitives, so zero client
 *   files may import @fluentui/react-components. The exception list in
 *   tests/ux_primitives_exceptions_1772.test.ts shrinks with the migration.
 * - Truncation: TWO mechanisms, by scope — ui-single-line (block ellipsis,
 *   className= only) and ui-cell-nowrap (table-cell no-wrap,
 *   cellClassName: only, scoped to `.ui-table td`). Neither can replace
 *   the other: display:block cannot go on a td; cell-nowrap has no
 *   ellipsis/overflow. Pinned as the two scoped mechanisms, not one.
 * - Scroll: ui-scroll-frame only (ui-scroll-x folds into it; delta: tables
 *   taller than min(68vh, 46rem) now scroll internally).
 * - Margins: 3 survivors, decided on the POST-HEADER tree (the header
 *   migration removes heading margins) — this file pins the current 7 as
 *   a no-new ratchet until the utilities slice tightens it.
 * - Layout containers: Stack / Row / Grid (the ui-stack / ui-row /
 *   ui-grid classes). stack-lg, stat-grid, form-row* fold into Grid via
 *   props (stat-grid's floor moves 192px -> autofit-sm 200px; column count
 *   differs only in ~4%-wide container bands). ui-workspace-grid stays as
 *   WorkspaceGrid's internal hook (pages never write it). ui-grow / ui-clip
 *   are kept with justification (no Flex grow prop, no Card clip prop) and
 *   pinned at their current counts.
 *
 * Scanner: the naive `[^>]*` tag regex breaks on `=>` inside onClick
 * handlers (the `>` in `=>` ends the match early — the AGENTS.md lesson),
 * so this test tracks `{}` depth + quote state and ends a tag only at a
 * `>` with brace depth 0 outside any string. Same scanner as
 * ~/workspace/scan-4913.py (the measurement tool).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./template_route_tree";

const ROOT = process.cwd();
const CLIENT_DIR = join(ROOT, "src", "client");
const UI_DIR = join(CLIENT_DIR, "components", "ui");

/** The #3146 Fluent experiment surface: the ONLY files that may import Fluent. */
const FLUENT_FILES = [
  "src/client/chat/AgentChatTabContent.tsx",
  "src/client/chat/ChatComposerVoiceControl.tsx",
] as const;

/** Out of scope: landing.ts headings belong to the C10 #4739 surface. */
const LANDING_TS = "src/client/landing.ts";

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkTsx(p, out);
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function repoRel(abs: string): string {
  // Issue #5843: repo-relative paths are POSIX on every platform, so the
  // src/client/components/ui/ exclusion below holds on Windows too (the
  // backslash form made ui/ files look like page files, counting their h2s).
  const rel = abs.startsWith(ROOT) ? abs.slice(ROOT.length + 1) : abs;
  return rel.replaceAll(String.fromCharCode(92), "/");
}

/** All .tsx files under src/client, repo-relative, sorted. */
function clientTsx(): string[] {
  return walkTsx(CLIENT_DIR).map(repoRel).sort();
}

/** Page files: everything except the ui/ primitives. */
function pageTsx(): string[] {
  return clientTsx().filter(
    (f) => !f.startsWith("src/client/components/ui/"),
  );
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

export interface FoundTag {
  line: number;
  text: string;
}

/**
 * Depth-aware JSX tag finder. Returns every opening/self-closing tag
 * whose name is in `names`. A tag ends only at a `>` with brace depth 0
 * outside any string — `=>` inside an onClick handler does not end it.
 * Top-level string literals are skipped so tags inside strings do not
 * count (template `${}` blocks are skipped with nesting).
 */
export function findTags4913(src: string, names: Set<string>): FoundTag[] {
  const out: FoundTag[] = [];
  const tagStart = /<([A-Za-z][A-Za-z0-9._]*)/y;
  let i = 0;
  let line = 1;
  const n = src.length;
  const skipString = (quote: string): void => {
    // i points just past the opening quote.
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") line += 1;
      if (quote === "`" && ch === "$" && src[i + 1] === "{") {
        // Template substitution: skip the ${...} block with nesting.
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c2 = src[i];
          if (c2 === "\n") line += 1;
          if (c2 === "{" || c2 === "(" || c2 === "[") depth += 1;
          else if (c2 === "}" || c2 === ")" || c2 === "]") depth -= 1;
          else if (c2 === "'" || c2 === '"' || c2 === "`") {
            const q2 = c2;
            i += 1;
            while (i < n && src[i] !== q2) {
              if (src[i] === "\\") i += 1;
              if (src[i] === "\n") line += 1;
              i += 1;
            }
          }
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        i += 1;
        return;
      }
      i += 1;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    // Top-level strings: skip "…" and `…` only. NEVER skip '…': an
    // apostrophe in JSX text (e.g. "this report's body") is not a string
    // delimiter — treating it as one swallows every tag until the next
    // apostrophe, which can be hundreds of lines later (ResearchRunDetail
    // lost its ghost Buttons at :459/:471 this way). Verified safe: no
    // single-quoted string in src/client contains a "<Tag", so not
    // skipping '…' cannot create a false tag positive from a string.
    if (c === '"' || c === "`") {
      i += 1;
      skipString(c);
      continue;
    }
    if (c === "<") {
      tagStart.lastIndex = i;
      const m = tagStart.exec(src);
      if (m && names.has(m[1])) {
        const startLine = line;
        const start = i;
        let depth = 0;
        let quote: string | null = null;
        let j = i + 1;
        while (j < n) {
          const ch = src[j];
          if (ch === "\n") line += 1;
          if (quote) {
            if (ch === "\\") {
              j += 2;
              continue;
            }
            if (ch === quote) quote = null;
            j += 1;
            continue;
          }
          if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            j += 1;
            continue;
          }
          if (ch === "{") depth += 1;
          else if (ch === "}") depth -= 1;
          else if (ch === ">" && depth === 0) {
            j += 1;
            break;
          }
          j += 1;
        }
        out.push({ line: startLine, text: src.slice(start, j) });
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** Attribute values of one tag: string attrs, `{expr}` attrs (raw), bare attrs. */
export function tagAttrs4913(tag: string): Map<string, string | true> {
  const d = new Map<string, string | true>();
  for (const m of tag.matchAll(/(\w[\w-]*)\s*=\s*"([^"]*)"/g)) {
    d.set(m[1], m[2]);
  }
  for (const m of tag.matchAll(/(\w[\w-]*)\s*=\s*\{([^{}]*)\}/g)) {
    if (!d.has(m[1])) d.set(m[1], `{${m[2].trim()}}`);
  }
  const blanked = tag
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");
  for (const m of blanked.matchAll(/\s([A-Za-z][\w-]*)(\s|\/?>)/g)) {
    const name = m[1];
    if (!d.has(name) && !new RegExp(`${name}\\s*=`).test(blanked)) {
      d.set(name, true);
    }
  }
  return d;
}

/** Variant names referenced by a Button tag: the literal, plus every quoted
 *  variant name inside a ternary expression (both branches can render). */
function buttonVariantNames(tag: string): string[] {
  const a = tagAttrs4913(tag);
  const v = a.get("variant");
  if (v === undefined) return ["secondary"]; // Button's default variant
  if (v === true) return [];
  if (!v.startsWith("{")) return [v];
  const names: string[] = [];
  for (const m of v.matchAll(
    /"(primary|secondary|ghost|danger|trade|accent|warning)"/g,
  )) {
    names.push(m[1]);
  }
  return names;
}

export interface ClassAttr {
  file: string;
  attr: string;
  tokens: string[];
}

/** Literal class tokens from class-like attributes (`=` and `:` forms). */
export function classAttrTokens4913(
  files: string[],
): ClassAttr[] {
  const out: ClassAttr[] = [];
  const re =
    /(className|containerClassName|cellClassName|wrapperClassName)\s*[=:]\s*"([^"]*)"/g;
  for (const f of files) {
    const code = stripComments(read(f));
    for (const m of code.matchAll(re)) {
      out.push({ file: f, attr: m[1], tokens: m[2].split(/\s+/).filter(Boolean) });
    }
  }
  return out;
}

function countTag(files: string[], name: string): number {
  let n = 0;
  for (const f of files) {
    n += findTags4913(stripComments(read(f)), new Set([name])).length;
  }
  return n;
}

const BUTTON_SURVIVORS = new Set(["primary", "secondary", "danger"]);
const CARD_PADDINGS = new Set(["default", "sm", "none"]);
const MARGIN_RATCHET = new Set([
  "ui-m-0",
  "ui-mt-0",
  "ui-mt-1",
  "ui-mt-2",
  "ui-mb-1",
  "ui-mb-1-5",
  "ui-ml-3",
]);
const CONTAINER_SURVIVORS = new Set(["ui-stack", "ui-row", "ui-grid"]);
const CONTAINER_ALL = new Set([
  ...CONTAINER_SURVIVORS,
  "ui-stack-lg",
  "ui-stat-grid",
  "ui-form-row",
  "ui-form-row-3",
  "ui-form-row-4",
  "ui-workspace-grid",
]);

/** ui Button tags: page files minus the Fluent files (their Buttons are Fluent). */
function uiButtonTags(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const f of pageTsx()) {
    if ((FLUENT_FILES as readonly string[]).includes(f)) continue;
    for (const t of findTags4913(stripComments(read(f)), new Set(["Button"]))) {
      out.push({ file: f, line: t.line, text: t.text });
    }
  }
  return out;
}

describe("rule of three: button variants (#4913)", () => {
  it("at most three Button variants, pinned by name", () => {
    const used = new Set<string>();
    for (const t of uiButtonTags()) {
      for (const v of buttonVariantNames(t.text)) used.add(v);
    }
    for (const v of used) {
      expect(
        BUTTON_SURVIVORS.has(v),
        `Button variant "${v}" is folded away (survivors: primary, secondary, danger)`,
      ).toBe(true);
    }
    expect([...used].sort()).toEqual(["danger", "primary", "secondary"]);
  });

  it("Button's type and default name exactly the three survivors", () => {
    const src = read("src/client/components/ui/Button.tsx");
    expect(src).toContain(
      'export type ButtonVariant = "primary" | "secondary" | "danger";',
    );
    expect(src).toContain('variant = "secondary"');
    expect(src).toContain('size?: "sm" | "md";');
  });

  it("at most two Button sizes: sm / md (default)", () => {
    const used = new Set<string>();
    for (const t of uiButtonTags()) {
      const a = tagAttrs4913(t.text);
      const s = a.get("size");
      if (typeof s === "string" && !s.startsWith("{")) used.add(s);
    }
    for (const s of used) {
      expect(["sm", "md"].includes(s), `Button size "${s}" is folded away`).toBe(true);
    }
    expect(used.has("sm")).toBe(true);
  });
});

describe("rule of three: card paddings and treatments (#4913)", () => {
  function cardTags(): { file: string; line: number; text: string }[] {
    const out: { file: string; line: number; text: string }[] = [];
    for (const f of pageTsx()) {
      for (const t of findTags4913(stripComments(read(f)), new Set(["Card"]))) {
        out.push({ file: f, line: t.line, text: t.text });
      }
    }
    return out;
  }

  it("at most three Card paddings, pinned by name", () => {
    const used = new Set<string>();
    for (const t of cardTags()) {
      const a = tagAttrs4913(t.text);
      const p = a.get("padding");
      used.add(typeof p === "string" && !p.startsWith("{") ? p : "default");
    }
    for (const p of used) {
      expect(
        CARD_PADDINGS.has(p),
        `Card padding "${p}" is folded away (survivors: default, sm, none)`,
      ).toBe(true);
    }
    expect([...used].sort()).toEqual(["default", "none", "sm"]);
  });

  it("no elevated / highlight Card props; emphasized is the one treatment", () => {
    let emphasized = 0;
    for (const t of cardTags()) {
      const a = tagAttrs4913(t.text);
      expect(a.has("elevated"), `${t.file}:${t.line} still uses elevated`).toBe(false);
      expect(a.has("highlight"), `${t.file}:${t.line} still uses highlight`).toBe(false);
      if (a.has("emphasized")) emphasized += 1;
    }
    expect(emphasized).toBe(7);
    expect(read("src/client/components/ui/DetailCard.tsx")).toContain("<Card emphasized>");
  });

  it("WorkCard is folded away; SummaryCard is capped at one use; DetailCard stays", () => {
    expect(countTag(pageTsx(), "WorkCard")).toBe(0);
    expect(countTag(pageTsx(), "SummaryCard")).toBeLessThanOrEqual(1);
    expect(countTag(pageTsx(), "DetailCard")).toBeGreaterThan(0);
  });
});

describe("rule of three: headers (#4913)", () => {
  it("zero hand-rolled h2/h3/h4 outside ui/ (landing.ts is the C10 #4739 surface)", () => {
    for (const name of ["h2", "h3", "h4"]) {
      const n = countTag(pageTsx(), name);
      expect(n, `hand-rolled <${name}> sites remain (migrate to CardHeader / PageSection title / Modal title)`).toBe(0);
    }
    // landing.ts is a .ts file, so it is structurally outside the .tsx walk;
    // its 14 heading sites are out of scope (C10 #4739), not silently dropped.
    expect(pageTsx()).not.toContain(LANDING_TS);
  });

  it("h5/h6 migrated to the SmallHeader primitive (#5004: keep it as a primitive)", () => {
    const h5 = countTag(pageTsx(), "h5");
    const h6 = countTag(pageTsx(), "h6");
    expect(h5 + h6, "hand-rolled <h5>/<h6> sites remain (migrate to SmallHeader)").toBe(0);
    // #5975 UX slice (#6289): the OODA settings card's stage-mode section
    // heading is a SmallHeader, so the primitive count tracks the one new site.
    expect(countTag(pageTsx(), "SmallHeader")).toBe(47);
    // Exactly one site keeps h6 semantics (OmnichannelPanel: the email subject).
    let h6Level = 0;
    for (const f of pageTsx()) {
      for (const t of findTags4913(stripComments(read(f)), new Set(["SmallHeader"]))) {
        if (t.text.includes('level="h6"')) h6Level += 1;
      }
    }
    expect(h6Level).toBe(1);
    // landing.ts is a .ts file, so it is structurally outside the .tsx walk;
    // its 3 h5s stay out of scope (C10 #4739), not silently dropped.
    expect(pageTsx()).not.toContain(LANDING_TS);
  });

  it("SmallHeader's type names exactly the two heading levels, h5 by default", () => {
    const src = read("src/client/components/ui/SmallHeader.tsx");
    expect(src).toContain('level?: "h5" | "h6";');
    expect(src).toContain('level = "h5"');
    expect(src).toContain("<h5");
  });
});

describe("rule of three: Fluent containment (#4913, #3146)", () => {
  it("no client file imports @fluentui/react-components (the #3146 experiment ended, #5843)", () => {
    const importing: string[] = [];
    for (const f of clientTsx()) {
      if (stripComments(read(f)).includes("@fluentui/react-components")) {
        importing.push(f);
      }
    }
    expect(importing.sort(), "the chat chrome now uses ui/ primitives + tokens").toEqual([]);
  });
});

describe("rule of three: truncation and scroll (#4913)", () => {
  it("two truncation mechanisms, each scoped: single-line via className=, cell-nowrap via cellClassName:", () => {
    const attrs = classAttrTokens4913(clientTsx());
    const singleLine = attrs.filter((a) => a.tokens.includes("ui-single-line"));
    const cellNowrap = attrs.filter((a) => a.tokens.includes("ui-cell-nowrap"));
    expect(singleLine.length).toBeGreaterThan(0);
    expect(cellNowrap.length).toBeGreaterThan(0);
    for (const a of singleLine) {
      expect(a.attr, `ui-single-line must be a className= (block ellipsis), not ${a.attr}`).toBe("className");
    }
    for (const a of cellNowrap) {
      expect(a.attr, `ui-cell-nowrap must be a Table cellClassName:, not ${a.attr}`).toBe("cellClassName");
    }
  });

  it("one scroll mechanism: ui-scroll-frame only", () => {
    const attrs = classAttrTokens4913(clientTsx());
    const scrollX = attrs.filter((a) => a.tokens.includes("ui-scroll-x"));
    const scrollFrame = attrs.filter((a) => a.tokens.includes("ui-scroll-frame"));
    expect(scrollX).toEqual([]);
    expect(scrollFrame.length).toBeGreaterThan(0);
  });

  it("ui-empty-action is gone (unused: delete the CSS rule, not just the uses)", () => {
    const css = read("src/client/components/ui/primitives.css");
    expect(css).not.toContain("ui-empty-action");
  });
});

describe("rule of three: margins and layout containers (#4913)", () => {
  it("no NEW margin utility appears (ratchet; the utilities slice tightens this to the 3 survivors)", () => {
    const attrs = classAttrTokens4913(pageTsx());
    const used = new Set<string>();
    for (const a of attrs) {
      for (const t of a.tokens) {
        if (/^ui-(m|mt|mb|ml|mr|mx|my)-/.test(t)) used.add(t);
      }
    }
    for (const t of used) {
      expect(
        MARGIN_RATCHET.has(t),
        `margin utility "${t}" is new (ratchet: only the pre-#4913 set may appear until the utilities slice caps it at 3)`,
      ).toBe(true);
    }
  });

  it("at most three layout containers, pinned by name: Stack / Row / Grid", () => {
    const attrs = classAttrTokens4913(pageTsx());
    const used = new Set<string>();
    for (const a of attrs) {
      for (const t of a.tokens) {
        if (CONTAINER_ALL.has(t)) used.add(t);
      }
    }
    for (const t of used) {
      expect(
        CONTAINER_SURVIVORS.has(t),
        `layout container "${t}" is folded away (survivors: ui-stack, ui-row, ui-grid)`,
      ).toBe(true);
    }
    // Pages write ui-stack / ui-row directly; ui-grid is rendered by the
    // Grid primitive (template className), so it never appears literally
    // in a page — the primitive check below is its "used" proof.
    expect([...used].sort()).toEqual(["ui-row", "ui-stack"]);
    expect(read("src/client/components/ui/Grid.tsx")).toContain("ui-grid");
  });

  it("ui-workspace-grid is only WorkspaceGrid's internal hook (1 template render)", () => {
    // primitives.css KEEPS the .ui-workspace-grid.variant-list-detail
    // rules (the 1.4fr/1fr ratio + 900px collapse live there by design);
    // the hook class itself is rendered once, by the primitive.
    let n = 0;
    for (const f of clientTsx()) {
      n += stripComments(read(f)).split("ui-workspace-grid").length - 1;
    }
    expect(n).toBe(1);
  });

  it("KpiRibbon renders Grid, not the folded stat-grid", () => {
    expect(read("src/client/components/ui/KpiRibbon.tsx")).not.toContain("ui-stat-grid");
  });

  it("ui-grow and ui-clip are kept with justification, pinned at their counts", () => {
    // ui-grow uses (9): AuditVaultPage's two form-field wrappers, the
    // WorkflowRunsPanel stack, and — tail slice 1 (issue #5016) — the
    // DataProvidersPanel register form's two TextInput wrappers, the
    // same grow-to-fill-a-Flex-row pattern as AuditVaultPage's — plus
    // tail slice 2 (issue #5077): the OptionsFlowsHub main region and
    // the AsyncJobsPanel job-row stack, the same grow-to-fill-a-Flex-row
    // pattern — plus tail slice 3 (issue #5140): the ApiKeysPanel mint
    // row's TextInput wrapper, the same grow-to-fill-a-Flex-row pattern
    // — plus issue #4260: the ScheduleChannelFlagsPanel flag-row Stack,
    // the same grow-to-fill-a-Flex-row pattern (label grows, Badge and
    // toggle sit at the row end).
    const attrs = classAttrTokens4913(clientTsx());
    const grow = attrs.filter((a) => a.tokens.includes("ui-grow")).length;
    const clip = attrs.filter((a) => a.tokens.includes("ui-clip")).length;
    expect(grow).toBe(9);
    expect(clip).toBe(1);
  });
});
