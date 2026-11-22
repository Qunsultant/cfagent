/**
 * Issue #5169 — the Observability home.
 *
 * The ONE observability surface (`?tab=observability`): it
 * renders directly from the shell (`Chat.tsx` `TAB_CONTENT`).
 * Its views are the sub-route scheme in `observabilityView.ts`:
 * archive (OtelArchivePanel) — the R2 archive file browser,
 * the interim view until the S8 dashboard (#5087) lands — and
 * config (OtelConfigPanel, S7 #5086) — the message catalog +
 * runtime config port — and slo (SloPanel, S5 #5425) — the two
 * #3515 SLOs (uptime, P95 API latency) as health states against
 * the tenant's configured thresholds.
 *
 * View state follows the URL (`?view=`), the same pattern as
 * PlatformAdminPage, SchedulesHome, and SecurityHubHome: the
 * component re-reads the URL on every route change, and a tab
 * click navigates through `navigateToTab`, so back/forward,
 * bookmarks, and reloads all land on the same view. Inactive
 * views unmount (TabPanel default).
 */
import { useEffect, useState } from "react";
import { Card, CardHeader, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { OtelArchivePanel } from "./OtelArchivePanel";
import { OtelConfigPanel } from "./OtelConfigPanel";
import { SloPanel } from "./SloPanel";
import { navigateToTab, subscribeToRouteChanges } from "./router";
import {
  OBSERVABILITY_VIEW_LABELS,
  OBSERVABILITY_VIEWS,
  parseObservabilityDeepLink,
  type ObservabilityDeepLink,
  type ObservabilityView,
} from "./observabilityView";

const OBSERVABILITY_TABS: TabOption<ObservabilityView>[] = OBSERVABILITY_VIEWS.map((id) => ({
  id,
  label: OBSERVABILITY_VIEW_LABELS[id],
}));

export function ObservabilityHome() {
  const [deepLink, setDeepLink] = useState<ObservabilityDeepLink>(() =>
    typeof window !== "undefined"
      ? parseObservabilityDeepLink(window.location.search)
      : { view: "archive", tenantId: "primary" },
  );

  useEffect(() => {
    return subscribeToRouteChanges(() => {
      if (typeof window !== "undefined") {
        setDeepLink(parseObservabilityDeepLink(window.location.search));
      }
    });
  }, []);

  const handleSelectView = (nextView: ObservabilityView) => {
    navigateToTab("observability", nextView);
  };

  return (
    <PageShell
      title="Observability"
      scopeNote="The archived OTel telemetry — raw OTLP JSONL in R2, listed by date"
    >
      <div className="observability-tabs-wrapper">
        <Tabs<ObservabilityView>
          idBase="observability"
          ariaLabel="Observability views"
          tabs={OBSERVABILITY_TABS}
          value={deepLink.view}
          onChange={handleSelectView}
        />
      </div>

      <TabPanel idBase="observability" tabId="archive" active={deepLink.view === "archive"}>
        <Card>
          <div className="section-label-row">
            <span>Archive</span>
            <small>Archived OTLP objects in R2, by date</small>
          </div>
          <OtelArchivePanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="observability" tabId="config" active={deepLink.view === "config"}>
        <Card>
          <div className="section-label-row">
            <span>Config</span>
            <small>Message catalog + runtime config — no redeploy</small>
          </div>
          <OtelConfigPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="observability" tabId="slo" active={deepLink.view === "slo"}>
        <Card>
          <CardHeader
            title="SLOs"
            subtitle="Uptime + P95 API latency vs the tenant's thresholds"
          />
          <SloPanel tenantId={deepLink.tenantId} />
        </Card>
      </TabPanel>
    </PageShell>
  );
}
