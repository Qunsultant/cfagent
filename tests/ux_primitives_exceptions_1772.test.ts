import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

/**
 * UX primitives exceptions pin (#1772, parent #1717; source row F-53,
 * docs/architecture/UX/exceptions-01.md).
 *
 * The doc's audit listed 44 exception files bypassing UX primitives:
 * 28 zero-primitive + 16 partial. Re-audit against current main shows
 * all 44 already render ZERO raw controls (button/input/select/
 * textarea/table, the #1580 set) and import a ui primitive — they were
 * converted by prior work, so phases 1-3 of this issue close as
 * verified-done, not rebuilt. This test pins that state file by file:
 * a regression in any one of the 44 fails here by name.
 *
 * Count note: the doc's Category 1 enumerates 30 files, but two of
 * them — SchedulesPanel (resolved 2026-10-29 by #2329) and
 * PartnerDealsModal (uses the Modal primitive) — are carried in the
 * doc's own Category 3 compliant list. 30 - 2 = 28 zero-primitive,
 * 28 + 16 partial = the 44 this issue names. Both Category 3 files
 * are asserted compliant below as well, so the whole doc list is
 * covered and the arithmetic is checkable, not assumed.
 *
 * No file is deleted or renamed by this slice (edit-only pin + record).
 * The Phase 4 CI enforcement pin itself is the #1580 freeze
 * (tests/ux_primitive_usage_freeze_1580.test.ts, empty allowlist);
 * #1772's Phase 4 follow-up PR adds its negative test.
 */

const ROOT = process.cwd();
const CLIENT_DIR = join(ROOT, "src/client");

const RAW_CONTROLS = new Set(["button", "input", "select", "textarea", "table"]);

/** Count raw JSX controls in one source file, via the TypeScript AST. */
export function countRawControls1772(source: string, fileName: string): number {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (RAW_CONTROLS.has(node.tagName.getText(sourceFile))) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

/** A ui-primitive import: a components/ui path, or the ./ui barrel. */
export function importsUiPrimitive(source: string): boolean {
  return /from\s+["'](?:[^"']*components\/ui[^"']*|(?:\.{1,2}\/)+ui)["']/.test(source);
}

/** The 28 zero-primitive exceptions (doc Category 1 minus Category 3). */
const ZERO_PRIMITIVE_28 = [
  "src/client/SocialPostingPanel.tsx",
  "src/client/ScheduledGoalsPanel.tsx",
  "src/client/chat/AgentChatTabContent.tsx",
  "src/client/chat/ToolResultView.tsx",
  "src/client/chat/tabs/ReferralsTab.tsx",
  "src/client/chat/tabs/RevenueTab.tsx",
  "src/client/components/CapabilityNavBar.tsx",
  "src/client/components/NavigationMenu.tsx",
  "src/client/components/StockSearchBar.tsx",
  "src/client/components/MarketTickerTape.tsx",
  "src/client/components/AskAgentWidget.tsx",
  "src/client/ScannerPanel.tsx",
  "src/client/ScreenerResultsView.tsx",
  "src/client/ScreeningReviewPanel.tsx",
  "src/client/IvHistoryPanel.tsx",
  "src/client/options/RawContractsScreener.tsx",
  "src/client/options/ResearchRunsPanel.tsx",
  "src/client/options/LlmOptionsIdeasPanel.tsx",
  "src/client/options/LlmStrategyEvalModal.tsx",
  "src/client/options/flows/OptionsFlowsHub.tsx",
  "src/client/options/OptionsDataDownloadDropdown.tsx",
  "src/client/options/ScreeningActivityPanel.tsx",
  "src/client/PortfolioRiskPanel.tsx",
  "src/client/components/AutopilotControlCenter.tsx",
  "src/client/WorkflowsHub.tsx",
  "src/client/McpApiExplorer.tsx",
  "src/client/MemoryBrowser.tsx",
  "src/client/ResearchReportActions.tsx",
];

/** The 16 partial exceptions (doc Category 2). */
const PARTIAL_16 = [
  "src/client/ApiKeysPanel.tsx",
  "src/client/Chat.tsx",
  "src/client/DataProvidersPanel.tsx",
  "src/client/ETradeDynamicMenu.tsx",
  "src/client/ETradeTradingHub.tsx",
  "src/client/MarketDataResearchHub.tsx",
  "src/client/IaaaAdminPanel.tsx",
  "src/client/ReportsPanel.tsx",
  "src/client/ScreenersHub.tsx",
  "src/client/chat/tabs/AdsTab.tsx",
  "src/client/chat/tabs/ResearchRunDetail.tsx",
  "src/client/chat/tabs/ResearchTrackRecord.tsx",
  "src/client/options/AutonomousOptionsRuns.tsx",
  "src/client/options/DiscoveryRunsPanel.tsx",
  "src/client/options/EtapiConfigModal.tsx",
  "src/client/options/OptionsResearchPanel.tsx",
];

/** Doc Category 3 files that were also in the Category 1 enumeration. */
const ALREADY_COMPLIANT_2 = [
  "src/client/SchedulesPanel.tsx",
  "src/client/components/PartnerDealsModal.tsx",
];

const ALL_44 = [...ZERO_PRIMITIVE_28, ...PARTIAL_16];

function assertConverted(file: string): void {
  const full = join(ROOT, file);
  expect(existsSync(full), `${file} must still exist`).toBe(true);
  const source = readFileSync(full, "utf8");
  expect(countRawControls1772(source, file), `${file} must render 0 raw controls`).toBe(0);
  expect(importsUiPrimitive(source), `${file} must import a ui primitive`).toBe(true);
}

describe("countRawControls1772 (#1772)", () => {
  it("counts raw controls, including self-closing elements", () => {
    const source = `export const A = () => (<><button>Go</button><input type="text" /></>);`;
    expect(countRawControls1772(source, "A.tsx")).toBe(2);
  });

  it("does not count primitive components", () => {
    const source = `import { Button, TextInput } from "./components/ui";
      export const A = () => (<><Button>Go</Button><TextInput /></>);`;
    expect(countRawControls1772(source, "A.tsx")).toBe(0);
  });

  it("does not count tags inside comments or string literals", () => {
    const source = `// <button> not rendered
      const label = "<input> not rendered";
      export const A = () => (<div>{label}</div>);`;
    expect(countRawControls1772(source, "A.tsx")).toBe(0);
  });

  it("counts a table once, not its th/td/tr children", () => {
    const source = `export const A = () => (<table><tr><th>H</th><td>V</td></tr></table>);`;
    expect(countRawControls1772(source, "A.tsx")).toBe(1);
  });
});

describe("UX primitives exceptions pin (#1772 phases 1-3)", () => {
  it("the 44 exception files are exactly 28 zero-primitive + 16 partial", () => {
    expect(ZERO_PRIMITIVE_28).toHaveLength(28);
    expect(PARTIAL_16).toHaveLength(16);
    expect(ALL_44).toHaveLength(44);
    expect(new Set(ALL_44).size, "no file listed twice").toBe(44);
    expect(ALL_44.filter((f) => ALREADY_COMPLIANT_2.includes(f))).toEqual([]);
  });

  it("every zero-primitive exception file is converted (0 raw controls, imports a primitive)", () => {
    for (const file of ZERO_PRIMITIVE_28) {
      assertConverted(file);
    }
  });

  it("every partial exception file is converted (0 raw controls, imports a primitive)", () => {
    for (const file of PARTIAL_16) {
      assertConverted(file);
    }
  });

  it("the 2 Category 3 files excluded from the 44 are also compliant", () => {
    for (const file of ALREADY_COMPLIANT_2) {
      assertConverted(file);
    }
  });

  it("no exception file is silently dropped: all 44 + 2 still exist under src/client", () => {
    for (const file of [...ALL_44, ...ALREADY_COMPLIANT_2]) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(relative(CLIENT_DIR, join(ROOT, file)).startsWith(".."), `${file} must live under src/client`).toBe(false);
    }
  });
});
