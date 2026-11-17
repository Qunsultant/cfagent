/**
 * Issue #5169 — the Observability home.
 *
 * The ONE observability surface (`?tab=observability`): it
 * renders directly from the shell (`Chat.tsx` `TAB_CONTENT`).
 * Its views are the sub-route scheme in `observabilityView.ts`:
 * archive (OtelArchivePanel) — the R2 archive file browser,
 * the interim view until the S8 dashboard (#5087) lands.
 *
 * View state follows the URL (`?view=`), the same pattern as
 * PlatformAdminPage, SchedulesHome, and SecurityHubHome: the
 * component re-reads the URL on every route change, and a tab
 * click navigates through `navigateToTab`, so back/forward,
 * bookmarks, and reloads all land on the same view. Inactive
 * views unmount (TabPanel default).
 */
import { useEffect, useState } from "react";
import { Card, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { OtelArchivePanel } from "./OtelArchivePanel";
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
      : { view: "archive" },
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
    </PageShell>
  );
}
