import { useMemo } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  SCREENING_ASSET_CLASSES,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "./components/CapabilityNavBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { Notice, PageSection } from "./components/ui";
import "./optionsResearch.css";

/** S8 (consolidation, umbrella #958): the hub's tabs — the four
 *  planned asset classes only.
 *  Issue #2954: this hub is now the Assets Hub — the options research,
 *  scanner, IV history, patterns, and presets tabs moved out (options
 *  to the Options copy hub, patterns/presets to StockHub).
 *  Issue #2970: goal-screen, reports, schedules, review, and
 *  track-record became own pages; issue #2971 removes them from this
 *  hub, so the hub keeps only forex, futures, commodities, bonds.
 *  Issue #2896: the stocks tabs moved to Stock Hub. */
/**
 * Issue #2545: the Stocks one-shot form's delivery selection — the
 * scheduled "Stock Market Screen" job's delivery fields, named
 * exactly as the schedule payload names them (deliveryFields in
 * src/trading/screeningSchemas.ts), plus the report flag.
 */
export interface StockRunDeliverySelection {
  pushToSlack: boolean;
  slackChannel: string;
  emailTo: string;
  webhookUrl: string;
  generatePdf: boolean;
}

/**
 * Issue #2545: the one-shot run request body — the screen filters
 * plus the delivery envelope, built with the schedule payload
 * builders' conventions: slackChannel rides only when Slack push is
 * on, blank recipients are omitted (never sent as empty strings),
 * recipients are trimmed. The server splits the envelope out of the
 * engine filter (parseStockScreenRequest) and stamps it onto the
 * run's delivery outcome, so a manual run with delivery options
 * produces the same artifacts as the scheduled run.
 */
export function buildStockRunRequestBody(
  filters: Record<string, unknown>,
  delivery: StockRunDeliverySelection,
): Record<string, unknown> {
  return {
    ...filters,
    pushToSlack: delivery.pushToSlack,
    ...(delivery.pushToSlack && delivery.slackChannel.trim()
      ? { slackChannel: delivery.slackChannel.trim() }
      : {}),
    ...(delivery.emailTo.trim() ? { emailTo: delivery.emailTo.trim() } : {}),
    ...(delivery.webhookUrl.trim() ? { webhookUrl: delivery.webhookUrl.trim() } : {}),
    generatePdf: delivery.generatePdf,
  };
}

export type ScreenersHubTab = "forex" | "futures" | "commodities" | "bonds";

export const SCREENER_HUB_TABS: readonly ScreenersHubTab[] = [
  "forex",
  "futures",
  "commodities",
  "bonds",
] as const;

export function isValidScreenerTab(tab: unknown): tab is ScreenersHubTab {
  return typeof tab === "string" && (SCREENER_HUB_TABS as readonly string[]).includes(tab);
}

interface ScreenersHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onStocksLoaded?: (rows: ScreenedStockItem[]) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  /** S8: the tab to open on — the Trading Hub's screening redirects
   *  deep-link into the hub with the folded surface's tab. */
  initialTab?: ScreenersHubTab;
  onTabChange?: (tab: ScreenersHubTab) => void;
}


// Issue #212: a persisted autonomous screener run.
// Issue #253: allStocks carries the full scanned set (not just standouts).
// Issue #261: trigger identifies the source for the unified UI.
// Issue #125: universe + partial mirror ScreenerRunResult so retained runs
// can be listed with their scope and status (see screenRunStatus).
interface ScreenRun {
  timestamp: string;
  pdfKey?: string;
  reportUrl?: string;
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  opportunities: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
  }>;
  allStocks?: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
    rsi14: number | null;
    source: string;
  }>;
  error?: string;
}

// Issue #125: run status, derived from the fields ScreenerRunResult
// actually carries — a failed run has success:false (+ error); a partial
// run is a success that ran on an incomplete quote set (#462 qualification);
// anything else is a clean success. Quiet runs (success, zero standouts)
// are ordinary successes — they are history, not alerts.
export type ScreenRunStatus = "success" | "partial" | "failed";

export function screenRunStatus(run: Pick<ScreenRun, "success" | "partial">): ScreenRunStatus {
  if (!run.success) return "failed";
  if (run.partial) return "partial";
  return "success";
}

export const SCREEN_RUN_STATUS_LABELS: Record<ScreenRunStatus, string> = {
  success: "Success",
  partial: "Partial",
  failed: "Failed",
};

// Issue #125: the viewed run is tracked by timestamp so a polling refresh
// that prepends a newer run never silently re-points the view at a
// different run; a selection that has aged out of the retained history
// (or no selection yet) falls back to the latest run.
export function resolveSelectedRun<T extends { timestamp: string }>(
  runs: T[],
  selectedTimestamp: string | null,
): T | undefined {
  if (selectedTimestamp) {
    const found = runs.find((run) => run.timestamp === selectedTimestamp);
    if (found) return found;
  }
  return runs[0];
}

function numberFilter(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

export function ScreenersHub({
  activeEnv,
  userLogin,
  initialTab,
  onTabChange,
}: ScreenersHubProps) {
  // Tabbed browsing via the shared hook (S2, #2027): canonical param is
  // `view`; `screenerTab` (and `tab`) stay as read-only legacy aliases so
  // existing bookmarks and hash links keep resolving.
  const { activeTab: hubTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<ScreenersHubTab>({
      param: "view",
      aliases: ["screenerTab", "tab"],
      isValid: isValidScreenerTab,
      defaultTab: "forex",
      initialTab: initialTab ?? null,
      onTabChange,
    });

  // The provider-adapter machinery below serves the asset classes.
  // Issue #2971: the folded tabs are gone, so the hub tab IS the
  // asset class — no borrowing.
  const assetClass: ScreeningAssetClass = hubTab;
  const screenerTabs: CapabilityTabItem[] = useMemo(() => {
    const descriptions: Record<string, { eyebrow: string; title: string; desc: string; icon: string }> = {
      forex: {
        eyebrow: "CURRENCY PAIRS",
        title: "Forex Screener · Planned",
        desc: "Screen foreign exchange pairs across global FX liquidity pools (adapter in development).",
        icon: "💱",
      },
      futures: {
        eyebrow: "COMMODITY & INDEX FUTURES",
        title: "Futures Screener · Planned",
        desc: "Screen E-mini index futures, energy, metals, and treasury contracts (adapter in development).",
        icon: "📊",
      },
      commodities: {
        eyebrow: "COMMODITY BENCHMARKS",
        title: "Commodities Screener · Planned",
        desc: "Screen physical commodity and spot contracts (adapter in development).",
        icon: "🛢️",
      },
      bonds: {
        eyebrow: "FIXED INCOME",
        title: "Bonds & Yields · Planned",
        desc: "Screen US Treasuries, corporate bonds, and yield curve spreads (adapter in development).",
        icon: "🏛️",
      },
    };

    const assetTabs: CapabilityTabItem[] = SCREENING_ASSET_CLASSES.filter((asset) => asset.id !== "stocks" && asset.id !== "options").map((asset) => {
      const info = descriptions[asset.id] || {
        eyebrow: "MARKET SCREENER",
        title: asset.label,
        desc: `Screen ${asset.label.toLowerCase()} across connected market data providers.`,
        icon: "🔍",
      };

      return {
        id: asset.id,
        label: asset.label,
        icon: info.icon,
        badge: asset.available ? (asset.id === "stocks" ? "LIVE" : undefined) : "PLANNED",
        badgeType: asset.available ? (asset.id === "stocks" ? "live" : "default") : "amber",
        tooltip: {
          eyebrow: info.eyebrow,
          title: info.title,
          description: info.desc,
        },
      };
    });

    // Issue #2783: the #2438 exclusion is removed — the Planned tabs
    // return to the primary bar with their PLANNED badges (nothing
    // hidden); the left-nav Planned menu links to the same views.
    return assetTabs;
  }, []);

  return (
    <PageSection>
      <CapabilityNavBar
        ariaLabel="Instrument class capabilities"
        tabs={screenerTabs}
        activeTabId={hubTab}
        onTabChange={handleTabChange}
        rightContent={
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            {/* Issue #2438: the header shows the selected run's identity
                or nothing — never manual-run leftovers ("Last scan" /
                "N matched" described a manual run the user may never
                have made, above autonomous content). */}
          </div>
        }
      />

      {/* Tabbed Browsing Panels — reference multi-tab state retention:
          Panels mount on first visit and stay preserved in the DOM with role="tabpanel",
          id, and aria-labelledby linking back to their corresponding tab button. */}

      {/* 5. Multi-Asset Planned Panels (forex, futures, commodities, bonds) */}
      {(["forex", "futures", "commodities", "bonds"] as const).map((asset) =>
        visitedTabs.has(asset) ? (
          <div
            key={asset}
            role="tabpanel"
            id={`screener-tabpanel-${asset}`}
            aria-labelledby={`cap-tab-${asset}`}
            hidden={hubTab !== asset}
            style={hubTab !== asset ? { display: "none" } : undefined}
          >
            <Notice tone="info" title={`${SCREENING_ASSET_CLASSES.find((a) => a.id === asset)?.label || "Asset"} Screener · Planned`}>
              This instrument class is a planned extension point. Multi-asset provider adapters are currently in development.
            </Notice>
          </div>
        ) : null
      )}

      <p className="ui-meta">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </PageSection>
  );
}
