import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Flex,
  Notice,
  PageSection,
  Stack,
  TextInput,
  type BadgeTone,
} from "./components/ui";
import { AsyncJobResultViewer } from "./AsyncJobResultViewer";
import { usePolling } from "./usePolling";
import { useAutoRefresh } from "./autoRefresh";
import { csrfHeaders } from "./apiFetch";

/** Badge tone for a job status (sheet rules, token-only). */
function jobStatusTone(status: AsyncJob["status"]): BadgeTone {
  switch (status) {
    case "completed": return "success";
    case "failed": return "danger";
    case "running": return "info";
    case "queued": return "neutral";
  }
}

type AsyncJob = {
  jobId: string;
  capability: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  /** Issue #1123: job-graph fields (sub-jobs hang off a main job). */
  parentJobId?: string;
  jobKind?: "main" | "report" | "delivery" | "notification";
  channel?: "email" | "slack" | "webhook";
  /** Consolidation C3 (#1277): stage-chain identity, when the job is
   *  a stage of a chained run. */
  stage?: "feed" | "generate" | "store" | "serve" | "deliver";
  chainId?: string;
  notBefore?: string;
};

export interface JobTreeNode {
  job: AsyncJob;
  children: AsyncJob[];
}

/**
 * Issue #1123: group a flat job list into main jobs with their sub-jobs.
 * Roots keep the API's order (newest first); children are ordered by
 * creation (execution order). A sub-job whose parent is not in the list
 * (e.g. paged out) renders as its own root — never hidden.
 */
export function buildJobTree(jobs: AsyncJob[]): JobTreeNode[] {
  const byId = new Map(jobs.map((job) => [job.jobId, job]));
  const childrenOf = new Map<string, AsyncJob[]>();
  const roots: AsyncJob[] = [];
  for (const job of jobs) {
    if (job.parentJobId && byId.has(job.parentJobId)) {
      const siblings = childrenOf.get(job.parentJobId) ?? [];
      siblings.push(job);
      childrenOf.set(job.parentJobId, siblings);
    } else {
      roots.push(job);
    }
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return roots.map((job) => ({ job, children: childrenOf.get(job.jobId) ?? [] }));
}

export interface AsyncJobsPanelProps {
  embedded?: boolean;
}

/** Issue #3907: the status pill text, as a pure function — counts
 *  by state; "Queue clear" only when nothing is active AND
 *  nothing failed in the window (the 2026-11-09 incident: five
 *  failed jobs, zero active, the pill read "Idle / Queue
 *  clear"). A failed load never reads as clear. */
export function asyncJobsStatusLabel(args: {
  active: number;
  failed: number;
  error: string | null;
}): string {
  if (args.error) return "Could not load";
  if (args.active > 0) return `${args.active} task${args.active === 1 ? "" : "s"} running`;
  if (args.failed > 0) return `${args.failed} failed`;
  return "Idle / Queue clear";
}

export function AsyncJobsPanel({ embedded = false }: AsyncJobsPanelProps = {}) {
  const [jobs, setJobs] = useState<AsyncJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [error, setError] = useState("");
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const tree = useMemo(() => buildJobTree(jobs), [jobs]);

  const refresh = useCallback(async () => {
    try {
      const response = await globalThis.fetch("/api/jobs?limit=30");
      const data = await response.json() as { jobs?: AsyncJob[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load async jobs.");
      setJobs(data.jobs || []);
      setError("");
      setLastRefreshedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load async jobs.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Issue #329 (P1): the 4 s poll cost 21.6k requests per idle tab per day.
  // Keep the fast cadence only while a job is actually in flight, fall back to
  // 20 s when the queue is clear, and stop entirely while the tab is hidden.
  const busyRef = useRef(false);
  busyRef.current = jobs.some((job) => job.status === "queued" || job.status === "running");
  // Issue #2481 — periodic job refresh is gated by the global
  // auto-refresh switch; the initial load above is unaffected.
  const [autoRefresh] = useAutoRefresh();
  usePolling(refresh, {
    fastMs: 4_000,
    idleMs: 20_000,
    isBusy: () => busyRef.current,
    enabled: autoRefresh.enabled,
  });

  // Issue #3605 — the fetch lives in AsyncJobResultViewer now; selecting
  // a job is all this panel does. The viewer fetches and renders the
  // result; the queue panel keeps its own error slot for refresh/retry.
  const openResult = (jobId: string) => {
    setSelectedJob(jobId);
    setError("");
  };

  // Consolidation C3 (#1277): per-stage retry — resubmits the failed
  // job from its recorded payload (upstream stages never re-run).
  const retryJob = async (jobId: string) => {
    setError("");
    try {
      // Q5 slice: direct fetch bypasses apiFetch, so attach the
      // CSRF header explicitly (same-origin mutation).
      const response = await globalThis.fetch(`/api/jobs/${jobId}/retry`, { method: "POST", headers: csrfHeaders() });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not retry the job.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry the job.");
    }
  };

  const activeCount = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const statusLabel = asyncJobsStatusLabel({ active: activeCount, failed: failedCount, error: error || null });

  if (embedded) {
    return (
      <PageSection>
        <Flex justify="between" align="center" gap="2">
          <div role="status">
            <Badge tone={error ? "danger" : activeCount > 0 ? "info" : failedCount > 0 ? "warning" : "success"} size="sm" dot>
              {statusLabel}
            </Badge>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            title="Refresh background tasks"
          >
            🔄 Refresh
          </Button>
        </Flex>

        {lastRefreshedAt && (
          <p className="ui-meta">
            Last refreshed {new Date(lastRefreshedAt).toLocaleTimeString()}.
          </p>
        )}

        {error && <Notice tone="danger">{error}</Notice>}

        {jobs.length === 0 ? (
          <p className="ui-meta-sm">No background jobs recorded in this session.</p>
        ) : (
          <>
            <ul className="ui-stack">
              {tree.slice(0, 5).map((node) => (
              <li key={node.job.jobId}>
                <Card padding="sm">
                  <Flex justify="between" align="center" gap="2">
                    <Stack gap="1" className="ui-grow">
                      <strong className="ui-single-line" title={node.job.label}>{node.job.label}</strong>
                      <Flex gap="1" align="center" wrap>
                        <Badge tone={jobStatusTone(node.job.status)} size="xs">{node.job.status}</Badge>
                        {node.children.length > 0 && (
                          <span className="ui-meta-sm">{node.children.length} sub-job{node.children.length === 1 ? "" : "s"}</span>
                        )}
                        <span className="ui-meta-sm">
                          {new Date(node.job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </Flex>
                    </Stack>
                    {(node.job.status === "completed" || node.job.status === "failed") && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void openResult(node.job.jobId)}
                        title={node.job.status === "completed" ? "Inspect job payload result" : "Inspect failure reason"}
                      >
                        {node.job.status === "completed" ? "Result" : "Error"}
                      </Button>
                    )}
                    {node.job.status === "failed" && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void retryJob(node.job.jobId)}
                        title="Retry this job from its recorded payload — upstream stages are not re-run"
                      >
                        Retry
                      </Button>
                    )}
                  </Flex>
                </Card>
              </li>
            ))}
            </ul>
            {tree.length > 5 && (
              <p className="ui-meta">
                Showing 5 of {tree.length} jobs.
              </p>
            )}
          </>
        )}

        <AsyncJobResultViewer jobId={selectedJob} variant="embedded" />
      </PageSection>
    );
  }

  return (
    <details>
      <summary>
        Async tasks
        {activeCount > 0 && <Badge tone="info" size="xs">{activeCount}</Badge>}
      </summary>
      <Stack gap="3">
        <Flex justify="between" align="center" gap="2">
          <strong>Background work</strong>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>Refresh</Button>
        </Flex>
        <div role="status" className="ui-meta">
          {statusLabel}
        </div>
        {lastRefreshedAt && (
          <p className="ui-meta">
            Last refreshed {new Date(lastRefreshedAt).toLocaleTimeString()}.
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {jobs.length === 0 ? (
          <p className="ui-meta">Submitted work will appear here.</p>
        ) : (
          <ul className="ui-stack">
            {tree.map((node) => (
              <li key={node.job.jobId}>
                <Flex justify="between" align="center" gap="2">
                  <span>
                    <strong>{node.job.label}</strong>
                    <small>
                      {node.job.status}
                      {node.job.stage ? ` · stage: ${node.job.stage}` : ""} · {new Date(node.job.createdAt).toLocaleString()}
                    </small>
                  </span>
                  <Flex gap="1" align="center">
                    {(node.job.status === "completed" || node.job.status === "failed") && (
                      <Button type="button" variant="secondary" size="sm" onClick={() => void openResult(node.job.jobId)}>
                        {node.job.status === "completed" ? "View result" : "View error"}
                      </Button>
                    )}
                    {node.job.status === "failed" && (
                      <Button type="button" variant="secondary" size="sm" onClick={() => void retryJob(node.job.jobId)}>
                        Retry
                      </Button>
                    )}
                  </Flex>
                </Flex>
                {node.children.length > 0 && (
                  <ul className="ui-stack">
                    {node.children.map((child) => (
                      <li key={child.jobId}>
                        <Flex justify="between" align="center" gap="2">
                          <span>
                            <strong>{child.label}</strong>
                            <small>
                              {child.status} · {child.jobKind ?? "sub-job"}
                              {child.stage ? ` · stage: ${child.stage}` : ""}
                              {child.notBefore && child.status === "queued" ? ` · runs after ${new Date(child.notBefore).toLocaleString()}` : ""}
                              {child.channel ? ` · ${child.channel}` : ""} · {new Date(child.createdAt).toLocaleString()}
                            </small>
                          </span>
                          <Flex gap="1" align="center">
                            {(child.status === "completed" || child.status === "failed") && (
                              <Button type="button" variant="secondary" size="sm" onClick={() => void openResult(child.jobId)}>
                                {child.status === "completed" ? "View result" : "View error"}
                              </Button>
                            )}
                            {child.status === "failed" && (
                              <Button type="button" variant="secondary" size="sm" onClick={() => void retryJob(child.jobId)}>
                                Retry
                              </Button>
                            )}
                          </Flex>
                        </Flex>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <AsyncJobResultViewer jobId={selectedJob} variant="standalone" />
      </Stack>
    </details>
  );
}
