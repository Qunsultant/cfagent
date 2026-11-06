/**
 * Options copy hub (issue #2954) — the page behind ?tab=options, linked
 * from the Options Screener sub-menus.
 *
 * One single row of tabs; no top-level "options" container tab. The five
 * options-research modes render through ONE OptionsResearchPanel
 * instance driven in controlled mode (its own mode bar hidden), so the
 * shared symbol state survives tab switches the way the old in-panel
 * mode switches did. Panels mount on first visit and stay preserved
 * in the DOM, the same retention pattern ScreenersHub/StockHub use.
 */
import { useEffect, useState } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  CapabilityNavBar,
  CopilotTriggerButton,
  type CapabilityTabItem,
} from "./components/CapabilityNavBar";
import { TabPanel } from "./components/ui";
import { ScannerPanel } from "./ScannerPanel";
import { IvHistoryPanel } from "./IvHistoryPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { OptionsFlowsHub } from "./options/flows";
import { ResearchRunsPanel } from "./options/ResearchRunsPanel";
import {
  OptionsResearchPanel,
  type ResearchMode,
} from "./options/OptionsResearchPanel";
import { researchSurfaceForParam } from "./options/researchSurface";
import { navigateToTab } from "./router";
import type { TradeOrderContext } from "./trading/tradeOrderContext";

export type OptionsHubTab =
  | "strategy-scanner"
  | "options-runs"
  | "strategy-discovery"
  | "contracts-screener"
  | "custom-thesis"
  | "nlq-options"
  | "ai-strategy-ideas"
  | "iv-history"
  | "options-flows";

export const OPTIONS_HUB_TABS: readonly OptionsHubTab[] = [
  "strategy-scanner",
  "options-runs",
  "strategy-discovery",
  "contracts-screener",
  "custom-thesis",
  "nlq-options",
  "ai-strategy-ideas",
  "iv-history",
  "options-flows",
] as const;

export function isValidOptionsHubTab(tab: unknown): tab is OptionsHubTab {
  return (
    typeof tab === "string" &&
    (OPTIONS_HUB_TABS as readonly string[]).includes(tab)
  );
}

/** The five research modes, as copy-hub tabs. */
const MODE_TABS: readonly OptionsHubTab[] = [
  "strategy-discovery",
  "contracts-screener",
  "custom-thesis",
  "nlq-options",
  "ai-strategy-ideas",
];

const TAB_TO_MODE: Record<string, ResearchMode> = {
  "strategy-discovery": "discovery",
  "contracts-screener": "contracts",
  "custom-thesis": "custom",
  "nlq-options": "nlq",
  "ai-strategy-ideas": "llm-ideas",
};

const MODE_TO_TAB: Record<ResearchMode, OptionsHubTab> = {
  discovery: "strategy-discovery",
  contracts: "contracts-screener",
  custom: "custom-thesis",
  nlq: "nlq-options",
  "llm-ideas": "ai-strategy-ideas",
};

/**
 * Legacy ?research= surface → copy tab, so old sub-menu bookmarks keep
 * resolving to the same content they landed on before #2954. Returns
 * null for unknown values — never a wrong landing.
 */
export function optionsHubTabForResearch(
  value: string | null | undefined,
): OptionsHubTab | null {
  const surface = researchSurfaceForParam(value);
  if (!surface) return null;
  return MODE_TO_TAB[surface.mode] ?? null;
}

function discoveryViewFromUrl(): "builder" | "discovery" {
  if (typeof window === "undefined") return "builder";
  return new URLSearchParams(window.location.search).get("discoveryView") ===
    "discovery"
    ? "discovery"
    : "builder";
}

function legacyTabFromUrl(): OptionsHubTab | null {
  if (typeof window === "undefined") return null;
  return optionsHubTabForResearch(
    new URLSearchParams(window.location.search).get("research"),
  );
}

interface OptionsHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  user?: { name?: string; login: string };
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  /** The tab to open on — the Trading Hub's screening redirects pass it. */
  initialTab?: OptionsHubTab;
  onTabChange?: (tab: OptionsHubTab) => void;
}

export function OptionsHub({
  activeEnv,
  userLogin,
  user,
  onPreviewTrade,
  onJobStateChange,
  onSendPrompt,
  initialTab,
  onTabChange,
}: OptionsHubProps) {
  // Legacy research= bookmarks resolve through initialTab: the hook
  // reads the view param first, so a valid view always wins.
  const { activeTab: hubTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<OptionsHubTab>({
      param: "view",
      aliases: ["screenerTab", "tab"],
      isValid: isValidOptionsHubTab,
      defaultTab: "strategy-scanner",
      initialTab: legacyTabFromUrl() ?? initialTab ?? null,
      onTabChange,
    });

  const isModeTab = (MODE_TABS as readonly string[]).includes(hubTab);
  const modeVisited = MODE_TABS.some((t) => visitedTabs.has(t));
  // The panel stays controlled at all times: on non-mode tabs it keeps
  // the last mode, so its research-param effects never re-enable while
  // hidden and its symbol state survives tab switches.
  const [lastMode, setLastMode] = useState<ResearchMode>(() =>
    (MODE_TABS as readonly string[]).includes(hubTab)
      ? TAB_TO_MODE[hubTab]
      : "discovery",
  );
  useEffect(() => {
    if (isModeTab) setLastMode(TAB_TO_MODE[hubTab]);
  }, [hubTab, isModeTab]);
  // The discovery view rides its own param; the panel instance remounts
  // when it changes (Discovery vs Strategy Panel sub clicks), so URL and
  // view cannot disagree the way #2923's tab bug did. Tab switches
  // leave the param alone, so the instance — and its symbol state —
  // survives them.
  const discoveryView = discoveryViewFromUrl();
  const panelKey = `options-research-panel-${discoveryView}`;

  const optionsTabs: CapabilityTabItem[] = [
    {
      id: "strategy-scanner",
      label: "Strategy Scanner",
      icon: "🎯",
      badge: "AI",
      badgeType: "purple",
      tooltip: {
        eyebrow: "STRATEGY / SYMBOL SCANNING",
        title: "Strategy/Symbol Scanner",
        description:
          "Best strategy for a name, or names that fit your strategy — across the full strategy catalog.",
      },
    },
    {
      id: "options-runs",
      label: "Options Runs",
      icon: "🗂️",
      tooltip: {
        eyebrow: "RESEARCH RUNS",
        title: "Options Runs",
        description:
          "The record of manual and scheduled options research runs — one surface for both.",
      },
    },
    {
      id: "strategy-discovery",
      label: "Strategy Discovery & Payoff Analyzer",
      icon: "🎯",
      tooltip: {
        eyebrow: "ALGORITHMIC SELECTION ENGINE",
        title: "Strategy Discovery & Payoff Analyzer",
        description:
          "Explore multi-leg option strategies (Iron Condors, Spreads, Straddles, Covered Calls) matched to market sentiment with interactive payoff charts and Greeks.",
      },
    },
    {
      id: "contracts-screener",
      label: "Contracts Screener",
      icon: "📋",
      tooltip: {
        eyebrow: "LIVE CHAIN FILTERING",
        title: "Contracts Screener",
        description:
          "Directly filter individual Call and Put contracts across symbols, DTE windows, strikes, bid/ask spreads, volume, and Greeks.",
      },
    },
    {
      id: "custom-thesis",
      label: "Custom Thesis & Strategy Universe",
      icon: "⚙️",
      tooltip: {
        eyebrow: "CONSTRAINED OPTION SCANNING",
        title: "Custom Thesis & Strategy Universe",
        description:
          "Declare specific target prices, target dates, and IV assumptions to filter and rank tailored candidate structures.",
      },
    },
    {
      id: "nlq-options",
      label: "NLQ-options",
      icon: "💬",
      badge: "AI",
      badgeType: "cyan",
      tooltip: {
        eyebrow: "AI-POWERED PROMPT SCREENING",
        title: "NLQ-options",
        description:
          "Ask questions in plain English like 'Find high IV call spreads on NVDA with 30 DTE' to run instant options filters.",
      },
    },
    {
      id: "ai-strategy-ideas",
      label: "AI Strategy Ideas & Exporter",
      icon: "🧪",
      tooltip: {
        eyebrow: "INDEPENDENT RAW-DATA AI ANALYSIS",
        title: "AI Strategy Ideas & Exporter",
        description:
          "Divides chains into near/mid/long-term expiration cohorts for multi-stage AI evaluation against raw market data.",
      },
    },
    {
      id: "iv-history",
      label: "IV History",
      icon: "📈",
      tooltip: {
        eyebrow: "IMPLIED VOLATILITY",
        title: "IV History",
        description:
          "Daily option-chain IV snapshots: per-symbol coverage, IV rank, and the latest readings.",
      },
    },
    {
      id: "options-flows",
      label: "Options Flows",
      icon: "🌊",
      tooltip: {
        eyebrow: "INSTITUTIONAL FLOW",
        title: "Options Flows",
        description:
          "Options flows, dark pool prints, institutional sweeps, blocks, and insider disclosures.",
      },
    },
  ];

  return (
    <section className="trading-section screeners-hub">
      <CapabilityNavBar
        ariaLabel="Options capabilities"
        tabs={optionsTabs}
        activeTabId={hubTab}
        onTabChange={handleTabChange}
        rightContent={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              fontSize: "var(--font-size-body-sm)",
              color: "var(--color-text-muted)",
            }}
          >
            <CopilotTriggerButton label="✨ Ask Copilot" />
          </div>
        }
      />

      {/* Tabbed Browsing Panels — mount on first visit, stay preserved. */}

      {visitedTabs.has("strategy-scanner") && (
        <TabPanel
          idBase="cap"
          tabId="strategy-scanner"
          active={hubTab === "strategy-scanner"}
          retain
        >
          <ErrorBoundary label="Strategy/Symbol Scanner panel">
            <ScannerPanel
              activeEnv={activeEnv}
              userLogin={userLogin}
              onPreviewTrade={onPreviewTrade}
            />
          </ErrorBoundary>
        </TabPanel>
      )}

      {visitedTabs.has("options-runs") && (
        <TabPanel
          idBase="cap"
          tabId="options-runs"
          active={hubTab === "options-runs"}
          retain
        >
          <ResearchRunsPanel
            activeEnv={activeEnv}
            userLogin={userLogin}
            onSendPrompt={onSendPrompt}
          />
        </TabPanel>
      )}

      {/* The five research modes share one panel instance. It stays a
          hand-rolled div: one panel spans five mode tabs, so its
          aria-labelledby tracks the active mode tab — a fixed TabPanel
          tabId cannot express that. The single-tab panels above and
          below use the ui TabPanel primitive. */}
      {modeVisited && (
        <div
          role="tabpanel"
          id="options-tabpanel-research"
          aria-labelledby={`cap-tab-${hubTab}`}
          hidden={!isModeTab}
          style={!isModeTab ? { display: "none" } : undefined}
        >
          <OptionsResearchPanel
            key={panelKey}
            activeEnv={activeEnv}
            userLogin={userLogin}
            onPreviewTrade={onPreviewTrade}
            onJobStateChange={onJobStateChange}
            onSendPrompt={onSendPrompt}
            mode={lastMode}
            onModeChange={(m) => handleTabChange(MODE_TO_TAB[m])}
            hideModeNav
            initialDiscoveryView={discoveryView}
          />
        </div>
      )}

      {visitedTabs.has("iv-history") && (
        <TabPanel
          idBase="cap"
          tabId="iv-history"
          active={hubTab === "iv-history"}
          retain
        >
          <IvHistoryPanel />
        </TabPanel>
      )}

      {visitedTabs.has("options-flows") && (
        <TabPanel
          idBase="cap"
          tabId="options-flows"
          active={hubTab === "options-flows"}
          retain
        >
          <OptionsFlowsHub
            user={user?.name ? { name: user.name, login: user.login } : undefined}
            onSendPrompt={onSendPrompt}
            onTradeSymbol={() => navigateToTab("order")}
          />
        </TabPanel>
      )}
    </section>
  );
}
