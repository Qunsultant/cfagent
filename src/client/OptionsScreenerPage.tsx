/**
 * Issue #2596 (Options Screener product programme, slice 1): the
 * Options Screener's own page.
 *
 * This page aggregates, it does not duplicate: every card links to
 * the existing surface that hosts the sub-product (the options hub,
 * the flows tab, Docs, Workflow Runs, or Schedules). No panel is
 * re-implemented here. Sub-products with no tab of their own
 * (strategy panel, best-trade, compare, LLM ideas/evaluate,
 * discovery, IV history as a hub section) link to the tab that
 * hosts them; deep-linking into a hub section is a later slice,
 * and each card says so instead of pretending otherwise.
 *
 * Built only from src/client/components/ui primitives, token
 * styling only (the grid layout uses the page-shell section flow
 * and Card padding; no new icon system, no ad-hoc colours).
 */
import React from "react";
import {
  Badge,
  Button,
  Card,
  Notice,
  PageSection,
  PageShell,
} from "./components/ui";
import type { NavTabId } from "./components/NavigationMenu";
import { isOptionsProductEnabled } from "./featureFlags";
import {
  useTenantProviders,
  DATA_PROVIDER_OPTIONS,
  BROKER_OPTIONS,
  brokerUnavailableNotice,
} from "./tenantProviders";

export interface OptionsScreenerProduct {
  id: string;
  label: string;
  flag: string;
  hostTab: NavTabId;
  hostNote: string;
  description: string;
}

export const OPTIONS_SCREENER_PRODUCTS: OptionsScreenerProduct[] = [
  {
    id: "contract-screen",
    label: "Contract Screen",
    flag: "options_contract_screen",
    hostTab: "options",
    hostNote: "Opens the options hub (contract screen section).",
    description: "Raw options contracts screener over live chains.",
  },
  {
    id: "strategy-panel",
    label: "Strategy Panel",
    flag: "options_strategy_panel",
    hostTab: "options",
    hostNote: "Opens the options hub (strategy research section).",
    description: "Strategy discovery and ranking for a symbol or universe.",
  },
  {
    id: "best-trade",
    label: "Best Trade",
    flag: "options_best_trade",
    hostTab: "options",
    hostNote: "Opens the options hub (best-trade section).",
    description: "The single best trade for a name, plus alternatives.",
  },
  {
    id: "compare",
    label: "Compare",
    flag: "options_compare",
    hostTab: "options",
    hostNote: "Opens the options hub (comparison section).",
    description: "Side-by-side comparison of candidate strategies.",
  },
  {
    id: "llm-ideas",
    label: "LLM Ideas",
    flag: "options_llm_ideas",
    hostTab: "options",
    hostNote: "Opens the options hub (LLM ideas section).",
    description: "LLM evaluation of quantitative candidates.",
  },
  {
    id: "llm-evaluate",
    label: "LLM Evaluate",
    flag: "options_llm_evaluate",
    hostTab: "options",
    hostNote:
      "Opens the options hub; the evaluate modal itself is also gated by this flag.",
    description: "LLM evaluation of one chosen strategy, from the research panel.",
  },
  {
    id: "discovery",
    label: "Discovery",
    flag: "options_discovery",
    hostTab: "options",
    hostNote: "Opens the options hub (discovery runs section).",
    description: "Scheduled and manual discovery runs and their reports.",
  },
  {
    id: "scheduled",
    label: "Scheduled Runs",
    flag: "options_scheduled",
    hostTab: "schedules",
    hostNote: "Opens Schedules (options section).",
    description: "Scheduled options runs, their schedules, and latest runs.",
  },
  {
    id: "flows",
    label: "Options Flows",
    flag: "options_flows",
    hostTab: "options-flows",
    hostNote: "Opens the Options Flows tab.",
    description: "Institutional block trades, sweeps, and dark pool prints.",
  },
  {
    id: "iv-history",
    label: "IV History",
    flag: "options_iv_history",
    hostTab: "screeners",
    hostNote:
      "Opens the Screeners hub; IV History is a hub section — deep-linking into it is a later slice.",
    description: "Historical and implied volatility percentile ranks.",
  },
];

export interface OptionsScreenerPageProps {
  onSelectTab: (tab: NavTabId) => void;
}

export function OptionsScreenerPage({ onSelectTab }: OptionsScreenerPageProps) {
  // Provider/broker slice 2 (#2598): panel provenance — the page shows
  // the tenant's server-resolved selections (slice 1's module; no second
  // selector here) so a run's feed and broker surface are never a
  // surprise. Capability enforcement stays server-side: the feed gate
  // returns the coded FAILURE_DATA_PROVIDER_UNAVAILABLE response for a
  // non-chain provider, and the broker notice below mirrors slice 1's
  // AccountPanels / trading-hub notice for a non-etrade broker.
  const [tenantProviders] = useTenantProviders();
  const dataProviderLabel =
    DATA_PROVIDER_OPTIONS.find((o) => o.id === tenantProviders.dataProviderId)?.label ??
    tenantProviders.dataProviderId;
  const brokerLabel =
    BROKER_OPTIONS.find((o) => o.id === tenantProviders.brokerId)?.label ?? tenantProviders.brokerId;
  return (
    <PageShell
      title="Options Screener"
      scopeNote="Every options sub-product in one place. Each card links to the existing surface that hosts it — nothing here is a second copy."
    >
      <PageSection
        title="Provider selection"
        description="The data provider feeding these surfaces and the broker whose surfaces render, from Settings. Changing a selection writes the server row; this page only displays it."
      >
        <Card padding="md">
          <p>
            Data provider: {dataProviderLabel} · Broker: {brokerLabel}
          </p>
          {tenantProviders.brokerId !== "etrade" && (
            <Notice tone="warning" title="[FAILURE_BROKER_UNAVAILABLE] Broker surface unavailable">
              {brokerUnavailableNotice(tenantProviders.brokerId, brokerLabel)}
            </Notice>
          )}
        </Card>
      </PageSection>
      <PageSection
        title="Sub-products"
        description="A disabled sub-product shows OFF and its button is disabled; its server route also returns 404 FEATURE_DISABLED. An absent flag inherits the parent options flag, so nothing here is silently disabled by this page."
      >
        {OPTIONS_SCREENER_PRODUCTS.map((product) => {
          const enabled = isOptionsProductEnabled(product.flag);
          return (
            <Card key={product.id} padding="md">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2, 0.5rem)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2, 0.5rem)",
                  }}
                >
                  <strong>{product.label}</strong>
                  <Badge tone={enabled ? "success" : "neutral"} size="sm">
                    {enabled ? "ON" : "OFF"}
                  </Badge>
                  <Badge tone="neutral" size="sm">
                    Flag: {product.flag}
                  </Badge>
                </div>
                <p style={{ margin: 0 }}>{product.description}</p>
                <p style={{ margin: 0 }}>{product.hostNote}</p>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!enabled}
                    onClick={() => onSelectTab(product.hostTab)}
                    title={
                      enabled
                        ? `Open ${product.label}`
                        : `${product.label} is disabled by feature flag ${product.flag}`
                    }
                  >
                    {enabled ? "Open" : "Disabled"}
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </PageSection>

      <PageSection
        title="Related surfaces"
        description="The run record, schedules, and settings that every options run shares."
      >
        <Card padding="md">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 0.5rem)",
            }}
          >
            <strong>Reports &amp; Docs</strong>
            <p style={{ margin: 0 }}>
              Generated options reports and the unified run record with Run Details.
            </p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => onSelectTab("docs")}>
                Open Docs
              </Button>
            </div>
          </div>
        </Card>
        <Card padding="md">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 0.5rem)",
            }}
          >
            <strong>Workflow Runs</strong>
            <p style={{ margin: 0 }}>
              Every recorded workflow run with its stages, inputs, outputs, and artifacts.
            </p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => onSelectTab("workflow-runs")}>
                Open Workflow Runs
              </Button>
            </div>
          </div>
        </Card>
        <Card padding="md">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 0.5rem)",
            }}
          >
            <strong>Schedules</strong>
            <p style={{ margin: 0 }}>
              The one scheduling surface for screening runs, including options schedules.
            </p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => onSelectTab("schedules")}>
                Open Schedules
              </Button>
            </div>
          </div>
        </Card>
        <Card padding="md">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 0.5rem)",
            }}
          >
            <strong>Settings</strong>
            <Notice tone="neutral">
              Options settings live in the header Settings menu. Per-product
              settings sections are later programme slices; this page only
              provides the navigation shell, as specified for slice 1.
            </Notice>
          </div>
        </Card>
      </PageSection>
    </PageShell>
  );
}
