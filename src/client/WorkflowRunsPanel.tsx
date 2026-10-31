/**
 * Workflow Runs — the operational ledger of every workflow execution
 * the platform recorded: one row per run (a job chain, a standalone
 * job, or an outcome with no job twin), and one expandable detail per
 * run showing what really happened.
 *
 * The page is deliberately a read surface. It fetches
 * `GET /api/workflow-runs` and renders only what the server recorded:
 *  - the trigger and the evidence for it ("Scheduled — recorded by
 *    job-tree"), or "Not recorded" when no store carries one;
 *  - every stage in execution order, its status, timing, the reason a
 *    skipped/held/failed stage ended that way, and whether the stage
 *    came from a job row or a recorded stage transition;
 *  - the normalized inputs/outputs the stage persisted, artifacts, and
 *    per-channel delivery states;
 *  - the run's first coded error, verbatim.
 *
 * Compliance (docs/agents/ux-architecture.md §20): ui/ primitives only,
 * semantic tokens only, server state is authoritative, and a field the
 * stores do not record renders as absent/not recorded — never invented.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./workflowRuns.css";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  Notice,
  PageSection,
  PageShell,
  PillGroup,
  Table,
  TextInput,
} from "./components/ui";
import type {
  WorkflowRun,
  WorkflowRunStage,
  WorkflowRunStatus,
  WorkflowRunTrigger,
} from "../services/workflowRuns";

interface WorkflowRunsResponse {
  count?: number;
  runs?: WorkflowRun[];
  summary?: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    active: number;
    byTrigger: Record<WorkflowRunTrigger, number>;
  };
  storeErrors?: Record<string, string>;
  generatedAt?: string;
  error?: string;
}

type TriggerFilter = "all" | WorkflowRunTrigger;
type StatusFilter = "all" | "completed" | "partial" | "failed" | "active";

const TRIGGER_LABEL: Record<WorkflowRunTrigger, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  autonomous: "Autonomous",
  webhook: "Webhook",
  agent: "Agent",
  unknown: "Not recorded",
};

const TRIGGER_TONE: Record<WorkflowRunTrigger, "neutral" | "info" | "purple" | "accent"> = {
  manual: "neutral",
  scheduled: "info",
  autonomous: "purple",
  webhook: "accent",
  agent: "accent",
  unknown: "neutral",
};

const TRIGGER_OPTIONS: Array<{ id: TriggerFilter; label: string }> = [
  { id: "all", label: "All triggers" },
  { id: "scheduled", label: "Scheduled" },
  { id: "manual", label: "Manual" },
  { id: "autonomous", label: "Autonomous" },
  { id: "webhook", label: "Webhook" },
  { id: "unknown", label: "Not recorded" },
];

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All statuses" },
  { id: "completed", label: "Completed" },
  { id: "partial", label: "Partial" },
  { id: "failed", label: "Failed" },
  { id: "active", label: "In flight" },
];

const STATUS_TONE: Record<WorkflowRunStatus, "success" | "warning" | "danger" | "info" | "neutral"> = {
  completed: "success",
  partial: "warning",
  awaiting: "warning",
  failed: "danger",
  running: "info",
  queued: "info",
  skipped: "neutral",
  unknown: "neutral",
};

const STAGE_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  completed: "success",
  partial: "warning",
  held: "warning",
  failed: "danger",
  running: "info",
  queued: "info",
  skipped: "neutral",
  unknown: "neutral",
};

function statusLabel(status: WorkflowRunStatus): string {
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "awaiting") return "Awaiting decision";
  if (status === "skipped") return "Skipped";
  return "Unknown";
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stageStatus(stage: WorkflowRunStage): string {
  return stage.status || "unknown";
}

function runMatchesQuery(run: WorkflowRun, query: string): boolean {
  if (!query) return true;
  const haystack = [
    run.title,
    run.runId,
    run.workflow,
    run.triggerDetail,
    run.error ?? "",
    ...run.stages.flatMap((stage) => [stage.stage, stage.label, stage.reason ?? "", stage.error ?? ""]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function runMatchesStatus(run: WorkflowRun, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return run.status === "running" || run.status === "queued" || run.status === "awaiting";
  return run.status === filter;
}

export function WorkflowRunsPanel() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [summary, setSummary] = useState<WorkflowRunsResponse["summary"] | null>(null);
  const [storeErrors, setStoreErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workflow-runs?limit=50");
      const data = (await res.json().catch(() => null)) as WorkflowRunsResponse | null;
      if (!res.ok) throw new Error(`Could not load workflow runs (HTTP ${res.status})${data?.error ? `: ${data.error}` : "."}`);
      setRuns(Array.isArray(data?.runs) ? data!.runs! : []);
      setSummary(data?.summary ?? null);
      setStoreErrors(data?.storeErrors ?? {});
      setLoadedAt(data?.generatedAt ?? new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load workflow runs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      runs.filter(
        (run) =>
          (triggerFilter === "all" || run.trigger === triggerFilter) &&
          runMatchesStatus(run, statusFilter) &&
          runMatchesQuery(run, query.trim()),
      ),
    [runs, triggerFilter, statusFilter, query],
  );

  const selected = useMemo(() => runs.find((run) => run.id === selectedId) ?? null, [runs, selectedId]);

  const columns = [
    {
      key: "started",
      header: "Started",
      render: (run: WorkflowRun) => (
        <div className="workflow-runs-when">
          <span>{formatTimestamp(run.startedAt)}</span>
          <span className="workflow-runs-muted">{run.finishedAt ? `Ended ${formatTimestamp(run.finishedAt)}` : "No end recorded"}</span>
        </div>
      ),
    },
    {
      key: "workflow",
      header: "Workflow",
      render: (run: WorkflowRun) => (
        <div className="workflow-runs-workflow">
          <span className="workflow-runs-title">{run.title}</span>
          <span className="workflow-runs-muted">
            {run.workflow} · <span className="workflow-runs-mono">{run.runId}</span>
          </span>
        </div>
      ),
    },
    {
      key: "trigger",
      header: "Trigger",
      render: (run: WorkflowRun) => (
        <div className="workflow-runs-trigger">
          <Badge tone={TRIGGER_TONE[run.trigger]} size="sm">
            {TRIGGER_LABEL[run.trigger]}
          </Badge>
          <span className="workflow-runs-muted">{run.triggerDetail}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (run: WorkflowRun) => (
        <Badge tone={STATUS_TONE[run.status]} size="sm" dot>
          {statusLabel(run.status)}
        </Badge>
      ),
    },
    {
      key: "duration",
      header: "Duration",
      align: "right" as const,
      render: (run: WorkflowRun) => <span className="workflow-runs-mono">{formatDuration(run.durationMs)}</span>,
    },
    {
      key: "stages",
      header: "Stages",
      render: (run: WorkflowRun) =>
        run.stageCount === 0 ? (
          <span className="workflow-runs-muted">No stages recorded</span>
        ) : (
          <div className="workflow-runs-stages-cell">
            <span>
              {run.completedStages}/{run.stageCount} completed
            </span>
            {run.failedStages > 0 && (
              <Badge tone="danger" size="xs">
                {run.failedStages} failed
              </Badge>
            )}
          </div>
        ),
    },
    {
      key: "result",
      header: "Result",
      render: (run: WorkflowRun) => {
        const outputs = (run.outputs ?? {}) as Record<string, any>;
        const outcome = outputs.outcome ?? {};
        const counts =
          typeof outcome.scanned === "number" || typeof outcome.matched === "number"
            ? `${outcome.matched ?? "—"} matched / ${outcome.scanned ?? "—"} scanned`
            : null;
        return (
          <div className="workflow-runs-result">
            {counts && <span>{counts}</span>}
            {run.artifacts.length > 0 && (
              <span className="workflow-runs-muted">
                {run.artifacts.length} artifact{run.artifacts.length === 1 ? "" : "s"}
              </span>
            )}
            {!counts && run.artifacts.length === 0 && <span className="workflow-runs-muted">—</span>}
          </div>
        );
      },
    },
    {
      key: "detail",
      header: "",
      render: (run: WorkflowRun) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSelectedId(run.id)}
          aria-haspopup="dialog"
          aria-label={`Details for ${run.title}`}
        >
          Details
        </Button>
      ),
    },
  ];

  const failedSources = Object.entries(storeErrors);

  return (
    <div className="workflow-runs-page">
      <PageShell
      title="Workflow Runs"
      scopeNote="Every run the workflow engine recorded — job chains (feed → generate → serve → deliver) and standalone screener, goal, and discovery outcomes. Each run shows its stages, inputs, outputs, failures, artifacts, and how it was triggered. Trade approvals and payments stay in their own ledgers (Approvals, Billing)."
      loading={loading && runs.length === 0}
      loadingLabel="Loading workflow runs"
    >
      {/* #2283 stream 3: the load error used to ride PageShell's error
          prop, which hides ALL children — including the Refresh button
          below. A failed load left no retry on the page. The error now
          renders inline with its own Retry, and Refresh stays visible. */}
      {error && (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-3)" }}>
          <Notice tone="danger">{error}</Notice>
          <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading} disabled={loading}>
            Retry
          </Button>
        </div>
      )}
      <PageSection
        title="Runs"
        description={
          loadedAt
            ? `Newest first · ${runs.length} run${runs.length === 1 ? "" : "s"} loaded · snapshot ${formatTimestamp(loadedAt)}`
            : "Newest first"
        }
      >
        <Card padding="md" className="workflow-runs-controls">
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Trigger</span>
            <PillGroup options={TRIGGER_OPTIONS} value={triggerFilter} onChange={setTriggerFilter} size="sm" ariaLabel="Filter runs by trigger" />
          </div>
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Status</span>
            <PillGroup options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} size="sm" ariaLabel="Filter runs by status" />
          </div>
          <div className="workflow-runs-filter workflow-runs-filter-grow">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search run id, workflow, stage, or error"
              aria-label="Search workflow runs"
              size="sm"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading} disabled={loading}>
            ↻ Refresh
          </Button>
        </Card>

        {summary && (
          <div className="workflow-runs-stats" aria-label="Run summary">
            {[
              { label: "Runs loaded", value: summary.total },
              { label: "Completed", value: summary.completed },
              { label: "Partial", value: summary.partial },
              { label: "Failed", value: summary.failed },
              { label: "In flight", value: summary.active },
              { label: "Scheduled", value: summary.byTrigger.scheduled },
              { label: "Manual", value: summary.byTrigger.manual },
              { label: "Autonomous", value: summary.byTrigger.autonomous },
            ].map((stat) => (
              <Card key={stat.label} padding="sm" className="workflow-runs-stat">
                <span className="workflow-runs-stat-value">{stat.value}</span>
                <span className="workflow-runs-stat-label">{stat.label}</span>
              </Card>
            ))}
          </div>
        )}

        {failedSources.length > 0 && (
          <Notice tone="warning" variant="strip" density="compact">
            Some stores could not be read — the rest of the ledger is unaffected:{" "}
            {failedSources.map(([name, message]) => `${name}: ${message}`).join(" · ")}
          </Notice>
        )}

        <Card padding="none" className="workflow-runs-table-card">
          <Table
            columns={columns}
            rows={filtered}
            rowKey={(run) => run.id}
            caption="Workflow runs, newest first"
            containerClassName="workflow-runs-table-container"
            empty={
              <EmptyState
                framed
                icon="🧭"
                title={runs.length === 0 ? "No workflow runs recorded yet" : "No runs match these filters"}
                description={
                  runs.length === 0
                    ? "Runs appear here as the engine records a screen, options scan, goal run, discovery, or delivery chain — with every stage it executed."
                    : "Clear the trigger, status, or search filters to see the recorded runs."
                }
                action={
                  runs.length > 0 ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setTriggerFilter("all");
                        setStatusFilter("all");
                        setQuery("");
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </Card>
      </PageSection>

      {selected && (
        <Modal
          open
          onClose={() => setSelectedId(null)}
          title="Workflow run detail"
          size="xl"
        >
          <RunDetail run={selected} />
        </Modal>
      )}
      </PageShell>
    </div>
  );
}

function RunDetail({ run }: { run: WorkflowRun }) {
  return (
    <div className="workflow-runs-detail">
      <div className="workflow-runs-detail-header">
        <div>
          <h3 className="workflow-runs-detail-title">{run.title}</h3>
          <div className="workflow-runs-detail-subtitle">
            <span>{run.workflow}</span>
            <span className="workflow-runs-mono">{run.runId}</span>
            <span className="workflow-runs-muted">{run.source === "job-chain" ? "Job tree" : run.stageCount > 0 ? "Unified run record" : "Outcome record only"}</span>
          </div>
        </div>
        <div className="workflow-runs-detail-actions">
          <Badge tone={TRIGGER_TONE[run.trigger]} size="sm">
            {TRIGGER_LABEL[run.trigger]}
          </Badge>
          <Badge tone={STATUS_TONE[run.status]} size="sm" dot>
            {statusLabel(run.status)}
          </Badge>
        </div>
      </div>

      {run.error && (
        <Notice tone="danger" density="compact" variant="strip" title="Recorded failure">
          {run.error}
        </Notice>
      )}

      <dl className="workflow-runs-facts">
        <div className="workflow-runs-fact">
          <dt>Trigger</dt>
          <dd>{run.triggerDetail}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Triggered by</dt>
          <dd>{run.triggeredBy || "Not recorded"}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Started</dt>
          <dd>{formatTimestamp(run.startedAt)}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Finished</dt>
          <dd>{formatTimestamp(run.finishedAt)}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Duration</dt>
          <dd>{formatDuration(run.durationMs)}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Stages</dt>
          <dd>
            {run.stageCount} recorded · {run.completedStages} completed
            {run.failedStages > 0 ? ` · ${run.failedStages} failed` : ""}
          </dd>
        </div>
      </dl>

      <h4 className="workflow-runs-subheading">Stages</h4>
      {run.stages.length === 0 ? (
        <Notice tone="neutral" density="compact">
          No stage records exist for this run — the producing store recorded only the run outcome. Stages are
          never inferred.
        </Notice>
      ) : (
        <div className="workflow-runs-stage-list">
          <Table
            columns={[
              {
                key: "order",
                header: "#",
                align: "right" as const,
                render: (stage: WorkflowRunStage) => <span className="workflow-runs-mono">{stage.order}</span>,
              },
              {
                key: "stage",
                header: "Stage",
                render: (stage: WorkflowRunStage) => (
                  <div className="workflow-runs-workflow">
                    <span className="workflow-runs-title">{stage.label}</span>
                    <span className="workflow-runs-muted">
                      {stage.stage}
                      {stage.capability ? ` · ${stage.capability}` : ""}
                      {stage.channel ? ` · ${stage.channel}` : ""}
                    </span>
                  </div>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (stage: WorkflowRunStage) => (
                  <Badge tone={STAGE_TONE[stageStatus(stage)] ?? "neutral"} size="sm">
                    {stageStatus(stage)}
                  </Badge>
                ),
              },
              {
                key: "recorded",
                header: "Recorded",
                render: (stage: WorkflowRunStage) => (
                  <span className="workflow-runs-muted">
                    {stage.recordedBy === "job" ? (stage.jobKind ? `${stage.jobKind} job` : "Job") : "Stage record"}
                  </span>
                ),
              },
              {
                key: "timing",
                header: "Started / duration",
                render: (stage: WorkflowRunStage) => (
                  <div className="workflow-runs-when">
                    <span>{formatTimestamp(stage.startedAt)}</span>
                    <span className="workflow-runs-muted">{formatDuration(stage.durationMs)}</span>
                  </div>
                ),
              },
              {
                key: "what",
                header: "What happened",
                render: (stage: WorkflowRunStage) => (
                  <div className="workflow-runs-what">
                    <span>{stage.detail || "No description recorded"}</span>
                    {stage.reason && <span className="workflow-runs-muted">Reason: {stage.reason}</span>}
                    {stage.error && (
                      <span className="workflow-runs-error">{stage.error}</span>
                    )}
                  </div>
                ),
              },
            ]}
            rows={run.stages}
            rowKey={(stage) => stage.key}
            caption="Stages in execution order"
          />
        </div>
      )}

      <div className="workflow-runs-io-grid">
        <section className="workflow-runs-io" aria-label="Run inputs">
          <h4 className="workflow-runs-subheading">Inputs</h4>
          <pre className="workflow-runs-pre">{formatJson(run.inputs)}</pre>
        </section>
        <section className="workflow-runs-io" aria-label="Run outputs">
          <h4 className="workflow-runs-subheading">Outputs</h4>
          <pre className="workflow-runs-pre">{formatJson(run.outputs)}</pre>
        </section>
      </div>

      <section className="workflow-runs-io" aria-label="Artifacts and delivery">
        <h4 className="workflow-runs-subheading">Artifacts & delivery</h4>
        {run.artifacts.length === 0 && Object.keys(run.deliveryStates).length === 0 ? (
          <p className="workflow-runs-muted">No artifacts or delivery states recorded for this run.</p>
        ) : (
          <div className="workflow-runs-artifacts">
            {run.artifacts.map((artifact) => (
              <a key={`${artifact.kind}:${artifact.url}`} href={artifact.url} target="_blank" rel="noreferrer">
                {artifact.label}
              </a>
            ))}
            {Object.entries(run.deliveryStates).map(([channel, state]) => (
              <Badge key={channel} tone={state === "sent" ? "success" : state === "failed" ? "danger" : "neutral"} size="sm">
                {channel}: {state}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {run.stages.some((stage) => stage.input !== null || stage.output !== null) && (
        <section className="workflow-runs-stage-io" aria-label="Per-stage inputs and outputs">
          <h4 className="workflow-runs-subheading">Per-stage inputs & outputs</h4>
          {run.stages
            .filter((stage) => stage.input !== null || stage.output !== null)
            .map((stage) => (
              <details key={stage.key} className="workflow-runs-stage-details">
                <summary>
                  {stage.order}. {stage.label} — {stageStatus(stage)}
                </summary>
                <div className="workflow-runs-io-grid">
                  <section className="workflow-runs-io" aria-label={`${stage.label} inputs`}>
                    <h5 className="workflow-runs-subheading-sm">Inputs</h5>
                    <pre className="workflow-runs-pre">{formatJson(stage.input)}</pre>
                  </section>
                  <section className="workflow-runs-io" aria-label={`${stage.label} outputs`}>
                    <h5 className="workflow-runs-subheading-sm">Outputs</h5>
                    <pre className="workflow-runs-pre">{formatJson(stage.output)}</pre>
                  </section>
                </div>
              </details>
            ))}
        </section>
      )}
    </div>
  );
}
