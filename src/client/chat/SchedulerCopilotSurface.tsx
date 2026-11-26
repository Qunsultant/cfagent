import { useCallback, useEffect, useState } from "react";
import type { PendingScheduleApproval } from "../../services/agentScheduleCapability";
import {
  decideGoalScheduleApproval,
  decideScheduleApproval,
  listPendingGoalScheduleApprovals,
  listPendingScheduleApprovals,
} from "../jobsApi";
import { useBrokerEnvironment } from "../brokerEnvironment";
import { SchedulesPanel } from "../SchedulesPanel";
import { ScheduledGoalsPanel } from "../ScheduledGoalsPanel";
import { ScheduleRunLedgerPanel } from "../ScheduleRunLedgerPanel";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Flex,
  Notice,
  Spinner,
  TabPanel,
  Tabs,
  type TabOption,
} from "../components/ui";

type SchedulerView = "schedules" | "goals" | "runs" | "approvals";
type ApprovalDecision = "approve" | "reject";
type ApprovalItem = {
  approval: PendingScheduleApproval;
  source: "schedule" | "goal";
};

const SCHEDULER_VIEWS: TabOption<SchedulerView>[] = [
  { id: "schedules", label: "Schedules" },
  { id: "goals", label: "Goals" },
  { id: "runs", label: "Run history" },
  { id: "approvals", label: "Approvals" },
];

export function SchedulerCopilotSurface({ userLogin }: { userLogin: string }) {
  const [activeView, setActiveView] = useState<SchedulerView>("schedules");
  const activeEnv = useBrokerEnvironment();

  return (
    <div data-testid="scheduler-copilot-surface">
      <Card>
        <CardHeader
          title="Scheduler"
          meta={<span className="ui-meta-sm">Schedules, run outcomes, and pending approvals</span>}
        />
        <Tabs<SchedulerView>
          idBase="scheduler-copilot"
          ariaLabel="Scheduler views"
          tabs={SCHEDULER_VIEWS}
          value={activeView}
          onChange={setActiveView}
          size="sm"
        />
        <TabPanel idBase="scheduler-copilot" tabId="schedules" active={activeView === "schedules"}>
          <SchedulesPanel activeEnv={activeEnv} userLogin={userLogin} />
        </TabPanel>
        <TabPanel idBase="scheduler-copilot" tabId="goals" active={activeView === "goals"}>
          <ScheduledGoalsPanel embedded />
        </TabPanel>
        <TabPanel idBase="scheduler-copilot" tabId="runs" active={activeView === "runs"}>
          <ScheduleRunLedgerPanel />
        </TabPanel>
        <TabPanel idBase="scheduler-copilot" tabId="approvals" active={activeView === "approvals"}>
          <ScheduleApprovalsPanel userLogin={userLogin} />
        </TabPanel>
      </Card>
    </div>
  );
}

function ScheduleApprovalsPanel({ userLogin }: { userLogin: string }) {
  const [scheduleApprovals, setScheduleApprovals] = useState<PendingScheduleApproval[]>([]);
  const [goalApprovals, setGoalApprovals] = useState<PendingScheduleApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schedules, goals] = await Promise.all([
        listPendingScheduleApprovals(userLogin),
        listPendingGoalScheduleApprovals(),
      ]);
      setScheduleApprovals(schedules);
      setGoalApprovals(goals);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pending approvals could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [userLogin]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = async (item: ApprovalItem, decision: ApprovalDecision) => {
    setBusyId(item.approval.id);
    setError(null);
    try {
      if (item.source === "goal") {
        await decideGoalScheduleApproval(item.approval.id, decision);
      } else {
        await decideScheduleApproval(item.approval.id, decision, userLogin);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The approval decision failed.");
    } finally {
      setBusyId(null);
    }
  };

  const items: ApprovalItem[] = [
    ...scheduleApprovals.map((approval) => ({ approval, source: "schedule" as const })),
    ...goalApprovals.map((approval) => ({ approval, source: "goal" as const })),
  ];

  if (loading) {
    return <Spinner label="Loading pending schedule approvals" />;
  }

  return (
    <section aria-label="Pending schedule approvals">
      <CardHeader
        title="Pending approvals"
        meta={<Badge tone={items.length > 0 ? "warning" : "neutral"}>{items.length}</Badge>}
      />
      {error && <Notice tone="danger" title="Approvals">{error}</Notice>}
      {items.length === 0 ? (
        <EmptyState
          title="No pending approvals"
          description="Consequential agent schedule requests appear here before they can be armed."
        />
      ) : (
        <div>
          {items.map((item) => {
            const { approval } = item;
            const busy = busyId === approval.id;
            return (
              <Card key={`${item.source}:${approval.id}`} padding="sm">
                <CardHeader
                  title={`${approval.kind} schedule`}
                  meta={<Badge tone="info">{item.source === "goal" ? "Goal" : "Schedule"}</Badge>}
                />
                <p>
                  Requested by <strong>{approval.requestedBy}</strong> via agent{" "}
                  <strong>{approval.agentId}</strong> on{" "}
                  <time dateTime={approval.requestedAt}>
                    {new Date(approval.requestedAt).toLocaleString()}
                  </time>
                </p>
                <ul>
                  {approval.approvalReasons.map((reason, index) => (
                    <li key={`${approval.id}:reason:${index}`}>{reason}</li>
                  ))}
                </ul>
                <details>
                  <summary>Review schedule definition</summary>
                  <pre>{JSON.stringify(approval.definition, null, 2)}</pre>
                </details>
                <Flex gap="2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyId !== null}
                    loading={busy}
                    onClick={() => void decide(item, "approve")}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => void decide(item, "reject")}
                  >
                    Reject
                  </Button>
                </Flex>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
