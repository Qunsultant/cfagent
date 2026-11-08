/**
 * UX uniformity, epic #3046 slice #3047 — conformance gates.
 *
 * A page that diverges must fail CI, not just look wrong. Three gates
 * share one scanner (no drift between them):
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
 *
 * Scanner discipline copied from the #2283 no-native-alert pin:
 * comments stripped (line comments guarded so https:// survives),
 * string-literal contents dropped, template ${...} interpolation code
 * kept (it is code, not prose).
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
