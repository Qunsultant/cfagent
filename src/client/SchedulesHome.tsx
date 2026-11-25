/**
 * Issue #3121 Slice S2 — the consolidated schedules home.
 *
 * The ONE schedules surface (`?tab=schedules`, inventory §8.3): it
 * renders directly from the shell (`Chat.tsx` `TAB_CONTENT`), NOT
 * through the retained `TradeHub` — a broker-neutral home
 * cannot live inside a broker hub (#3216). Its views are the
 * sub-route scheme in `schedulesHome.ts`:
 * list (SchedulesPanel incl. ScheduledOptionsManager), runs/ledger
 * (ScheduleRunLedgerPanel over the S1 ledger), goals
 * (ScheduledGoalsPanel — S3: goal schedules on the S1 primitives,
 * provenance + consolidated-ledger runs, no second read path), queue
 * (ScheduleQueueView — platform-admin gated at the route),
 * background-tasks (AsyncJobsPanel — the async execution queue, moved
 * from Platform Admin in #4561; a separate tab from the queue view),
 * dead-letter-queue (DlqPanel — the dead-letter queue, moved from the
 * retired Queues page in #4574; the page's async-jobs copy is removed
 * as covered by Background Tasks), flags (ScheduleChannelFlagsPanel —
 * the scheduling-channel flags with live state, #4260, plus
 * ScheduleControlsPanel — the #6482 runaway controls: floor,
 * kill-switch, firing rate, armed inventory).
 *
 * View state follows the URL (`?view=`, plus `?schedule=` / `?run=`
 * deep links), the same pattern as PlatformAdminPage: the component
 * re-reads the URL on every route change, and a tab click navigates
 * through `navigateToTab`, so back/forward, bookmarks, and reloads
 * all land on the same view. Inactive views unmount (TabPanel
 * default), so the queue gate probe fires only when the queue view
 * is actually open.
 *
 * Preview-trade note (#3361, filed as a #3121 sub-issue during S2):
 * the hub owned the order-ticket prefill (hub-local order state), so
 * the de-hubbed home's preview navigated to the order tab without the
 * candidate. Restored by #3361: the preview converts the candidate to
 * a TradeOrderContext (candidateToTradeContext, the research panel's
 * mapping) and hands it to the shell via the onPreviewTrade prop; the
 * shell owns the pending context (Chat pendingOrderContext, the
 * pendingPrompt idiom) and the hub consumes it through its own order
 * handler. The home stays broker-neutral and de-hubbed.
 */
import { useEffect, useState } from "react";
import { Card, CardHeader, PageSection, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { SchedulesPanel } from "./SchedulesPanel";
import { ScheduledGoalsPanel } from "./ScheduledGoalsPanel";
import { ScheduleRunLedgerPanel } from "./ScheduleRunLedgerPanel";
import { ScheduleChannelFlagsPanel } from "./ScheduleChannelFlagsPanel";
import { ScheduleControlsPanel } from "./ScheduleControlsPanel";
import { ScheduleQueueView } from "./ScheduleQueueView";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import { DlqPanel } from "./DlqPanel";
import { useBrokerEnvironment } from "./brokerEnvironment";
import { navigateToTab, subscribeToRouteChanges } from "./router";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import { resolveRunLedgerDefaultFilter } from "../config/runLedgerModes";
import {
  SCHEDULES_HOME_VIEW_LABELS,
  SCHEDULES_HOME_VIEWS,
  parseSchedulesDeepLink,
  type SchedulesDeepLink,
  type SchedulesHomeView,
} from "./schedulesHomeView";

const SCHEDULES_HOME_TABS: TabOption<SchedulesHomeView>[] = SCHEDULES_HOME_VIEWS.map(
  (id) => ({ id, label: SCHEDULES_HOME_VIEW_LABELS[id] }),
);

export interface SchedulesHomeProps {
  userLogin?: string;
  /**
   * Issue #3361: the shell's preview-trade handoff — the converted
   * TradeOrderContext is handed to the shell, which seeds the order
   * ticket (pendingOrderContext) and navigates to the order tab.
   * Absent, the preview navigates bare (the pre-S2-de-hub behavior).
   */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}

export function SchedulesHome({ userLogin, onPreviewTrade }: SchedulesHomeProps = {}) {
  const activeEnv = useBrokerEnvironment();
  const [deepLink, setDeepLink] = useState<SchedulesDeepLink>(() =>
    typeof window !== "undefined"
      ? parseSchedulesDeepLink(window.location.search)
      : { view: "list", scheduleId: null, runId: null, kind: resolveRunLedgerDefaultFilter() },
  );

  useEffect(() => {
    return subscribeToRouteChanges(() => {
      if (typeof window !== "undefined") {
        setDeepLink(parseSchedulesDeepLink(window.location.search));
      }
    });
  }, []);

  const handleSelectView = (nextView: SchedulesHomeView) => {
    navigateToTab("schedules", nextView);
  };

  return (
    <PageShell
      title="Schedules"
      scopeNote="The one scheduling surface — schedules, goal schedules, the consolidated run ledger, the admin queue, background tasks, and the dead-letter queue"
    >
      <PageSection>
        <Tabs<SchedulesHomeView>
          idBase="schedules-home"
          ariaLabel="Schedules views"
          tabs={SCHEDULES_HOME_TABS}
          value={deepLink.view}
          onChange={handleSelectView}
        />
      </PageSection>

      <TabPanel idBase="schedules-home" tabId="list" active={deepLink.view === "list"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <SchedulesPanel
            activeEnv={activeEnv}
            userLogin={userLogin}
            onPreviewTrade={
              onPreviewTrade ?? (() => navigateToTab("order"))
            }
            focusScheduleId={deepLink.scheduleId}
          />
        </div>
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="runs" active={deepLink.view === "runs"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <CardHeader
            title="Run ledger"
            meta={<span className="ui-meta-sm">Every run with its schedule, async-job, and workflow linkage</span>}
          />
          <ScheduleRunLedgerPanel
            scheduleId={deepLink.scheduleId}
            runId={deepLink.runId}
            kind={deepLink.kind}
          />
        </div>
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="goals" active={deepLink.view === "goals"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <CardHeader
            title="Goal schedules"
            meta={<span className="ui-meta-sm">ScheduledAgent goals, ticks &amp; add-goal form</span>}
          />
          <ScheduledGoalsPanel embedded />
        </div>
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="queue" active={deepLink.view === "queue"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <CardHeader
            title="Queue"
            meta={<span className="ui-meta-sm">Admin queue — dump, cancel-all, wipe, and Track 1 recreate</span>}
          />
          <ScheduleQueueView />
        </div>
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="background-tasks" active={deepLink.view === "background-tasks"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <CardHeader
            title="Background Tasks"
            meta={<span className="ui-meta-sm">Async jobs &amp; execution queue</span>}
          />
          <AsyncJobsPanel embedded />
        </div>
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="dead-letter-queue" active={deepLink.view === "dead-letter-queue"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <CardHeader
            title="Dead-letter queue"
            meta={<span className="ui-meta-sm">Unreplayed records — replay to the source queue</span>}
          />
          <DlqPanel />
        </div>
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="flags" active={deepLink.view === "flags"}>
        <Card>
          {/* Issue #4330 — the tab scrolls on both axes; the shell clips otherwise. */}
          <div className="ui-scroll-frame">
          <ScheduleChannelFlagsPanel />
          {/* Issue #6482 — the runaway controls (floor, firing
              kill-switch, armed inventory) live in the same flags
              section: the floor and the kill-switch are managed here,
              not in a dashboard. */}
          <ScheduleControlsPanel />
        </div>
        </Card>
      </TabPanel>
    </PageShell>
  );
}
