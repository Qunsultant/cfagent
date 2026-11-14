/**
 * Issue 2973 (nav re-org slice 5): the Platform Queues page.
 *
 * Composes the existing queue surfaces, reusing their behavior:
 * async jobs (AsyncJobsPanel, embedded) and the dead-letter queue
 * (DlqPanel). Each queue keeps its own loading, decision, and refresh
 * behavior — this page only composes them. Trade approvals live on
 * the Approvals page (?tab=approvals), linked from the Trade
 * approvals section below (#4538 moved the queue there — the
 * Approvals page is its one canonical home). Pending review is
 * deliberately NOT composed here: it stays on the Review page.
 * Built only from src/client/components/ui/ primitives.
 */
import { PageShell, PageSection } from "./components/ui";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import { DlqPanel } from "./DlqPanel";

export function QueuesPage() {
  return (
    <div className="queues-page">
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
          <a href="?tab=approvals">Review trade approvals on the Approvals page</a>
        </PageSection>
      </PageShell>
    </div>
  );
}
