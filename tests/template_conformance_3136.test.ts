/**
 * Template conformance (#3136, Phase 2): every nav route has a template
 * state in the register (`template` key of
 * tests/ux_shell_exceptions_3047.json), and each state's claim is
 * verified against the source — not just recorded.
 *
 * States: `template` (renders <PageTemplate), `shell` (renders
 * <PageShell, migrates later), `hub` (renders inside the trading hub's
 * PageShell wrapper), `chat-inline` (inline TAB_CONTENT entry in
 * Chat.tsx, inside Chat's PageShell), `exception` (not a page at all —
 * only `chat` today).
 *
 * Freeze-first: the conforming set is exactly the routes listed in
 * CONFORMING_TEMPLATE_ROUTES below. Wave 1 (#3138–#3140) extends that
 * list in its own PRs — a new PageTemplate consumer must flip its
 * register entry in the same PR, or this test fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = join(__dirname, "..");
const CLIENT_DIR = join(HERE, "src", "client");
const TESTS_DIR = __dirname;
const HUB_FILE = "src/client/ETradeTradingHub.tsx";
const CHAT_FILE = "src/client/Chat.tsx";

/** Routes whose panel file renders <PageTemplate> today. Wave 1 extends. */
const CONFORMING_TEMPLATE_ROUTES = ["risk-analysis", "order"];

type TemplateState =
  | "template"
  | "shell"
  | "hub"
  | "chat-inline"
  | "exception";

interface TemplateEntry {
  state: TemplateState;
  file?: string;
  reason: string;
  wave?: string;
}

const MIGRATION_WAVES = [
  "wave-1",
  "S-U4",
  "S-U5",
  "S-U6",
  "S-U7",
  "S-U8",
  "S-U9",
  "unassigned",
];

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function loadTemplateRegister(): Record<string, TemplateEntry> {
  const register = JSON.parse(
    readFileSync(join(TESTS_DIR, "ux_shell_exceptions_3047.json"), "utf8"),
  ) as { template?: Record<string, TemplateEntry> };
  return register.template ?? {};
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

describe("route template gate (#3136)", () => {
  it("every nav route has a template entry; every template entry names a nav route", () => {
    const navConfig = JSON.parse(
      readFileSync(join(HERE, "src", "client", "nav-config.json"), "utf8"),
    );
    const routeIds: string[] = navConfig.routes.map(
      (r: { id: string }) => r.id,
    );
    const template = loadTemplateRegister();
    const violations: string[] = [];
    for (const id of routeIds) {
      if (!template[id])
        violations.push(`${id}: in nav-config but no template entry`);
    }
    for (const id of Object.keys(template)) {
      if (!routeIds.includes(id))
        violations.push(`${id}: template entry, no route`);
    }
    expect(violations).toEqual([]);
  });

  it("template entries are well-formed", () => {
    const template = loadTemplateRegister();
    const problems: string[] = [];
    const states: TemplateState[] = [
      "template",
      "shell",
      "hub",
      "chat-inline",
      "exception",
    ];
    for (const [id, entry] of Object.entries(template)) {
      if (!states.includes(entry.state))
        problems.push(`${id}: bad state ${entry.state}`);
      if (!entry.reason)
        problems.push(`${id}: template entry without reason`);
      if (
        entry.state === "shell" ||
        entry.state === "hub" ||
        entry.state === "chat-inline"
      ) {
        if (!entry.wave)
          problems.push(`${id}: migration state without wave`);
        else if (!MIGRATION_WAVES.includes(entry.wave))
          problems.push(`${id}: bad wave ${entry.wave}`);
        if (!entry.file)
          problems.push(`${id}: migration state without file`);
      }
      if (entry.state === "template" || entry.state === "exception") {
        if (entry.wave !== undefined)
          problems.push(`${id}: ${entry.state} state must not carry a wave`);
      }
      if (
        entry.state === "template" ||
        entry.state === "shell" ||
        entry.state === "hub" ||
        entry.state === "chat-inline"
      ) {
        if (!entry.file) problems.push(`${id}: state without file`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the conforming set is exactly the registered template routes", () => {
    const template = loadTemplateRegister();
    const conforming = Object.entries(template)
      .filter(([, e]) => e.state === "template")
      .map(([id]) => id)
      .sort();
    expect(conforming).toEqual([...CONFORMING_TEMPLATE_ROUTES].sort());
  });

  it("each route's claimed template state matches the source", () => {
    const template = loadTemplateRegister();
    const hubSrc = stripComments(readFileSync(join(HERE, HUB_FILE), "utf8"));
    const chatSrc = stripComments(
      readFileSync(join(HERE, CHAT_FILE), "utf8"),
    );
    const violations: string[] = [];
    for (const [id, entry] of Object.entries(template)) {
      if (entry.state === "template" || entry.state === "shell") {
        const src = stripComments(
          readFileSync(join(HERE, entry.file as string), "utf8"),
        );
        const hasTemplate = src.includes("<PageTemplate");
        const hasShell = src.includes("<PageShell");
        if (entry.state === "template" && (!hasTemplate || hasShell))
          violations.push(
            `${id}: claimed template but ${entry.file} has template=${hasTemplate} shell=${hasShell}`,
          );
        if (entry.state === "shell" && (!hasShell || hasTemplate))
          violations.push(
            `${id}: claimed shell but ${entry.file} has template=${hasTemplate} shell=${hasShell}`,
          );
      } else if (entry.state === "hub") {
        if (!hubSrc.includes("<PageShell") || hubSrc.includes("<PageTemplate"))
          violations.push(
            `${id}: claimed hub but ${HUB_FILE} has no PageShell wrapper`,
          );
      } else if (entry.state === "chat-inline") {
        if (!chatSrc.includes("<PageShell"))
          violations.push(`${id}: claimed chat-inline but Chat.tsx has no shell`);
        if (!chatSrc.includes(`"${id}"`))
          violations.push(`${id}: claimed chat-inline but no TAB_CONTENT entry`);
      } else if (entry.state === "exception") {
        if (id !== "chat")
          violations.push(`${id}: only chat may be a template exception`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("RiskAnalysisPanel is the conforming reference: slots used, no layout CSS, no bespoke card/header classes", () => {
    const src = readFileSync(
      join(CLIENT_DIR, "RiskAnalysisPanel.tsx"),
      "utf8",
    );
    // Slots used: title + scopeNote + children workspace only — no
    // contextStrip / kpiRibbon / actionBar / queueRail props yet.
    expect(src).toContain("<PageTemplate");
    expect(countOccurrences(src, "<PageTemplate")).toBe(1);
    expect(src).toContain('title="Risk Analysis"');
    expect(src).toContain("scopeNote=");
    for (const slot of ["contextStrip=", "kpiRibbon=", "actionBar=", "queueRail="]) {
      expect(src).not.toContain(slot);
    }
    // No layout CSS: no className at all, no stylesheet import.
    expect(countOccurrences(src, "className")).toBe(0);
    expect(src).not.toMatch(/\.css["']/);
    // No bespoke card/header classes: Card + CardHeader come from the
    // ui/ primitives, never from a local class.
    expect(src).toContain('from "./components/ui"');
    expect(src).toContain("<CardHeader");
    expect(src).not.toContain("<PageShell");
  });

  it("OrderTicketPanel is conforming: slots used, one sanctioned className, no layout CSS", () => {
    const src = readFileSync(
      join(CLIENT_DIR, "OrderTicketPanel.tsx"),
      "utf8",
    );
    // Slots used: title + scopeNote + contextStrip + queueRail —
    // no kpiRibbon / actionBar props yet.
    expect(src).toContain("<PageTemplate");
    expect(countOccurrences(src, "<PageTemplate")).toBe(1);
    expect(src).toContain('title="Order Ticket"');
    expect(src).toContain("scopeNote=");
    expect(src).toContain("contextStrip=");
    expect(src).toContain("queueRail=");
    for (const slot of ["kpiRibbon=", "actionBar="]) {
      expect(src).not.toContain(slot);
    }
    // One className only: the sanctioned ui-footnote text utility on
    // the "1. Edit the contracts…" footnote. The quote peek's ui-meta
    // uses left with the peek (ContextStrip renders them).
    expect(countOccurrences(src, "className")).toBe(1);
    expect(src).toContain('className="ui-footnote"');
    // No layout CSS: no stylesheet import.
    expect(src).not.toMatch(/\.css["']/);
    // No bespoke card/header classes: Card + CardHeader come from the
    // ui/ primitives, never from a local class.
    expect(src).toContain('from "./components/ui"');
    expect(src).toContain("<CardHeader");
    expect(src).not.toContain("<PageShell");
  });
});
