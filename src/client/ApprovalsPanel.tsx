/**
 * Issue #1705 (A3-c, finding 1, incremental step only): one top-level
 * Approvals surface composing the existing approval queues — no queue
 * capability is removed or reimplemented here. Trade drafts live in
 * TradingApprovalsQueue (#1327); held deliveries live in
 * PendingReviewQueue (#1324). Each queue keeps its own loading,
 * decision, and refresh behavior; this surface only composes them so
 * every consequential action awaiting a decision is findable in one
 * place. Schedule and social approvals have no listable
 * pending-decision endpoint, so there is nothing to compose for them
 * yet — the scope note below says so rather than implying a third
 * queue exists. A full goal-oriented workspace redesign is explicitly
 * out of scope (needs Ceos's program decision).
 *
 * @deprecated superseded by the order approvals sub-tab
 * (`?tab=order&orderTab=approvals`, src/client/OrderTicketPanel.tsx,
 * issue #4626), which renders the same queues. This file is kept,
 * unmounted, per the no-deletion rule (Policy Gate check (i)); do not
 * re-mount it.
 *
 * UX token architecture compliance is mandatory with no exemptions
 * (ADR-0004): the panel's own chrome is the PageShell primitive, and every
 * control on the surface comes from the primitive-built queues.
 */
import { PageShell, PageSection } from "./components/ui";
import { TradingApprovalsQueue } from "./TradingApprovalsQueue";
import { PendingReviewQueue } from "./PendingReviewQueue";

export function ApprovalsPanel() {
  return (
    <PageShell
      title="Approvals"
      scopeNote="Every consequential action awaiting your decision, in one place. Trade drafts and held deliveries are the two decidable queues with listable pending items today; each queue below keeps its own loading, decision, and refresh behavior — this surface only composes them."
    >
      <PageSection title="Trade approvals">
        <TradingApprovalsQueue />
      </PageSection>
      <PageSection title="Held deliveries">
        <PendingReviewQueue />
      </PageSection>
    </PageShell>
  );
}
