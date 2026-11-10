/**
 * Issue #3121 Slice S2 — the consolidated schedules home.
 *
 * The ONE schedules surface (`?tab=schedules`, inventory §8.3): it
 * renders directly from the shell (`Chat.tsx` `TAB_CONTENT`), NOT
 * through the retained `ETradeTradingHub` — a broker-neutral home
 * cannot live inside a broker hub (#3216). Its views are the
 * sub-route scheme in `schedulesHome.ts`:
 * list (SchedulesPanel incl. ScheduledOptionsManager), runs/ledger
 * (ScheduleRunLedgerPanel over the S1 ledger), goals
 * (ScheduledGoalsPanel — S3: goal schedules on the S1 primitives,
 * provenance + consolidated-ledger runs, no second read path), queue
 * (ScheduleQueueView — platform-admin gated at the route).
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
 * the de-hubbed home's preview navigates to the order tab without the
 * candidate. The button still works as navigation; restoring the
 * prefill without re-hosting the home in the hub is #3361's slice.
 */
import { useEffect, useState } from "react";
import { Card, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { SchedulesPanel } from "./SchedulesPanel";
import { ScheduledGoalsPanel } from "./ScheduledGoalsPanel";
import { ScheduleRunLedgerPanel } from "./ScheduleRunLedgerPanel";
import { ScheduleQueueView } from "./ScheduleQueueView";
import { useBrokerEnvironment } from "./brokerEnvironment";
import { navigateToTab, subscribeToRouteChanges } from "./router";
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
}

export function SchedulesHome({ userLogin }: SchedulesHomeProps = {}) {
  const activeEnv = useBrokerEnvironment();
  const [deepLink, setDeepLink] = useState<SchedulesDeepLink>(() =>
    typeof window !== "undefined"
      ? parseSchedulesDeepLink(window.location.search)
      : { view: "list", scheduleId: null, runId: null },
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
      scopeNote="The one scheduling surface — schedules, goal schedules, the consolidated run ledger, and the admin queue"
    >
      <div className="schedules-home-tabs-wrapper">
        <Tabs<SchedulesHomeView>
          idBase="schedules-home"
          ariaLabel="Schedules views"
          tabs={SCHEDULES_HOME_TABS}
          value={deepLink.view}
          onChange={handleSelectView}
        />
      </div>

      <TabPanel idBase="schedules-home" tabId="list" active={deepLink.view === "list"}>
        <Card padding="md">
          <SchedulesPanel
            activeEnv={activeEnv}
            userLogin={userLogin}
            onPreviewTrade={() => navigateToTab("order")}
            focusScheduleId={deepLink.scheduleId}
          />
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="runs" active={deepLink.view === "runs"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Run ledger</span>
            <small>Every run with its schedule, async-job, and workflow linkage</small>
          </div>
          <ScheduleRunLedgerPanel scheduleId={deepLink.scheduleId} runId={deepLink.runId} />
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="goals" active={deepLink.view === "goals"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Goal schedules</span>
            <small>ScheduledAgent goals, ticks &amp; add-goal form</small>
          </div>
          <ScheduledGoalsPanel embedded />
        </Card>
      </TabPanel>

      <TabPanel idBase="schedules-home" tabId="queue" active={deepLink.view === "queue"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Queue</span>
            <small>Admin queue — dump, cancel-all, wipe, and Track 1 recreate</small>
          </div>
          <ScheduleQueueView />
        </Card>
      </TabPanel>
    </PageShell>
  );
}
