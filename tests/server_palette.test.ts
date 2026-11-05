/**
 * Issue #678 — server palette pins.
 *
 * The five server-rendered surfaces (trading email, unified options
 * email HTML, browser-agent SVG artwork, GitHub OAuth pages, and the
 * /checkout/sandbox page in src/server/routes/core.ts since #2902
 * Slice 2 moved the Core branches out of src/server.ts) render outside the app
 * shell and cannot consume the client design tokens as CSS variables.
 * Since #678 they take every colour from ONE shared module,
 * src/theme/serverPalette.ts. This suite pins that arrangement:
 *
 *  1. Zero hard-coded colour literals remain in the five files
 *     (hex / rgb()/hsl() / CSS named colours, matched with the #677
 *     gate's discipline; the `transparent` keyword is not a colour
 *     value and stays allowed, exactly as in the #677 gate).
 *  2. The palette holds EXACTLY the colour values the five files used
 *     before the migration (the pre-migration survey, as a value set) —
 *     the migration is output-preserving by construction — PLUS the
 *     Carbon v11 Gray 100 values added deliberately for #3146 (one
 *     page's new design; no existing surface uses them, so prior
 *     output is unchanged).
 *  3. Token-aligned palette entries equal the corresponding
 *     tokens.css dark-theme values, and no other entry equals any
 *     dark --color-* token value (the hand-mirror cannot drift
 *     silently in either direction — the #677 pattern).
 *  4. Golden renders: the OAuth login page, the browser
 *     placeholder SVG, a transaction receipt SVG, and an email
 *     container render are byte-identical to their pre-migration
 *     output. (The fifth golden, the legacy OAuth error page, was
 *     removed in #1254 PR-B with the page itself.) The only
 *     tolerated difference is the CSS named colour
 *     `white` rendering as its exact equivalent #ffffff (the
 *     --color-on-gradient token value) where the palette replaced the
 *     keyword; both sides are normalised for that one equivalence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_PALETTE, SERVER_PALETTE_TOKEN_SOURCES } from "../src/theme/serverPalette";
import { renderLoginPage } from "../src/security/githubOAuth";
import { ETradeBrowserService } from "../src/services/browserAgent";
import { ETradeEmailTradingService } from "../src/trading/email/agent";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const FIVE_FILES = [
  "src/trading/email/agent.ts",
  "src/trading/options/unifiedOptionsService.ts",
  "src/services/browserAgent.ts",
  "src/security/githubOAuth.ts",
  // #2902 Slice 2: the /checkout/sandbox page moved from src/server.ts
  // to src/server/routes/core.ts (moves only); the palette pin follows it.
  "src/server/routes/core.ts",
] as const;

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const HEX_LONG_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g;
const FN_RE = /\b(?:rgba?|hsla?)\([^)]*\)/g;

// The #677 gate's closed CSS Color 4 named-colour list (minus
// `transparent`, a keyword the gate deliberately excludes), from
// scripts/token-coverage.mjs.
const NAMED_COLORS =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
const NAMED_RE = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w-])`, "gi");
const NAMED_QUOTED_RE = new RegExp(`["'\`](?:${NAMED_COLORS.join("|")})["'\`]`, "gi");

/** Style-bearing spans of a server file: <style> blocks, style
 *  attribute values, and SVG presentation attribute values — the
 *  places a named colour could hide (the #677 scoping discipline). */
function styleSpans(src: string): string[] {
  const spans: string[] = [];
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) spans.push(m[1]);
  for (const m of src.matchAll(/\bstyle\s*=\s*"([^"]*)"/g)) spans.push(m[1]);
  for (const m of src.matchAll(/\bstyle\s*=\s*'([^']*)'/g)) spans.push(m[1]);
  for (const m of src.matchAll(/\bstyle\s*:\s*"([^"]*)"/g)) spans.push(m[1]);
  for (const m of src.matchAll(/\bstyle\s*:\s*'([^']*)'/g)) spans.push(m[1]);
  for (const m of src.matchAll(/\b(?:fill|stroke|stop-color|stopColor|flood-color|lighting-color)\s*=\s*"([^"]*)"/g)) spans.push(m[1]);
  for (const m of src.matchAll(/\b(?:fill|stroke|stop-color)\s*=\s*'([^']*)'/g)) spans.push(m[1]);
  return spans;
}

describe("server palette — zero literals in the five migrated files (#678)", () => {
  for (const rel of FIVE_FILES) {
    it(`${rel} contains no hard-coded colour literals and consumes the palette`, () => {
      const src = read(rel);
      expect(src.match(HEX_LONG_RE) || [], "hex literals").toEqual([]);
      expect(src.match(FN_RE) || [], "rgb()/hsl() literals").toEqual([]);
      const named: string[] = [];
      for (const span of styleSpans(src)) {
        for (const m of span.matchAll(HEX_RE)) named.push(`hex in style span: ${m[0]}`);
        for (const m of span.matchAll(NAMED_RE)) named.push(`named colour in style span: ${m[0]}`);
      }
      expect(named).toEqual([]);
      expect(src.match(NAMED_QUOTED_RE) || [], "quoted named colours").toEqual([]);
      expect(src).toMatch(/from\s+"[^"]*theme\/serverPalette"/);
      expect((src.match(/SERVER_PALETTE\./g) || []).length).toBeGreaterThanOrEqual(5);
    });
  }
});

// The distinct colour values the five files used before the migration
// (surveyed on the pre-#678 tree; the named colour `white` is counted
// as its exact equivalent #ffffff, the --color-on-gradient value).
const SURVEYED_VALUES = [
  "#0284c7", "#030712", "#060913", "#06b6d4", "#090d16", "#0a0f1d", "#0b0f19", "#0b1120", "#002d9c", "#0353e9", "#0f62fe", "#161616", "#262626", "#333333", "#393939", "#78a9ff", "#a6c8ff", "#c6c6c6", "#f4f4f4",
  "#0c1222", "#0f172a", "#111827", "#15803d", "#1e1b4b", "#1e293b", "#1e3a8a", "#22c55e",
  "#2563eb", "#334155", "#34d399", "#38bdf8", "#3b82f6", "#475569", "#60a5fa", "#6366f1",
  "#64748b", "#818cf8", "#94a3b8", "#a78bfa", "#b91c1c", "#cbd5e1", "#e2e8f0", "#ef4444",
  "#f1f5f9", "#f3f4f6", "#f43f5e", "#f59e0b", "#f87171", "#f8fafc", "#fef3c7", "#ffffff",
  "rgba(0, 0, 0, 0.4)", "rgba(0, 0, 0, 0.5)", "rgba(0, 0, 0, 0.6)",
  "rgba(16, 185, 129, 0.15)", "rgba(16, 185, 129, 0.4)", "rgba(17, 24, 39, 0.75)",
  "rgba(18, 26, 47, 0.9)", "rgba(34, 197, 94, 0.1)", "rgba(37, 99, 235, 0.2)",
  "rgba(37, 99, 235, 0.4)", "rgba(56, 189, 248, 0.1)", "rgba(56, 189, 248, 0.2)",
  "rgba(56, 189, 248, 0.3)", "rgba(99, 102, 241, 0.15)", "rgba(99, 102, 241, 0.2)",
  "rgba(99, 102, 241, 0.35)", "rgba(99, 102, 241, 0.4)", "rgba(148, 163, 184, 0.1)",
  "rgba(239, 68, 68, 0.1)", "rgba(244, 63, 94, 0.2)", "rgba(245, 158, 11, 0.1)",
  "rgba(255, 255, 255, 0.03)", "rgba(255, 255, 255, 0.05)", "rgba(255, 255, 255, 0.08)",
  "rgba(255, 255, 255, 0.1)", "rgba(255, 255, 255, 0.15)",
].sort();

describe("server palette — completeness against the pre-migration survey (#678)", () => {
  it("the palette holds exactly the surveyed values — none lost, none added", () => {
    expect(Object.values(SERVER_PALETTE).slice().sort()).toEqual(SURVEYED_VALUES);
  });
});

function darkColorTokens(): Map<string, string> {
  const css = read("src/client/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const sel = css.match(/:root,\s*\[data-theme="dark"\] \{/);
  if (!sel || sel.index === undefined) throw new Error("dark theme selector not found in tokens.css");
  const start = sel.index + sel[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = css.slice(start, end);
  const tokens = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
  return tokens;
}
const normValue = (v: string) =>
  v.toLowerCase().replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s+/g, ", ").trim();

describe("server palette — tokens.css dark-theme alignment (#678)", () => {
  it("every token-aligned entry equals its tokens.css dark value", () => {
    const tokens = darkColorTokens();
    const entries = Object.entries(SERVER_PALETTE_TOKEN_SOURCES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, token] of entries) {
      const tokenValue = tokens.get(token as string);
      expect(tokenValue, `${token} must exist in the dark theme`).toBeDefined();
      expect(normValue(SERVER_PALETTE[key as keyof typeof SERVER_PALETTE]), `${key} vs ${token}`).toBe(normValue(tokenValue!));
    }
  });

  it("no non-aligned entry equals any dark --color-* token value", () => {
    const tokens = darkColorTokens();
    const colorValues = new Set<string>();
    for (const [name, value] of tokens) {
      if (!name.startsWith("--color-")) continue;
      if (/^#[0-9a-f]{6}$/i.test(value) || /^rgba?\(/i.test(value)) colorValues.add(normValue(value));
    }
    for (const [key, value] of Object.entries(SERVER_PALETTE)) {
      if (key in SERVER_PALETTE_TOKEN_SOURCES) continue;
      expect(colorValues.has(normValue(value)), `${key} (${value}) must not equal a dark token value without being declared aligned`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------
// Golden renders (captured from the pre-migration code, 2026-10-20).
// ---------------------------------------------------------------------
const whiteKeyword = (s: string) => s.replaceAll("color: white", "color: #ffffff");

const LOGIN_GOLDEN = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test App — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 50% 10%, #1e1b4b 0%, #060913 55%, #030712 100%);
      color: #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: rgba(17, 24, 39, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 3rem 2.25rem;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 60px -12px rgba(0, 0, 0, 0.6), 0 0 45px -5px rgba(99, 102, 241, 0.15);
      position: relative;
      overflow: hidden;
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 15%;
      right: 15%;
      height: 1px;
      background: linear-gradient(90deg, transparent, #38bdf8, #818cf8, transparent);
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      background: linear-gradient(135deg, #6366f1, #06b6d4);
      border-radius: 16px;
      margin-bottom: 1.5rem;
      box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35), 0 0 20px rgba(99, 102, 241, 0.15);
    }
    h1 {
      font-size: 1.55rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin-bottom: 0.5rem;
      color: #f8fafc;
    }
    .brand-gradient {
      background: linear-gradient(135deg, #ffffff 40%, #38bdf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: #94a3b8;
      font-size: 0.9rem;
      line-height: 1.55;
      margin-bottom: 2rem;
    }
    .btn-stack {
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      margin-bottom: 2rem;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      background: #ffffff;
      color: #0f172a;
      text-decoration: none;
      padding: 0.9rem 1.5rem;
      border-radius: 14px;
      font-size: 0.95rem;
      font-weight: 600;
      width: 100%;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 4px 14px rgba(255, 255, 255, 0.15), 0 0 24px rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(255, 255, 255, 0.15);
      position: relative;
    }
    .btn:hover {
      background: #f1f5f9;
      transform: translateY(-2px);
      box-shadow: 0 8px 28px rgba(255, 255, 255, 0.15), 0 0 32px rgba(99, 102, 241, 0.15);
    }
    .btn:active {
      transform: translateY(0);
    }
    .btn svg {
      width: 18px;
      height: 18px;
      fill: #0f172a;
      flex-shrink: 0;
    }
    .btn-arrow {
      margin-left: auto;
      opacity: 0.6;
      transition: transform 0.2s ease, opacity 0.2s ease;
      font-size: 1.15rem;
      line-height: 1;
    }
    .btn:hover .btn-arrow {
      opacity: 1;
      transform: translateX(3px);
    }
    .card-footer {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      align-items: center;
    }
    .security-note {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.775rem;
      color: #94a3b8;
    }
    .security-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
    }
    .back-link {
      color: #38bdf8;
      font-size: 0.825rem;
      font-weight: 500;
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .back-link:hover {
      color: #f8fafc;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-badge">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"></polygon>
        <line x1="12" y1="22" x2="12" y2="15.5"></line>
        <polyline points="22 8.5 12 15.5 2 8.5"></polyline>
      </svg>
    </div>
    <h1>Sign in to <span class="brand-gradient">Test App</span></h1>
    <p class="subtitle">Sign in with your GitHub account to access your trading workspace.</p>

    <div class="btn-stack">
      <a href="/auth/login" class="btn btn-github">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        <span>Sign in with GitHub</span>
        <span class="btn-arrow" aria-hidden="true">&rarr;</span>
      </a>
    </div>

    <div class="card-footer">
      <div class="security-note">
        <span class="security-dot" aria-hidden="true"></span>
        <span>Protected by W3C Agent DIDs &amp; deterministic risk gates</span>
      </div>
      <a href="/" class="back-link">&larr; Back to Test App Home</a>
    </div>
  </div>
</body>
</html>`;

const PLACEHOLDER_GOLDEN = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <rect width="100%" height="100%" fill="#0a0f1d"/>
  <rect x="16" y="16" width="768" height="418" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="10 6"/>
  <text x="400" y="150" fill="#f59e0b" font-family="monospace" font-size="26" font-weight="bold" text-anchor="middle">PLACEHOLDER — NOT A SCREENSHOT</text>
  <text x="400" y="195" fill="#e2e8f0" font-family="monospace" font-size="14" text-anchor="middle">No image of this page was captured.</text>
  <text x="400" y="225" fill="#94a3b8" font-family="monospace" font-size="12" text-anchor="middle">Cloudflare Browser Rendering was unavailable, so this illustration was</text>
  <text x="400" y="245" fill="#94a3b8" font-family="monospace" font-size="12" text-anchor="middle">generated locally. It shows no page content and no market data.</text>
  <text x="400" y="300" fill="#38bdf8" font-family="monospace" font-size="12" text-anchor="middle">https://example.com/page</text>
  <text x="400" y="410" fill="#64748b" font-family="monospace" font-size="11" text-anchor="middle">Generated placeholder • Cloudflare Browser Agent</text>
</svg>`;

const RECEIPT_GOLDEN = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="380" viewBox="0 0 700 380">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b1120" />
      <stop offset="100%" stop-color="#030712" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bgGrad)" rx="12" />
  <rect x="2" y="2" width="696" height="376" fill="none" stroke="#1e293b" stroke-width="2" rx="10" />

  <!-- Top Banner -->
  <text x="35" y="45" fill="#38bdf8" font-family="-apple-system, BlinkMacSystemFont, monospace" font-size="16" font-weight="bold">E*TRADE TRADING DESK | OFFICIAL TRANSACTION RECEIPT</text>
  <rect x="540" y="28" width="125" height="26" rx="13" fill="#15803d" />
  <text x="602" y="45" fill="#ffffff" font-family="-apple-system, sans-serif" font-size="12" font-weight="bold" text-anchor="middle">BUY</text>

  <line x1="35" y1="65" x2="665" y2="65" stroke="#1e293b" stroke-width="1" />

  <!-- Primary Ticker & Status -->
  <text x="35" y="115" fill="#f8fafc" font-family="-apple-system, sans-serif" font-size="34" font-weight="900">NVDA</text>
  <circle cx="210" cy="105" r="7" fill="#22c55e" />
  <text x="225" y="110" fill="#22c55e" font-family="-apple-system, sans-serif" font-size="15" font-weight="bold">EXECUTED</text>

  <!-- Key Metrics Grid -->
  <rect x="35" y="140" width="195" height="75" fill="#0f172a" rx="8" stroke="#334155" stroke-width="1" />
  <text x="50" y="165" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">ORDER QUANTITY</text>
  <text x="50" y="198" fill="#f8fafc" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">10 units</text>

  <rect x="250" y="140" width="195" height="75" fill="#0f172a" rx="8" stroke="#334155" stroke-width="1" />
  <text x="265" y="165" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">EXECUTION / LIMIT</text>
  <text x="265" y="198" fill="#f8fafc" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">$125.50</text>

  <rect x="465" y="140" width="200" height="75" fill="#0f172a" rx="8" stroke="#334155" stroke-width="1" />
  <text x="480" y="165" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">TOTAL CONSIDERATION</text>
  <text x="480" y="198" fill="#38bdf8" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">$1,255.00</text>

  <!-- Transaction Details & Routing -->
  <text x="35" y="245" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Order Type: <tspan fill="#f1f5f9" font-weight="bold">LIMIT</tspan></text>
  <text x="250" y="245" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Environment: <tspan fill="#f1f5f9" font-weight="bold">PROD</tspan></text>
  <text x="465" y="245" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Commission: <tspan fill="#f1f5f9" font-weight="bold">$0.00</tspan></text>

  <text x="35" y="275" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Transaction ID: <tspan fill="#cbd5e1" font-family="monospace">tx_golden_1</tspan></text>
  <text x="35" y="300" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Executed At: <tspan fill="#cbd5e1" font-family="monospace">2026-10-20T00:00:00.000Z</tspan></text>

  <!-- Footer Attestation -->
  <line x1="35" y1="330" x2="665" y2="330" stroke="#1e293b" stroke-width="1" />
  <text x="35" y="355" fill="#64748b" font-family="-apple-system, sans-serif" font-size="11">Attested by Cloudflare Browser Agent (did:agent:openaimp:browser) • Human-in-the-Loop Verified</text>
</svg>`;

const EMAIL_GOLDEN = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Approval Refused</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
  <div style="max-width: 620px; margin: 0 auto; background-color: #0f172a; border-radius: 10px; border: 1px solid #1e293b; overflow: hidden; margin-top: 20px; margin-bottom: 20px;">
    <!-- Brand Header -->
    <div style="background: linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%); padding: 24px; border-bottom: 1px solid #1e293b;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <span style="background: #3b82f6; color: #ffffff; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase;">
            E*TRADE AGENTIC HUB
          </span>
          <h1 style="color: #ffffff; font-size: 20px; margin: 8px 0 0 0; font-weight: 700;">Order Approval Refused</h1>
        </div>
      </div>
    </div>

    <!-- Body Content -->
    <div style="padding: 24px;">
      <p style="color: #cbd5e1;">Approval refused: a bare APPROVE reply no longer executes an order. Approve from the signed link in the order-preview email (click it, or reply quoting it). Email approvals require a mapped trade-tier sender (CHANNEL_EMAIL_PRINCIPALS).</p>
    </div>

    <!-- Security & Provenance Footer -->
    <div style="background-color: #0b0f19; padding: 18px 24px; border-top: 1px solid #1e293b; font-size: 12px; color: #64748b;">
      <p style="margin: 0 0 6px 0;">
        🛡️ <strong>Trading Agent DID:</strong> <code style="color: #94a3b8;">did:agent:openaimp:trading</code>
      </p>
      <p style="margin: 0 0 6px 0;">
        ⚖️ <strong>Regulatory Compliance:</strong> Direct REST API execution over OAuth 1.0a. Strict Human-in-the-Loop protection enforced on all equity orders.
      </p>
      <p style="margin: 0;">
        OpenAIMP Agentic Trading Network • <a href="https://agent.openaimp.com" style="color: #38bdf8; text-decoration: none;">agent.openaimp.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;

describe("server palette — golden renders are unchanged (#678)", () => {
  it("OAuth login page renders byte-identically", () => {
    expect(renderLoginPage({ APP_NAME: "Test App" } as any)).toBe(LOGIN_GOLDEN);
  });

  // #1254 PR-B: the OAuth error-page golden was removed with its
  // subject — the legacy styled error page and the
  // handleOAuthCallback that rendered it are deleted; login
  // errors are the factory's minimal pages now (pinned byte
  // for byte in the #1254 characterization suite).

  it("browser placeholder SVG renders byte-identically", () => {
    const svc = new ETradeBrowserService({} as any);
    const b64 = (svc as any).generateScreenshotPlaceholderBase64("https://example.com/page");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(PLACEHOLDER_GOLDEN);
  });

  it("transaction receipt SVG renders byte-identically", () => {
    const svc = new ETradeBrowserService({} as any);
    const b64 = svc.generateTransactionReceiptSvgBase64({
      action: "BUY",
      status: "EXECUTED",
      symbol: "NVDA",
      quantity: 10,
      price: 125.5,
      totalValue: 1255,
      commission: 0,
      orderType: "LIMIT",
      environment: "PROD",
      transactionId: "tx_golden_1",
      timestamp: "2026-10-20T00:00:00.000Z",
      humanApproved: true,
    } as any);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(RECEIPT_GOLDEN);
  });

  it("email container render is identical (modulo white -> #ffffff)", async () => {
    // Issue #781 wiring: processInboundEmail now requires an injected ORM
    // (it used to run against a stub and fabricate this same failure
    // render from an empty ledger). A real in-memory ORM keeps the
    // approval lookup honest. Issue #1262 Phase 5: a bare APPROVE no
    // longer reaches the "no pending preview" render — it is refused
    // by the signed-link gate — so the golden below is the refusal
    // render (container title "Order Approval Refused"), regenerated
    // from the service's actual output.
    const goldenOrm = new DatabaseORM(new MockSqlStorage());
    goldenOrm.initializeSchema("palette_golden");
    const svc = new ETradeEmailTradingService({} as any, goldenOrm);
    const res = await svc.processInboundEmail({ from: "user@example.com", to: "trade@agent.openaimp.com", subject: "APPROVE", text: "" } as any);
    expect(whiteKeyword(res.responseHtml)).toBe(whiteKeyword(EMAIL_GOLDEN));
  });
});
