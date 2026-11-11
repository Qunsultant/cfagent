/**
 * UX uniformity, epic #3046 slice #3047 — conformance gates.
 *
 * A page that diverges must fail CI, not just look wrong. Four gates:
 * the first three share one scanner (no drift between them); the
 * fourth adds its own className scanner (same comment/string
 * discipline):
 *  1. Route→shell: every nav route renders inside a PageShell (or a
 *     PageTemplate, which renders PageShell — #3131), or is
 *     listed in ux_shell_exceptions_3047.json (migration with a tracking
 *     slice, permanent shape, or exception with justification). A
 *     migration entry whose file GAINS a PageShell fails — the entry
 *     must flip to the conforming map in the same PR that migrates it.
 *  2. Bespoke-CSS freeze: every css import must resolve to the
 *     one_off_stylesheets_1337.json registry or the system sheets
 *     (primitives.css, tokens.css). A new stylesheet import fails.
 *  3. Per-file inline-style budget: no file's style={{ count may rise
 *     above its ux_inline_baselines_3047.json baseline; a file with no
 *     baseline must have zero. Baselines are deliberate: raising one
 *     is a PR-body decision, never silent.
 *     Issue #3146 raises AgentChatTabContent 7 -> 9: Fluent's Badge
 *     has no uppercase prop, so the two migrated badges use a
 *     style={{ textTransform }} instead; no other inline styles added.
 *     Issue #3121 S3 raises ScheduledGoalsPanel 21 -> 28: the new
 *     "Recent goal runs" section follows the panel's existing
 *     inline-style idiom (section container, error/empty states, run
 *     rows); converting the whole panel to primitives is S5 surface
 *     work, not S3; no other inline styles added.
 *     Issue #3996 raises ScheduledGoalsPanel 28 -> 34: the new
 *     "Built-in goal" dropdown notices and the "Seed all built-in
 *     goals" section follow the panel's existing inline-style idiom
 *     (section heading, note/error divs, result rows); converting the
 *     whole panel to primitives is S5 surface work, not this slice;
 *     no other inline styles added.
 *  4. Interior consistency (S-U1, #3991): every routable surface
 *     uses PageSection or is registered in
 *     ux_shell_exceptions_3047.json (`interiors`), and interiors are
 *     primitives-only or registered per file with a disposition
 *     (migration with a tracking slice, or exception with
 *     justification). A registered file whose bespoke-class count
 *     rises above its registered snapshot fails; a registered file
 *     whose PageSection count falls below its snapshot fails; a
 *     registered file that becomes fully conforming (≥1 PageSection,
 *     zero bespoke classes) fails until it flips to the conforming
 *     map. Register-and-burn-down: the gate lands green with the
 *     full exception set, and migration slices burn it down.
 *     Measured 2026-11-10 on main 299f2aa4: 70 surface files — 8
 *     conforming, 62 registered (26 tracked by #3051 hub interiors,
 *     36 by the #3695 program). Worst offenders: MarketDataResearchHub
 *     364 bespoke classes, WorkflowsHub 178, ScannerPanel 152,
 *     ETradeTradingHub host 150, DataProvidersPanel 119.
 *     Scanner finding (confirmed 2026-11-10): ScannerPanel.tsx:615
 *     uses class `scanner-export-csv`, which has no definition in any
 *     client .css — a dead class. It counts as 1 bespoke token here;
 *     removal is migration-slice work, not this gate.
 *     Out of file scope, by design: Chat.tsx (the host — its audit/nlq
 *     inline entries are covered as register slice entries, and the
 *     chat conversation itself stays the routes-register exception);
 *     the login page (server-rendered); the top-level
 *     LlmOptionsIdeasPanel.tsx re-export stub; OptionsCriteriaPanel.tsx
 *     (nested component inside RawContractsScreener, not a surface).
 *     "Bespoke" means a className token not starting with `ui-`;
 *     counts are token occurrences in className attribute values
 *     only (prose in other strings is not a class).
 *
 * Scanner discipline copied from the #2283 no-native-alert pin:
 * comments stripped (line comments guarded so https:// survives),
 * string-literal contents dropped, template ${...} interpolation code
 * kept (it is code, not prose).
 *
 * S-U2 (#3051, merged 2026-11-10): all 26 slice-3051 entries burned —
 * register 64 -> 38, zero slice-3051 entries remain; 34 surfaces now
 * conforming (8 pre-S-U2 + 26 migrated). Dead `scanner-export-csv`
 * (ScannerPanel.tsx:615) removed with the ScannerPanel migration.
 * ScreenersHub inner-panel audit (2026-11-10): ScreenersHub mounts
 * NO panel components — post-#2896 its four asset tabs (forex /
 * futures / commodities / bonds) render only the Planned Notice, so
 * there is nothing further to audit; the hub itself conforms. The
 * panels formerly associated with it now live under StockHub
 * (ScreenerResultsView, StockCriteriaPanel, ScreenerPresetManager —
 * all conforming) and OptionsHub (ScannerPanel, IvHistoryPanel,
 * ResearchRunsPanel, OptionsResearchPanel — all conforming — plus
 * OptionsFlowsHub, still registered slice 3695, 35 bespoke, burns in
 * S-U3+). OptionsResearchPanel itself mounts RawContractsScreener
 * (conforming).
 * optionsResearch.css disposition (2026-11-10): NOT consolidated in
 * S-U2, NOT deleted. Both copies (src/client/optionsResearch.css,
 * 1,217 lines; src/client/options/optionsResearch.css, 1,197 lines)
 * stay, already registered as one-offs in
 * one_off_stylesheets_1337.json. They still style live classes in
 * files outside S-U2 scope — MarketDataResearchHub `options-error`
 * (slice 3695), OptionsCriteriaPanel `options-criteria-row` (nested
 * component, out of scope by design), AutonomousOptionsRuns
 * `autonomous-runs*` family, LlmStrategyEvalModal `options-error`,
 * ScheduledOptionsRunForm `options-comparison-note` /
 * `options-request-form`, ThreeWayComparison
 * `options-comparison-note` / `options-error` — plus
 * ScreenerResultsView's Table containerClassName
 * `options-table-scroll` (gate-invisible: the scanner counts
 * className attributes only, not containerClassName, but the class
 * still applies). None of those six files imports the stylesheet
 * itself: they depend on the side-effect imports in ScreenersHub,
 * StockHub, LlmOptionsIdeasPanel and OptionsResearchPanel, so those
 * imports MUST stay until the users migrate. Full removal /
 * consolidation is deferred to S-U7 (CSS consolidation) after
 * S-U3–S-U6 burn the remaining users.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";

const HERE = join(__dirname, "..");
const CLIENT_DIR = join(HERE, "src", "client");
const TESTS_DIR = join(__dirname);
const HUB_FILE = "src/client/ETradeTradingHub.tsx";

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Drop string-literal contents (prose is not code). Template
 * interpolations ${...} are code, so their contents are kept.
 */
function stripStringContents(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      i++;
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < text.length && depth > 0) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") depth--;
            if (depth > 0) out += text[i];
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function clean(src: string): string {
  return stripStringContents(stripComments(src));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function toRepoRel(abs: string): string {
  return abs.slice(HERE.length + 1).split(sep).join("/");
}

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // components/ui is the primitives' home; its styles are the
      // system, not bespoke (same exclusion as the #2177 ceiling).
      if (entry === "ui" && dir === join(CLIENT_DIR, "components")) continue;
      yield* walkTsx(path);
    } else if (entry.endsWith(".tsx")) {
      yield path;
    }
  }
}

function* walkTsAll(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walkTsAll(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}

/** Pure checker shared by the real gates and the synthetic test. */
function findViolations(
  entries: { id: string; shellPresent: boolean; registered: boolean }[],
): string[] {
  return entries
    .filter((e) => !e.shellPresent && !e.registered)
    .map((e) => e.id);
}

interface InteriorEntry {
  kind: "migration" | "exception";
  reason: string;
  slice?: number;
  /** PageSection count at registration (floor ratchet). */
  sections: number;
  /** Bespoke className token occurrences at registration (ceiling ratchet). */
  bespokeClasses: number;
  /** TAB_CONTENT slice in Chat.tsx (audit/nlq); the key is the route id. */
  chatEntry?: string;
}

interface ShellRegister {
  routes: Record<string, { kind: string; reason: string; slice?: number }>;
  subTabs: Record<
    string,
    {
      kind: string;
      reason: string;
      slice?: number;
      file?: string;
      files?: string[];
      inline?: boolean;
    }
  >;
  interiors: Record<string, InteriorEntry>;
}

function loadRegister(): ShellRegister {
  return JSON.parse(
    readFileSync(join(TESTS_DIR, "ux_shell_exceptions_3047.json"), "utf8"),
  );
}

/** Route id -> panel file that must contain <PageShell, or <PageTemplate
 *  (which renders PageShell — #3131; the template carries the shell). */
const CONFORMING_ROUTES: Record<string, string> = {
  agents: "src/client/AgentsPanel.tsx",
  approvals: "src/client/ApprovalsPanel.tsx",
  queues: "src/client/QueuesPage.tsx",
  endpoints: "src/client/chat/tabs/EndpointsTab.tsx",
  "options-flows": "src/client/options/flows/OptionsFlowsHub.tsx",
  "options-screener": "src/client/OptionsScreenerPage.tsx",
  "platform-admin": "src/client/PlatformAdminPage.tsx",
  products: "src/client/ProductCatalogPanel.tsx",
  "payment-assurance": "src/client/PaymentWorkflowAssurance.tsx",
  checkout: "src/client/CheckoutPanel.tsx",
  research: "src/client/MarketDataResearchHub.tsx",
  search: "src/client/search/SearchHub.tsx",
  "workflow-runs": "src/client/WorkflowRunsPanel.tsx",
  "workflow-catalog": "src/client/WorkflowCatalogPage.tsx",
  workflows: "src/client/WorkflowsHub.tsx",
  payments: "src/client/PaymentsPage.tsx",
  social: "src/client/SocialPostingPanel.tsx",
  // Issue #3121 S2: schedules renders from the shell (Chat.tsx
  // TAB_CONTENT → SchedulesHome), which carries the PageShell — it is
  // conforming now, not a hub-hosted trading route.
  schedules: "src/client/SchedulesHome.tsx",
  ads: "src/client/chat/tabs/AdsTab.tsx",
  referrals: "src/client/chat/tabs/ReferralsTab.tsx",
  revenue: "src/client/chat/tabs/RevenueTab.tsx",
  docs: "src/client/DocsAndReportsPanel.tsx",
  billing: "src/client/BillingServicingPanel.tsx",
  "risk-analysis": "src/client/RiskAnalysisPanel.tsx",
};

/** Routes rendered inline in Chat.tsx's TAB_CONTENT (entry-slice check). */
const CHAT_INLINE_ROUTES = ["audit", "nlq"];

/** Routes rendered by the trading hub (wrapper shell covers them). */
const TRADING_ROUTES = [
  "autopilot",
  "scanner",
  "screeners",
  "stock-hub",
  "reports",
  "goal-screen",
  "review",
  "track-record",
  "options",
  "assets-hub",
  "order",
  "portfolio",
  "ledger",
  "omnichannel",
  "voice",
  "orders",
  "trading",
];

/** Sub-tabs already shell-conforming (flip target for migrations). */
const CONFORMING_SUB_TABS: Record<string, string> = {
  "track-record": "src/client/TrackRecordPanel.tsx",
  "order": "src/client/OrderTicketPanel.tsx",
  "autopilot": "src/client/components/AutopilotControlCenter.tsx",
  "goal-screen": "src/client/GoalScreenPanel.tsx",
  "reports": "src/client/ReportsPanel.tsx",
  "review": "src/client/ScreeningReviewPanel.tsx",
  "portfolio": "src/client/PortfolioPanel.tsx",
  "ledger": "src/client/LedgerPanel.tsx",
  "omnichannel": "src/client/OmnichannelPanel.tsx",
  "voice": "src/client/VoicePanel.tsx",
};

const EXPECTED_TAB_CONTENT_KEYS = [
  "agents",
  "approvals",
  "queues",
  "audit",
  "chat",
  "docs",
  "endpoints",
  "nlq",
  "options-flows",
  "options-screener",
  "platform-admin",
  "workflow-catalog",
  "products",
  "billing",
  "payment-assurance",
  "checkout",
  "research",
  "search",
  "workflow-runs",
  "workflows",
  "risk-analysis",
  // Issue #3121 S2: schedules renders from the shell — its
  // TAB_CONTENT entry joins the shell-conforming keys.
  "schedules",
];

const EXPECTED_SUB_TABS = [
  "autopilot",
  "scanner",
  "screeners",
  "stock-hub",
  "reports",
  "goal-screen",
  "review",
  "track-record",
  "iv-history",
  "options",
  "assets-hub",
  "order",
  "portfolio",
  "ledger",
  "omnichannel",
  "voice",
];

function parseTabContentEntries(chatSrc: string): Map<string, string> {
  const start = chatSrc.indexOf("const TAB_CONTENT");
  const end = chatSrc.indexOf("const SHELL_CONTENT");
  const region = chatSrc.slice(start, end);
  const marker = /^    "?([a-z0-9-]+)"?: \($/gm;
  const entries = new Map<string, string>();
  let m: RegExpExecArray | null;
  let prevKey = "";
  let prevIdx = 0;
  while ((m = marker.exec(region)) !== null) {
    if (prevKey) entries.set(prevKey, region.slice(prevIdx, m.index));
    prevKey = m[1];
    prevIdx = m.index;
  }
  if (prevKey) entries.set(prevKey, region.slice(prevIdx));
  return entries;
}

function parseTradingSubTabs(hubSrc: string): string[] {
  const start = hubSrc.indexOf("export type TradingSubTab =");
  const end = hubSrc.indexOf(";", start);
  const block = hubSrc.slice(start, end);
  return [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/** S-U1 interior-consistency gate (#3991). A surface conforms when its
 *  file renders ≥1 PageSection and zero bespoke classes. */
const CONFORMING_INTERIORS: string[] = [
  "src/client/OptionsScreenerPage.tsx",
  "src/client/ProductCatalogPanel.tsx",
  "src/client/PaymentWorkflowAssurance.tsx",
  "src/client/WorkflowCatalogPage.tsx",
  "src/client/BillingServicingPanel.tsx",
  "src/client/TrackRecordPanel.tsx",
  "src/client/ScreeningReviewPanel.tsx",
  "src/client/FirstRunScreen.tsx",
  "src/client/PatternsPanel.tsx",
  "src/client/PresetsPanel.tsx",
  "src/client/IvHistoryPanel.tsx",
  "src/client/MorningDigest.tsx",
  "src/client/options/ResearchRunsPanel.tsx",
  "src/client/RunDetailView.tsx",
  "src/client/StockCriteriaPanel.tsx",
  "src/client/OptionsHub.tsx",
  "src/client/ScreenersHub.tsx",
  "src/client/ScreenerResultsView.tsx",
  "src/client/ScreenerPresetManager.tsx",
  "src/client/LedgerPanel.tsx",
  "src/client/options/RawContractsScreener.tsx",
  "src/client/GoalScreenPanel.tsx",
  "src/client/ReportsPanel.tsx",
  "src/client/StockHub.tsx",
  "src/client/options/LlmOptionsIdeasPanel.tsx",
  "src/client/VoicePanel.tsx",
  "src/client/PortfolioPanel.tsx",
  "src/client/options/DiscoveryRunsPanel.tsx",
  "src/client/OmnichannelPanel.tsx",
  "src/client/OrderTicketPanel.tsx",
  "src/client/components/AutopilotControlCenter.tsx",
  "src/client/options/OptionsResearchPanel.tsx",
  "src/client/ScannerPanel.tsx",
  "src/client/ETradeTradingHub.tsx",
  "src/client/WorkflowsHub.tsx",
  "src/client/MarketDataResearchHub.tsx",
]

/** Every routable surface file (measured 2026-11-10 on main 299f2aa4):
 *  route files, sub-tab files, hub files, hub-view files, admin
 *  sections, schedules files, FirstRunScreen, and the hub host. A new
 *  surface joins this list (conforming map or register) in the same PR
 *  that adds it. */
const INTERIOR_SURFACE_FILES: string[] = [
  // Routes (CONFORMING_ROUTES).
  "src/client/AgentsPanel.tsx",
  "src/client/ApprovalsPanel.tsx",
  "src/client/QueuesPage.tsx",
  "src/client/chat/tabs/EndpointsTab.tsx",
  "src/client/options/flows/OptionsFlowsHub.tsx",
  "src/client/OptionsScreenerPage.tsx",
  "src/client/PlatformAdminPage.tsx",
  "src/client/ProductCatalogPanel.tsx",
  "src/client/PaymentWorkflowAssurance.tsx",
  "src/client/CheckoutPanel.tsx",
  "src/client/MarketDataResearchHub.tsx",
  "src/client/search/SearchHub.tsx",
  "src/client/WorkflowRunsPanel.tsx",
  "src/client/WorkflowCatalogPage.tsx",
  "src/client/WorkflowsHub.tsx",
  "src/client/PaymentsPage.tsx",
  "src/client/SocialPostingPanel.tsx",
  "src/client/SchedulesHome.tsx",
  "src/client/chat/tabs/AdsTab.tsx",
  "src/client/chat/tabs/ReferralsTab.tsx",
  "src/client/chat/tabs/RevenueTab.tsx",
  "src/client/DocsAndReportsPanel.tsx",
  "src/client/BillingServicingPanel.tsx",
  "src/client/RiskAnalysisPanel.tsx",
  // Trading sub-tabs (CONFORMING_SUB_TABS).
  "src/client/TrackRecordPanel.tsx",
  "src/client/OrderTicketPanel.tsx",
  "src/client/components/AutopilotControlCenter.tsx",
  "src/client/GoalScreenPanel.tsx",
  "src/client/ReportsPanel.tsx",
  "src/client/ScreeningReviewPanel.tsx",
  "src/client/PortfolioPanel.tsx",
  "src/client/LedgerPanel.tsx",
  "src/client/OmnichannelPanel.tsx",
  "src/client/VoicePanel.tsx",
  // Hub hosts (register.subTabs shape files).
  "src/client/OptionsHub.tsx",
  "src/client/ScreenersHub.tsx",
  "src/client/StockHub.tsx",
  // Hub views.
  "src/client/IvHistoryPanel.tsx",
  "src/client/ScannerPanel.tsx",
  "src/client/options/OptionsResearchPanel.tsx",
  "src/client/options/ResearchRunsPanel.tsx",
  "src/client/options/DiscoveryRunsPanel.tsx",
  "src/client/options/RawContractsScreener.tsx",
  "src/client/options/LlmOptionsIdeasPanel.tsx",
  "src/client/ScreenerResultsView.tsx",
  "src/client/RunDetailView.tsx",
  "src/client/MorningDigest.tsx",
  "src/client/PatternsPanel.tsx",
  "src/client/PresetsPanel.tsx",
  "src/client/ScreenerPresetManager.tsx",
  "src/client/StockCriteriaPanel.tsx",
  // Platform Admin sections.
  "src/client/AccountAdminPanel.tsx",
  "src/client/AlpacaSignInCard.tsx",
  "src/client/ApiKeysPanel.tsx",
  "src/client/AsyncJobsPanel.tsx",
  "src/client/ChannelsAdminPanel.tsx",
  "src/client/DataLifecyclePanel.tsx",
  "src/client/DataProvidersPanel.tsx",
  "src/client/DownloadsPanel.tsx",
  "src/client/FreeRunAllowanceSection.tsx",
  "src/client/IaaaAdminPanel.tsx",
  "src/client/PlatformAdminPanel.tsx",
  "src/client/TenantAdminPanel.tsx",
  "src/client/UserAdminPanel.tsx",
  // Schedules views.
  "src/client/ScheduleQueueView.tsx",
  "src/client/ScheduleRunLedgerPanel.tsx",
  "src/client/ScheduledGoalsPanel.tsx",
  "src/client/SchedulesPanel.tsx",
  // Non-nav surface + hub host.
  "src/client/FirstRunScreen.tsx",
  "src/client/ETradeTradingHub.tsx",
];

/** Read one quoted string literal starting at text[i]. */
function readQuoted(text: string, i: number): { lit: string; next: number } {
  const q = text[i];
  let j = i + 1;
  let out = "";
  while (j < text.length && text[j] !== q) {
    if (text[j] === "\\" && j + 1 < text.length) {
      j += 2;
      continue;
    }
    out += text[j];
    j++;
  }
  return { lit: out, next: j + 1 };
}

/** Static segments of the template literal starting at text[i];
 *  ${...} interpolations are code, not classes, so they are skipped. */
function readTemplateStatic(
  text: string,
  i: number,
): { lits: string[]; next: number } {
  let j = i + 1;
  const lits: string[] = [];
  let buf = "";
  while (j < text.length && text[j] !== "`") {
    if (text[j] === "\\" && j + 1 < text.length) {
      buf += text[j + 1];
      j += 2;
      continue;
    }
    if (text[j] === "$" && text[j + 1] === "{") {
      lits.push(buf);
      buf = "";
      let depth = 1;
      j += 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      continue;
    }
    buf += text[j];
    j++;
  }
  lits.push(buf);
  return { lits, next: j + 1 };
}

/** String literals inside the braced expression starting at text[i]
 *  (balanced braces; quoted literals whole, template literals static
 *  segments only). */
function readBraced(
  text: string,
  i: number,
): { lits: string[]; next: number } {
  let depth = 0;
  const lits: string[] = [];
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "{") {
      depth++;
      j++;
    } else if (ch === "}") {
      depth--;
      j++;
      if (depth === 0) break;
    } else if (ch === '"' || ch === "'") {
      const r = readQuoted(text, j);
      lits.push(r.lit);
      j = r.next;
    } else if (ch === "`") {
      const r = readTemplateStatic(text, j);
      lits.push(...r.lits);
      j = r.next;
    } else {
      j++;
    }
  }
  return { lits, next: j };
}

/** String literals that are className attribute values. Only className=
 *  attributes count: prose in other strings is not a class. Comments
 *  are stripped so commented-out classNames do not count. */
function classNameLiterals(src: string): string[] {
  const text = stripComments(src);
  const lits: string[] = [];
  const re = /className\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (text[i] === " " || text[i] === "\t") i++;
    if (i >= text.length) break;
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const r = readQuoted(text, i);
      lits.push(r.lit);
      re.lastIndex = r.next;
    } else if (ch === "{") {
      const r = readBraced(text, i);
      lits.push(...r.lits);
      re.lastIndex = r.next;
    }
  }
  return lits;
}

/** className token occurrences: a token starting with `ui-` is a
 *  utility; anything else is bespoke. */
function countInteriorClasses(src: string): { ui: number; bespoke: number } {
  let ui = 0;
  let bespoke = 0;
  for (const lit of classNameLiterals(src)) {
    for (const tok of lit.split(/\s+/)) {
      if (!tok) continue;
      if (tok.startsWith("ui-")) ui++;
      else bespoke++;
    }
  }
  return { ui, bespoke };
}

function isInteriorConforming(sections: number, bespoke: number): boolean {
  return sections >= 1 && bespoke === 0;
}

interface InteriorCheck {
  id: string;
  sections: number;
  bespoke: number;
  entry?: InteriorEntry;
  conformingTarget: string;
}

/** Pure checker shared by the real gate and the synthetic test. */
function interiorViolations(checks: InteriorCheck[]): string[] {
  const violations: string[] = [];
  for (const c of checks) {
    if (!c.entry) {
      if (!isInteriorConforming(c.sections, c.bespoke)) {
        violations.push(
          `${c.id}: no PageSection or primitives-only interior and not registered ` +
            `(sections=${c.sections}, bespoke=${c.bespoke})`,
        );
      }
      continue;
    }
    if (c.bespoke > c.entry.bespokeClasses) {
      violations.push(
        `${c.id}: bespoke classes rose ${c.entry.bespokeClasses} -> ${c.bespoke}`,
      );
    }
    if (c.sections < c.entry.sections) {
      violations.push(
        `${c.id}: PageSections fell ${c.entry.sections} -> ${c.sections}`,
      );
    }
    if (isInteriorConforming(c.sections, c.bespoke)) {
      violations.push(`${c.id}: fully conforming now; ${c.conformingTarget}`);
    }
  }
  return violations;
}

describe("route shell conformance (#3047)", () => {
  it("every nav route is shell-conforming, registered, or excepted", () => {
    const navConfig = JSON.parse(
      readFileSync(join(HERE, "src", "client", "nav-config.json"), "utf8"),
    );
    const routeIds: string[] = navConfig.routes.map((r: { id: string }) => r.id);
    expect(routeIds.length).toBeGreaterThan(0);
    const register = loadRegister();
    const chatSrc = readFileSync(join(CLIENT_DIR, "Chat.tsx"), "utf8");
    const entries = parseTabContentEntries(chatSrc);
    expect([...entries.keys()].sort()).toEqual(
      [...EXPECTED_TAB_CONTENT_KEYS].sort(),
    );
    const hubSrcRaw = readFileSync(join(HERE, HUB_FILE), "utf8");
    const hubCode = stripComments(hubSrcRaw);

    const violations: string[] = [];
    const seen = new Set<string>();
    const check = (
      id: string,
      shellPresent: boolean,
      registered: boolean,
      note: string,
    ) => {
      if (seen.has(id)) violations.push(`${id}: claimed by two buckets`);
      seen.add(id);
      if (!shellPresent && !registered)
        violations.push(`${id}: no PageShell and not registered (${note})`);
    };

    for (const [id, file] of Object.entries(CONFORMING_ROUTES)) {
      const src = clean(readFileSync(join(HERE, file), "utf8"));
      const shell =
        src.includes("<PageShell") || src.includes("<PageTemplate");
      check(id, shell, false, `expected <PageShell in ${file}`);
    }
    for (const id of CHAT_INLINE_ROUTES) {
      const slice = entries.get(id) ?? "";
      check(id, clean(slice).includes("<PageShell"), false, "Chat.tsx entry");
    }
    // Trading wrapper: the PageShell opens before the first sub-tab
    // branch and closes after the last, so every trading route's page
    // content renders inside it (broker-unavailable Notice aside).
    // Branch markers carry string literals, so open/close/branch
    // indices are all taken on the same comment-stripped source, not
    // the string-stripped one (whose coordinates differ).
    const openIdx = hubCode.indexOf("<PageShell");
    const closeIdx = hubCode.indexOf("</PageShell>");
    // Search branches after the shell opens: iv-history also appears
    // earlier in the shellTitle computation, which is not a branch.
    const branchIdx = EXPECTED_SUB_TABS.map((t) =>
      openIdx === -1
        ? -1
        : hubCode.indexOf(`effectiveSubTab === "${t}"`, openIdx),
    );
    const wrapperOk =
      openIdx !== -1 &&
      closeIdx !== -1 &&
      branchIdx.every((i) => i > openIdx && i < closeIdx);
    for (const id of TRADING_ROUTES) {
      check(id, wrapperOk, false, "ETradeTradingHub wrapper shell");
    }
    for (const [id, entry] of Object.entries(register.routes)) {
      if (entry.kind === "migration") {
        // A migration entry must stay un-migrated: if its file gains a
        // PageShell, the migration landed and this entry must flip to
        // the conforming map in the same PR.
        const files =
          id === "docs"
            ? ["src/client/DocsAndReportsPanel.tsx"]
            : id === "billing"
              ? ["src/client/BillingServicingPanel.tsx"]
              : [];
        const migrated = files.some((f) =>
          clean(readFileSync(join(HERE, f), "utf8")).includes("<PageShell"),
        );
        check(id, false, !migrated, `migration #${entry.slice} landed?`);
      } else if (entry.kind === "exception") {
        check(id, false, true, entry.reason);
      } else {
        violations.push(`${id}: unknown register kind ${entry.kind}`);
        seen.add(id);
      }
    }
    for (const id of routeIds) {
      if (!seen.has(id)) violations.push(`${id}: in nav-config but no bucket`);
    }
    expect(violations).toEqual([]);
  });

  it("register route entries are tracked and live", () => {
    const navConfig = JSON.parse(
      readFileSync(join(HERE, "src", "client", "nav-config.json"), "utf8"),
    );
    const routeIds = new Set<string>(
      navConfig.routes.map((r: { id: string }) => r.id),
    );
    const register = loadRegister();
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(register.routes)) {
      if (!routeIds.has(id)) problems.push(`${id}: register entry, no route`);
      if (!entry.reason) problems.push(`${id}: register entry without reason`);
      if (entry.kind === "migration" && typeof entry.slice !== "number")
        problems.push(`${id}: migration without tracking slice`);
      if (entry.kind !== "migration" && entry.kind !== "exception")
        problems.push(`${id}: bad kind ${entry.kind}`);
    }
    expect(problems).toEqual([]);
  });

  it("gate bites: an unregistered shell-less route is a violation", () => {
    expect(
      findViolations([
        { id: "fake-page", shellPresent: false, registered: false },
      ]),
    ).toEqual(["fake-page"]);
    expect(
      findViolations([
        { id: "fake-page", shellPresent: false, registered: true },
      ]),
    ).toEqual([]);
    expect(
      findViolations([
        { id: "fake-page", shellPresent: true, registered: false },
      ]),
    ).toEqual([]);
  });
});

describe("trading sub-tab interiors (#3047)", () => {
  it("every TradingSubTab member is shell-conforming, shape, or migration-registered", () => {
    const hubSrc = readFileSync(join(HERE, HUB_FILE), "utf8");
    const members = parseTradingSubTabs(hubSrc);
    expect([...members].sort()).toEqual([...EXPECTED_SUB_TABS].sort());
    const register = loadRegister();
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const [id, file] of Object.entries(CONFORMING_SUB_TABS)) {
      const shell = clean(readFileSync(join(HERE, file), "utf8")).includes(
        "<PageShell",
      );
      seen.add(id);
      if (!shell) violations.push(`${id}: conforming map, no <PageShell in ${file}`);
    }
    for (const [id, entry] of Object.entries(register.subTabs)) {
      seen.add(id);
      if (entry.kind === "shape") {
        if (!entry.file || !existsSync(join(HERE, entry.file)))
          violations.push(`${id}: shape entry without an existing hub file`);
      } else if (entry.kind === "migration") {
        if (entry.inline) {
          // Branch markers carry string literals: match on the
          // comment-stripped source, not the string-stripped one.
          const hubCode = stripComments(hubSrc);
          if (!hubCode.includes(`effectiveSubTab === "${id}"`))
            violations.push(`${id}: inline migration, branch marker gone`);
        } else {
          const files = entry.files ?? (entry.file ? [entry.file] : []);
          if (files.length === 0)
            violations.push(`${id}: migration without a file`);
          for (const f of files) {
            if (!existsSync(join(HERE, f)))
              violations.push(`${id}: migration file missing: ${f}`);
            else if (
              clean(readFileSync(join(HERE, f), "utf8")).includes("<PageShell")
            )
              violations.push(
                `${id}: migration #${entry.slice} landed in ${f}; flip to conforming`,
              );
          }
        }
      } else {
        violations.push(`${id}: unknown sub-tab kind ${entry.kind}`);
      }
    }
    for (const id of members) {
      if (!seen.has(id)) violations.push(`${id}: sub-tab with no bucket`);
    }
    expect(violations).toEqual([]);
  });

  it("register sub-tab entries are tracked and live", () => {
    const hubSrc = readFileSync(join(HERE, HUB_FILE), "utf8");
    const members = new Set(parseTradingSubTabs(hubSrc));
    const register = loadRegister();
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(register.subTabs)) {
      if (!members.has(id)) problems.push(`${id}: register entry, no sub-tab`);
      if (!entry.reason) problems.push(`${id}: register entry without reason`);
      if (entry.kind === "migration" && entry.slice !== 3050)
        problems.push(`${id}: migration must track #3050, got ${entry.slice}`);
      if (entry.kind !== "migration" && entry.kind !== "shape")
        problems.push(`${id}: bad kind ${entry.kind}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("bespoke-CSS freeze (#3047)", () => {
  it("every css import resolves to the registry or the system sheets", () => {
    const registry = JSON.parse(
      readFileSync(join(TESTS_DIR, "one_off_stylesheets_1337.json"), "utf8"),
    ) as { path: string }[];
    const allowed = new Set([
      ...registry.map((e) => e.path),
      "src/client/components/ui/primitives.css",
      "src/client/tokens.css",
    ]);
    const offenders: string[] = [];
    for (const file of walkTsAll(CLIENT_DIR)) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(
        /(?:from\s+["']|import\s+["'])([^"']+\.css)["']/g,
      )) {
        const resolved = normalize(
          join(dirname(toRepoRel(file)), m[1]),
        )
          .split(sep)
          .join("/");
        if (!allowed.has(resolved))
          offenders.push(`${toRepoRel(file)} -> ${resolved}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the stylesheet registry is live", () => {
    const registry = JSON.parse(
      readFileSync(join(TESTS_DIR, "one_off_stylesheets_1337.json"), "utf8"),
    ) as { path: string }[];
    const missing = registry
      .map((e) => e.path)
      .filter((p) => !existsSync(join(HERE, p)));
    expect(missing).toEqual([]);
  });
});

describe("per-file inline-style budget (#3047)", () => {
  it("no file exceeds its baseline; unlisted files have none", () => {
    const baselines = JSON.parse(
      readFileSync(
        join(TESTS_DIR, "ux_inline_baselines_3047.json"),
        "utf8",
      ),
    ) as Record<string, number>;
    const violations: string[] = [];
    for (const file of walkTsx(CLIENT_DIR)) {
      const rel = toRepoRel(file);
      const count = countOccurrences(
        clean(readFileSync(file, "utf8")),
        "style={{",
      );
      const baseline = baselines[rel];
      if (baseline === undefined) {
        if (count > 0)
          violations.push(`${rel}: ${count} inline styles, no baseline`);
      } else if (count > baseline) {
        violations.push(`${rel}: ${count} inline styles, baseline ${baseline}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("baselines are live", () => {
    const baselines = JSON.parse(
      readFileSync(
        join(TESTS_DIR, "ux_inline_baselines_3047.json"),
        "utf8",
      ),
    ) as Record<string, number>;
    const missing = Object.keys(baselines).filter(
      (p) => !existsSync(join(HERE, p)),
    );
    expect(missing).toEqual([]);
  });
});

describe("interior consistency (#3991, S-U1)", () => {
  it("every routable surface uses PageSection or is registered; interiors are primitives-only or registered", () => {
    const register = loadRegister();
    const interiors = register.interiors ?? {};
    const chatSrc = readFileSync(join(CLIENT_DIR, "Chat.tsx"), "utf8");
    const entries = parseTabContentEntries(chatSrc);
    const checks: InteriorCheck[] = [];
    const seen = new Set<string>();
    for (const file of INTERIOR_SURFACE_FILES) {
      seen.add(file);
      const src = readFileSync(join(HERE, file), "utf8");
      const sections = countOccurrences(clean(src), "<PageSection");
      const { bespoke } = countInteriorClasses(src);
      checks.push({
        id: file,
        sections,
        bespoke,
        entry: interiors[file],
        conformingTarget: "flip to CONFORMING_INTERIORS",
      });
    }
    // Chat.tsx inline entries (audit/nlq): measured as slices, not
    // files — the host file is out of scope by design.
    for (const id of CHAT_INLINE_ROUTES) {
      const slice = entries.get(id) ?? "";
      const sections = countOccurrences(clean(slice), "<PageSection");
      const { bespoke } = countInteriorClasses(slice);
      checks.push({
        id,
        sections,
        bespoke,
        entry: interiors[id],
        conformingTarget: "remove the register entry",
      });
    }
    const violations = interiorViolations(checks);
    // Completeness: registry-tied files must be in the surface set.
    for (const file of Object.values(CONFORMING_ROUTES)) {
      if (!seen.has(file))
        violations.push(`${file}: route file with no interior bucket`);
    }
    for (const file of Object.values(CONFORMING_SUB_TABS)) {
      if (!seen.has(file))
        violations.push(`${file}: sub-tab file with no interior bucket`);
    }
    for (const entry of Object.values(register.subTabs)) {
      if (entry.file && !seen.has(entry.file))
        violations.push(`${entry.file}: hub file with no interior bucket`);
    }
    // The chat conversation stays a registered exception (routes register).
    if (register.routes.chat?.kind !== "exception") {
      violations.push("chat: conversation surface lost its routes exception");
    }
    expect(violations).toEqual([]);
  });

  it("register interior entries are tracked and live", () => {
    const register = loadRegister();
    const interiors = register.interiors ?? {};
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(interiors)) {
      if (!entry.reason)
        problems.push(`${id}: interior entry without reason`);
      if (entry.kind !== "migration" && entry.kind !== "exception")
        problems.push(`${id}: bad kind ${entry.kind}`);
      if (entry.kind === "migration" && typeof entry.slice !== "number")
        problems.push(`${id}: migration without tracking slice`);
      if (typeof entry.sections !== "number" || entry.sections < 0)
        problems.push(`${id}: bad sections snapshot`);
      if (
        typeof entry.bespokeClasses !== "number" ||
        entry.bespokeClasses < 0
      )
        problems.push(`${id}: bad bespokeClasses snapshot`);
      if (entry.chatEntry) {
        if (entry.chatEntry !== id)
          problems.push(`${id}: chatEntry must name its own slice`);
      } else if (!existsSync(join(HERE, id))) {
        problems.push(`${id}: interior entry, file missing`);
      }
    }
    const registered = new Set(
      Object.keys(interiors).filter((k) => !interiors[k].chatEntry),
    );
    for (const file of INTERIOR_SURFACE_FILES) {
      if (!CONFORMING_INTERIORS.includes(file) && !registered.has(file)) {
        problems.push(`${file}: surface file with no bucket`);
      }
      if (CONFORMING_INTERIORS.includes(file) && registered.has(file)) {
        problems.push(`${file}: claimed by both conforming map and register`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("gate bites: unregistered, regressed, and newly-conforming interiors are violations", () => {
    expect(
      interiorViolations([
        {
          id: "fake",
          sections: 0,
          bespoke: 5,
          conformingTarget: "flip",
        },
      ]),
    ).toEqual([
      "fake: no PageSection or primitives-only interior and not registered (sections=0, bespoke=5)",
    ]);
    expect(
      interiorViolations([
        {
          id: "fake",
          sections: 1,
          bespoke: 0,
          conformingTarget: "flip",
        },
      ]),
    ).toEqual([]);
    expect(
      interiorViolations([
        {
          id: "fake",
          sections: 0,
          bespoke: 3,
          entry: {
            kind: "migration",
            reason: "r",
            slice: 3695,
            sections: 0,
            bespokeClasses: 5,
          },
          conformingTarget: "flip",
        },
      ]),
    ).toEqual([]);
    expect(
      interiorViolations([
        {
          id: "fake",
          sections: 0,
          bespoke: 6,
          entry: {
            kind: "migration",
            reason: "r",
            slice: 3695,
            sections: 0,
            bespokeClasses: 5,
          },
          conformingTarget: "flip",
        },
      ]),
    ).toEqual(["fake: bespoke classes rose 5 -> 6"]);
    expect(
      interiorViolations([
        {
          id: "fake",
          sections: 0,
          bespoke: 0,
          entry: {
            kind: "migration",
            reason: "r",
            slice: 3695,
            sections: 2,
            bespokeClasses: 5,
          },
          conformingTarget: "flip",
        },
      ]),
    ).toEqual(["fake: PageSections fell 2 -> 0"]);
    expect(
      interiorViolations([
        {
          id: "fake",
          sections: 2,
          bespoke: 0,
          entry: {
            kind: "migration",
            reason: "r",
            slice: 3695,
            sections: 2,
            bespokeClasses: 5,
          },
          conformingTarget: "flip to CONFORMING_INTERIORS",
        },
      ]),
    ).toEqual(["fake: fully conforming now; flip to CONFORMING_INTERIORS"]);
  });
});
