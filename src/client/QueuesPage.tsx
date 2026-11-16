/**
 * Issue 2973 (nav re-org slice 5): the Platform Queues page — RETIRED.
 *
 * @deprecated superseded by the Schedules home dead-letter-queue view
 * (`?tab=schedules&view=dead-letter-queue`, src/client/SchedulesHome.tsx,
 * issue #4574). The Queues page's async-jobs copy is covered by the
 * Schedules background-tasks view (same component, same props, same
 * endpoint); its trade-approvals link re-points to the approvals
 * sub-tab (`?tab=order&orderTab=approvals`), the one home per #4626
 * (which retired the standalone Approvals page #4538 built). This file is kept,
 * unmounted, per the no-deletion rule (Policy Gate check (i)); do not
 * re-mount it. Built only from src/client/components/ui/ primitives.
 */
import { PageShell, PageSection } from "./components/ui";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import { DlqPanel } from "./DlqPanel";

export function QueuesPage() {
  return (
    <PageShell
      title="Queues"
      scopeNote="Every queue with work waiting, in one place. Async jobs and the dead-letter queue each keep their own loading, decision, and refresh behavior — this page only composes them. Trade approvals live on the Approvals page. Pending review stays on the Review page."
    >
      <PageSection title="Async jobs">
        <AsyncJobsPanel embedded />
      </PageSection>
      <PageSection title="Dead-letter queue">
        <DlqPanel />
      </PageSection>
      <PageSection title="Trade approvals">
        <a href="?tab=order&orderTab=approvals">Review trade approvals in the approvals tab</a>
      </PageSection>
    </PageShell>
  );
}
