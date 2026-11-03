/**
 * Issue 2973 (nav re-org slice 5): the Platform Queues page.
 *
 * Composes the existing queue surfaces, reusing their behavior:
 * async jobs (AsyncJobsPanel, embedded), the dead-letter queue
 * (DlqPanel), and trade approvals (TradingApprovalsQueue). Each
 * queue keeps its own loading, decision, and refresh behavior —
 * this page only composes them. Pending review is deliberately
 * NOT composed here: it stays on the Review page.
 * Built only from src/client/components/ui/ primitives.
 */
import { PageShell, PageSection } from "./components/ui";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import { DlqPanel } from "./DlqPanel";
import { TradingApprovalsQueue } from "./TradingApprovalsQueue";

export function QueuesPage() {
  return (
    <div className="queues-page">
      <PageShell
        title="Queues"
        scopeNote="Every queue with work waiting, in one place. Async jobs, the dead-letter queue, and trade approvals each keep their own loading, decision, and refresh behavior — this page only composes them. Pending review stays on the Review page."
      >
        <PageSection title="Async jobs">
          <AsyncJobsPanel embedded />
        </PageSection>
        <PageSection title="Dead-letter queue">
          <DlqPanel />
        </PageSection>
        <PageSection title="Trade approvals">
          <TradingApprovalsQueue />
        </PageSection>
      </PageShell>
    </div>
  );
}
