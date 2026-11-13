/**
 * Token-tier discipline for template surfaces (#3135, Part of #2150):
 * the last Phase 1 template slice.
 *
 * Measured on main 6b79eca7: `src/client/components/ui/primitives.css`
 * carried 201 raw length tokens (199 in declarations + 2 in @media
 * preludes). Colors were already at zero (token-coverage TOTAL raw = 0,
 * re-asserted here for the template surfaces). This slice converts 113
 * of the 201 to frozen-scale tokens, allow-lists 34 hairline/pill
 * constants, and registers the remaining 54 as named exceptions —
 * never hidden, each with a reason. No scale extension, no deletions,
 * no page migrations.
 *
 * Conversion rules (nearest frozen scale step; ties round UP):
 * - spacing values -> --space-* (14 steps, --space-0 ... --space-16)
 * - border-radius values -> --radius-* (7 steps, --radius-xs ... --radius-full)
 * - font-size values -> --font-size-* (9 steps; the typography tier,
 *   not the spacing scale)
 * - 10px radius is equidistant between --radius-md (8px) and
 *   --radius-lg (12px): rounds up to --radius-lg.
 * - 0.05rem padding rounds to 0 (nearest step; 0.8px delta).
 * Largest deltas in the slice: 0.85rem -> --space-3 and 0.9rem ->
 * --space-4, both 1.6px; every other conversion is <= 1.2px, most
 * sub-pixel. No conversion visibly moves layout.
 *
 * Allow-list (legitimate constants, not tokens, not violations):
 * 1px hairlines, -1px (the .ui-visually-hidden a11y idiom's negative
 * margin — the brief's list said 1px/999px/9999px/0; -1px is the one
 * addition, it only ever appears inside that idiom), 999px/9999px
 * pill radii, bare 0 (unitless, never a length token).
 *
 * Exceptions are keyed "property:value" (or "@media:prop:value" for
 * breakpoints) so a future raw value in a new context fails loudly
 * instead of hiding behind an existing key. Every registered key
 * must still occur at least once — a stale entry fails, so the
 * registry is pruned when a value is converted or deleted.
 *
 * Mapping-table coverage: docs/architecture/UX/token-mapping-
 * order-options-autopilot.md must list every legacy class the three
 * layouts use (OrderTicketPanel, ETradeTradingHub,
 * AutopilotControlCenter, plus the options components), 648 classes
 * on this slice's measurement (#4168 adds `ui-anchor`, used by the
 * Job outcomes section anchor in AutopilotControlCenter). The extraction below mirrors the
 * generator (scripts/ in the slice's working notes): className
 * attributes, ${...} interpolations stripped from literal parts,
 * lowercase string literals harvested as state classes — except
 * comparison operands ("x" ===, === "x", .includes("x")), which are
 * data values, not classes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const PRIMITIVES_CSS = join(
  ROOT,
  "src",
  "client",
  "components",
  "ui",
  "primitives.css",
);
const TOKENS_CSS = join(ROOT, "src", "client", "tokens.css");
const MAPPING_DOC = join(
  ROOT,
  "docs",
  "architecture",
  "UX",
  "token-mapping-order-options-autopilot.md",
);

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ");
}

const LENGTH_RE =
  /(?<![\w-])(-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch|ex|pt))\b/g;
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const FN_RE = /\b(?:rgba?|hsla?)\([^)]*\)/g;

const NAMED_COLORS =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  );
const NAMED_COLOR_RE = new RegExp(
  `(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w-])`,
  "gi",
);
const COLOR_KEBAB_PROPS = new Set(
  "color background background-color border-color border-top-color border-right-color border-bottom-color border-left-color outline-color text-decoration-color caret-color accent-color column-rule-color fill stroke stop-color flood-color lighting-color box-shadow text-shadow border border-top border-right border-bottom border-left outline column-rule".split(
    " ",
  ),
);

/** Raw length hits in primitives.css: declarations + @media preludes. */
function scanLengths(
  text: string,
): Array<{ key: string; line: number; value: string }> {
  const hits: Array<{ key: string; line: number; value: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const m of line.matchAll(
      /([a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g,
    )) {
      const prop = m[1];
      if (prop.startsWith("--")) continue; // token definitions are the source
      for (const lm of m[2].matchAll(LENGTH_RE)) {
        hits.push({ key: `${prop}:${lm[1]}`, line: i + 1, value: lm[1] });
      }
    }
    for (const m of line.matchAll(
      /@media\s*\(([^)]+)\)/g,
    )) {
      for (const lm of m[1].matchAll(LENGTH_RE)) {
        const prop = m[1].split(":")[0].trim();
        hits.push({
          key: `@media:${prop}:${lm[1]}`,
          line: i + 1,
          value: lm[1],
        });
      }
    }
  }
  return hits;
}

/** Legitimate constants: hairlines, pill radii, the visually-hidden -1px. */
const ALLOW_LIST_VALUES = new Set(["1px", "-1px", "999px", "9999px"]);

/**
 * Registered exceptions — raw values that stay, each with its reason.
 * A conversion that would visibly move layout, or a value that is not
 * spacing/radius at all (layout widths, breakpoints, viewport units,
 * typography tracking, stroke widths, filter blur, component size
 * ladders), lands here instead of becoming a quiet scale addition.
 */
const REGISTERED_EXCEPTIONS: Record<string, string> = {
  // Stroke widths — a stroke constant, not a spacing/radius value.
  "border:2px": "spinner/check ring stroke width",
  "border-width:2px": "spinner ring width (sm/md)",
  "border-width:3px": "spinner ring width (lg)",
  "outline:2px": "focus outline width",
  "outline-offset:2px": "focus outline offset",
  "box-shadow:-2px": "selected-tab underline, inset shadow offset",
  // Filter blur — a filter radius, not a spacing/radius value.
  "backdrop-filter:8px": "backdrop blur radius",
  "-webkit-backdrop-filter:8px": "backdrop blur radius (vendor prefix)",
  // Typography tracking — no tracking token exists.
  "letter-spacing:0.04em": "uppercase badge tracking",
  "letter-spacing:0.06em": "uppercase tracking",
  // Font-relative sizing — em-relative, not a spacing step.
  "width:0.9em": "font-relative icon box",
  "height:0.9em": "font-relative icon box",
  // Spinner size ladder (14/20/36): a component size, not spacing.
  // 20px equals --space-5 numerically, but converting only that rung
  // would make the ladder incoherent; 14px and 36px match no step.
  "width:14px": "spinner size ladder (sm)",
  "height:14px": "spinner size ladder (sm)",
  "width:20px": "spinner size ladder (md)",
  "height:20px": "spinner size ladder (md)",
  "width:36px": "spinner size ladder (lg)",
  "height:36px": "spinner size ladder (lg)",
  // Control-height ladder (segmented/pill/button sizes): nearest-step
  // conversion would resize controls by up to 4px.
  "min-height:26px": "pill size-sm control height",
  "min-height:28px": "segmented size-sm control height",
  "min-height:30px": "button size-sm control height",
  "min-height:32px": "pill size-md control height",
  "min-height:34px": "segmented size-md control height",
  "min-height:38px": "button size-md control height",
  "min-height:40px": "segmented size-lg control height",
  "min-height:44px": "button size-lg control height",
  // Layout widths and breakpoints — no scale step applies; a
  // layout-token tier does not exist yet.
  "max-width:480px": "empty-state measure",
  "max-width:420px": "modal size-sm width",
  "max-width:560px": "modal size-md width",
  "max-width:720px": "modal size-lg width",
  "max-width:920px": "modal size-xl width",
  "max-width:40rem": "layout measure",
  "min-width:12rem": "layout width",
  "grid-template-columns:12rem": "grid minmax floor (layout)",
  "grid-template-columns:160px": "autofit-xs minmax floor",
  "grid-template-columns:200px": "autofit-sm minmax floor",
  "grid-template-columns:280px": "autofit-md minmax floor",
  "grid-template-columns:360px": "autofit-lg minmax floor",
  "grid-template-columns:480px": "autofit-xl minmax floor",
  "width:22.5rem": "dialog/drawer width",
  "width:28rem": "dialog/drawer width",
  "max-width:20rem": "dialog/drawer width",
  "max-width:24rem": "dialog/drawer width",
  "width:100vw": "viewport unit in min()/calc()",
  "max-width:100vw": "viewport unit in min()/calc()",
  "max-height:90vh": "viewport unit (modal max height)",
  "height:6rem": "skeleton block height; above the frozen scale max (4rem)",
  // The one spacing value that does NOT convert: equidistant between
  // --space-6 (1.5rem) and --space-8 (2rem) at +/-4px — conversion
  // would visibly move layout, so it is registered, not converted.
  "padding:1.75rem": "card pad-lg; tie at +/-4px from any scale step",
  // @media breakpoints — layout, not spacing.
  "@media:max-width:37.5rem": "toast compact breakpoint (600px)",
  "@media:max-width:900px": "compact breakpoint, #3134 (900px)",
};

describe("token tiers for template surfaces (#3135)", () => {
  it("no raw color literals in primitives.css", () => {
    const text = stripComments(readFileSync(PRIMITIVES_CSS, "utf8"));
    const hex = [...text.matchAll(HEX_RE)].map((m) => m[0]);
    const fns = [...text.matchAll(FN_RE)].map((m) => m[0]);
    const named: string[] = [];
    for (const m of text.matchAll(
      /(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g,
    )) {
      const prop = m[1].toLowerCase();
      if (!(prop.startsWith("--") || COLOR_KEBAB_PROPS.has(prop))) continue;
      named.push(...(m[2].match(NAMED_COLOR_RE) ?? []));
    }
    expect({ hex, fns, named }).toEqual({ hex: [], fns: [], named: [] });
  });

  it("no raw lengths/radii outside the allow-list and the registered exceptions", () => {
    const text = stripComments(readFileSync(PRIMITIVES_CSS, "utf8"));
    const hits = scanLengths(text);
    const violations = hits.filter(
      (h) =>
        !ALLOW_LIST_VALUES.has(h.value) &&
        !(h.key in REGISTERED_EXCEPTIONS),
    );
    expect(violations).toEqual([]);
    // The registry must not go stale: every registered key still occurs.
    const seen = new Set(hits.map((h) => h.key));
    const stale = Object.keys(REGISTERED_EXCEPTIONS).filter(
      (k) => !seen.has(k),
    );
    expect(stale).toEqual([]);
  });

  it("every var(--x) in primitives.css names a defined custom property", () => {
    const tokensText = stripComments(readFileSync(TOKENS_CSS, "utf8"));
    const defined = new Set(
      [...tokensText.matchAll(/--([\w-]+)\s*:/g)].map((m) => `--${m[1]}`),
    );
    const primText = stripComments(readFileSync(PRIMITIVES_CSS, "utf8"));
    for (const m of primText.matchAll(/--([\w-]+)\s*:/g)) {
      defined.add(`--${m[1]}`);
    }
    const used = new Set(
      [...primText.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]),
    );
    const undefinedVars = [...used].filter((v) => !defined.has(v));
    expect(undefinedVars).toEqual([]);
  });
});

const LAYOUT_FILES = [
  "src/client/OrderTicketPanel.tsx",
  "src/client/ETradeTradingHub.tsx",
  "src/client/components/AutopilotControlCenter.tsx",
  "src/client/OptionsCriteriaPanel.tsx",
  "src/client/OptionsHub.tsx",
  "src/client/OptionsResearchPanel.tsx",
  "src/client/OptionsScreenerPage.tsx",
  "src/client/chat/OptionsStrategyCard.tsx",
  "src/client/options/AutonomousOptionsRuns.tsx",
  "src/client/options/ConfidenceMethodBreakdown.tsx",
  "src/client/options/DiscoveryRunsPanel.tsx",
  "src/client/options/EtapiConfigModal.tsx",
  "src/client/options/LlmOptionsIdeasPanel.tsx",
  "src/client/options/LlmStrategyEvalModal.tsx",
  "src/client/options/OptionsDataDownloadDropdown.tsx",
  "src/client/options/OptionsResearchHost.tsx",
  "src/client/options/OptionsResearchPanel.tsx",
  "src/client/options/RawContractsScreener.tsx",
  "src/client/options/ResearchRunsPanel.tsx",
  "src/client/options/RiskAnalysisModal.tsx",
  "src/client/options/ScheduledOptionsRunForm.tsx",
  "src/client/options/ScreeningActivityPanel.tsx",
  "src/client/options/StrategyDiscoveryPanel.tsx",
  "src/client/options/StrategyLibraryModal.tsx",
  "src/client/options/ThreeWayComparison.tsx",
  "src/client/options/flows/FlowFiltersSidebar.tsx",
  "src/client/options/flows/FlowSummaryDualBars.tsx",
  "src/client/options/flows/FlowTradeDetailModal.tsx",
  "src/client/options/flows/OptionsFlowsHub.tsx",
];

const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const JS_KEYWORDS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "return",
  "const",
  "let",
  "var",
  "if",
  "else",
  "for",
  "while",
  "new",
  "typeof",
]);

function stripInterpolation(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("${", i)) {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") depth += 1;
        else if (s[i] === "}") depth -= 1;
        i += 1;
      }
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

function harvestClassName(expr: string): Set<string> {
  const toks = new Set<string>();
  const lit = stripInterpolation(expr);
  for (const t of lit.split(/[\s"']+/)) {
    const tok = t.trim().replace(/^`|`$/g, "").replace(/^"|"$/g, "");
    if (CLASS_TOKEN.test(tok) && !JS_KEYWORDS.has(tok) && tok.length > 1) {
      toks.add(tok);
    }
  }
  // Lowercase string literals inside interpolations are state classes
  // ("active", "selected") — except comparison operands, which are
  // data values, not classes.
  for (const m of expr.matchAll(/"([a-z][a-z0-9-]*)"/g)) {
    const litTok = m[1];
    const before = expr.slice(0, m.index);
    const after = expr.slice(m.index + m[0].length);
    if (/(==|!=)\s*$/.test(before) || /^\s*(==|!=)/.test(after)) continue;
    if (/\.(includes|startsWith|endsWith)\s*\(\s*$/.test(before)) continue;
    if (CLASS_TOKEN.test(litTok) && litTok.length > 1) toks.add(litTok);
  }
  for (const m of expr.matchAll(/'([a-z][a-z0-9-]*)'/g)) {
    const litTok = m[1];
    const before = expr.slice(0, m.index);
    const after = expr.slice(m.index + m[0].length);
    if (/(==|!=)\s*$/.test(before) || /^\s*(==|!=)/.test(after)) continue;
    if (/\.(includes|startsWith|endsWith)\s*\(\s*$/.test(before)) continue;
    if (CLASS_TOKEN.test(litTok) && litTok.length > 1) toks.add(litTok);
  }
  return toks;
}

function usedLegacyClasses(): Set<string> {
  const all = new Set<string>();
  for (const rel of LAYOUT_FILES) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const m of text.matchAll(/className\s*=\s*"([^"]*)"/g)) {
      for (const t of harvestClassName(m[1])) all.add(t);
    }
    for (const m of text.matchAll(/className\s*=\s*'([^']*)'/g)) {
      for (const t of harvestClassName(m[1])) all.add(t);
    }
    for (const m of text.matchAll(/className\s*=\s*\{/g)) {
      const start = m.index + m[0].length - 1;
      let depth = 0;
      let i = start;
      while (i < text.length) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      for (const t of harvestClassName(text.slice(start + 1, i))) all.add(t);
    }
  }
  return all;
}

describe("mapping table covers the order/options/autopilot legacy classes (#3135)", () => {
  it("every used legacy class appears in the mapping table", () => {
    const used = usedLegacyClasses();
    expect(used.size).toBe(648);
    const doc = readFileSync(MAPPING_DOC, "utf8");
    const missing = [...used].filter((c) => !doc.includes(`\`${c}\``));
    expect(missing).toEqual([]);
  });

  it("no ui-* class is listed as a deletion candidate", () => {
    const doc = readFileSync(MAPPING_DOC, "utf8");
    const rows = doc
      .split("\n")
      .filter((l) => l.startsWith("| `") && l.split("|").length >= 6)
      .map((l) => l.split("|").map((c) => c.trim()));
    const bad = rows.filter(
      (cells) =>
        cells[1]?.startsWith("`ui-") &&
        cells[2]?.toLowerCase().includes("deletion candidate"),
    );
    expect(bad).toEqual([]);
  });
});
