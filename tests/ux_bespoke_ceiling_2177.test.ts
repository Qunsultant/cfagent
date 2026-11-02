/**
 * Issue #2177 (epic #2150 slice 4) — bespoke-styling ceiling.
 *
 * The sweep is measurable: these counts only ratchet DOWN. A rise means
 * a new bespoke class, a new inline-style layout, or a new raw label
 * landed, and the PR that did it must either convert it or raise the
 * ceiling deliberately with a reason in the PR body — never silently.
 * Data-driven inline styles (per-record colors) are counted here too;
 * the PR body names them as data when they are the reason a count
 * cannot fall further.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "src", "client");

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "components" && dir === clientDir) {
        // components/ui is the primitives' home; its styles are the system,
        // not bespoke. Other components/* files still count.
        for (const sub of readdirSync(full)) {
          if (sub === "ui") continue;
          const subFull = join(full, sub);
          if (statSync(subFull).isDirectory()) walkTsx(subFull, out);
          else if (sub.endsWith(".tsx")) out.push(subFull);
        }
        continue;
      }
      walkTsx(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function walkCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkCss(full, out);
    } else if (entry.endsWith(".css")) {
      // tokens.css is the system itself; primitives.css is the system
      // too. Every other client stylesheet is bespoke by definition.
      if (entry === "tokens.css") continue;
      if (full.replace(/\\/g, "/").includes(`${"components"}/ui/primitives.css`)) continue;
      out.push(full);
    }
  }
  return out;
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

describe("bespoke-styling ceiling (issue #2177)", () => {
  it("bespoke stylesheets do not grow", () => {
    // Baseline measured on main 8414089 across every client stylesheet
    // except tokens.css and primitives.css (21 files). The styles.css-only
    // figure (1,847 braces / 1,295 classes) undercounted: per-panel and
    // per-area sheets hold the rest.
    let braces = 0;
    const classes = new Set<string>();
    for (const file of walkCss(clientDir)) {
      const css = readFileSync(file, "utf8");
      braces += countOccurrences(css, "{");
      for (const match of css.match(/\.[a-z][a-z0-9-]+/g) ?? []) {
        classes.add(match);
      }
    }
    // Bumped 3828 -> 3845 and 2610 -> 2622 for the Platform Admin drawer
    // (issue #2624): 12 scoped classes + the media-query block it needs.
    // Sanctioned growth named in the PR body, per this test's own rule.
    // Ratcheted to 3838 / 2619 by the #2177 close (retired bespoke
    // checkbox-row rules; see the raw-label ratchet below).
    // Bumped 3842 -> 3867 for issue #2681: the ServiceTokensPanel
    // stylesheet (25 braces, tokens only, registered in
    // one_off_stylesheets_1337.json). Sanctioned growth named in
    // the PR body, per this test's own rule.
    // Bumped 3867 -> 3871 for issue #2703: Platform Admin sub-menu icon styling.
        // Bumped 3871 -> 3891 and 2648 -> 2659 for issue #2720: Multi-broker harmonization.
    // Bumped 3891 -> 3905 and 2659 -> 2664 for issue #2723: Tabular DataProvidersPanel
    // and consolidated provider connectivity callout (tokens only).
    expect(braces).toBeLessThanOrEqual(3905);
    // Classes bumped 2619 -> 2646 for the same #2681 sheet (27 stp-
    // classes, tokens only).
    // Classes bumped 2646 -> 2648 for issue #2703 (platform-admin-menu-row, platform-admin-menu-icon).
    // Classes bumped 2648 -> 2659 for issue #2720 (etrade-controls-single-line, btn-env-mini, etc.).
    // Classes bumped 2659 -> 2669 for issue #2723 (provider-dashboard-callout, provider-callout-inner, etc.).
    expect(classes.size).toBeLessThanOrEqual(2669); // ratcheted from 2622 by the #2177 close
  });

  it("inline styles and raw labels outside the primitives do not grow", () => {
    let inlineStyles = 0;
    let rawLabels = 0;
    for (const file of walkTsx(clientDir)) {
      const src = readFileSync(file, "utf8");
      inlineStyles += countOccurrences(src, "style={{");
      rawLabels += countOccurrences(src, "<label");
    }
    // Baselines are occurrence counts measured by this test on main
    // 8414089 (the earlier 839 figure was a grep line count; four lines
    // hold two style props each, hence 843 occurrences). The label
    // baseline is 223, not 222: the c66332c advance (checkout UI
    // rebuild, the branch base) added one raw <label> in
    // CheckoutPanel.tsx after the 8414089 measurement. That label is
    // pre-existing on the base, not growth from this change.
    // Ratcheted to 121 by the chunk-2 top-4 conversion (EtapiConfigModal
    // 29, OptionsResearchPanel 25, ScannerPanel 22, DiscoveryFormSections
    // 26); 5 checkbox-wrapper labels remain in those files by design
    // (Checkbox is a bare control), counted in the 121.
    // Ratcheted to 56 by chunk 3 (StrategyDiscoveryPanel 11,
    // PortfolioRiskPanel 14, ETradeTradingHub 14, ScheduleFormModal 11,
    // ScreenersHub 10, FlowFiltersSidebar 5); 3 pill-row labels and 4
    // checkbox-row labels remain in those files by design, counted in
    // the 56.
    // Ratcheted to 22 by chunk 4 (MarketDataResearchHub 7,
    // AutopilotControlCenter 6, CadenceFields 5, GoalScreenPanel 3,
    // NotificationFields 1, RawContractsScreener 3,
    // ResearchReportActions 3, ThesisRiskFields 2,
    // LlmOptionsIdeasPanel 2, LlmStrategyEvalModal 1, IvHistoryPanel 1);
    // the remaining 22 were all sanctioned exceptions: 18 checkbox-wrapper
    // labels (Checkbox is a bare control) and 3 pill-row labels, plus the
    // ResearchRunsPanel config-list row label whose control varies
    // between Checkbox and TextInput.
    // Resolved to 0 by the #2177 close (this change): Checkbox gains a
    // label prop — the primitive gap that forced the 18 hand-rolled
    // wrappers — and all 18 migrate to it; the 3 pill-row captions
    // become spans (they never labeled a control; two controls already
    // carried aria-labels); the varying-control row uses
    // aria-labelledby on a captioned span (layout preserved, controls
    // now actually named — the old unassociated <label> named nothing).
    // Off-scale margins on the retired rows (0.9rem, 1.35rem) go with
    // them; flow/compare treatments retarget to .ui-checkbox-label
    // scoped to their panel. Measured on this tree: braces 3838,
    // classes 2619, inline 807, rawLabels 0.
    expect(inlineStyles).toBeLessThanOrEqual(807);
    expect(rawLabels).toBeLessThanOrEqual(0);
  });
});
