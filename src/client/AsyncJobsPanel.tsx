import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, TextInput } from "./components/ui";
import { AsyncJobResultViewer } from "./AsyncJobResultViewer";
import { usePolling } from "./usePolling";
import { useAutoRefresh } from "./autoRefresh";
import { csrfHeaders } from "./apiFetch";

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

export function AsyncJobsPanel({ embedded = false }: AsyncJobsPanelProps = {}) {
  const [jobs, setJobs] = useState<AsyncJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [error, setError] = useState("");
  const tree = useMemo(() => buildJobTree(jobs), [jobs]);

  const refresh = useCallback(async () => {
    try {
      const response = await globalThis.fetch("/api/jobs?limit=30");
      const data = await response.json() as { jobs?: AsyncJob[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load async jobs.");
      setJobs(data.jobs || []);
      setError("");
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

  if (embedded) {
    return (
      <div className="settings-async-jobs-box">
        <div className="async-jobs-subhead">
          <div className="async-status-pill-badge" role="status">
            <span className={`async-dot ${activeCount > 0 ? "active" : "idle"}`} />
            <span className="async-count-txt">
              {activeCount > 0 ? `${activeCount} task${activeCount === 1 ? "" : "s"} running` : "Idle / Queue clear"}
            </span>
          </div>
          <Button
            type="button"
            className="btn-async-mini-refresh"
            onClick={() => void refresh()}
            title="Refresh background tasks"
          >
            🔄 Refresh
          </Button>
        </div>

        {error && <p className="async-jobs-error" role="alert">{error}</p>}

        {jobs.length === 0 ? (
          <div className="async-jobs-empty-hint">
            <span>No background jobs recorded in this session.</span>
          </div>
        ) : (
          <ul className="settings-async-jobs-list">
            {tree.slice(0, 5).map((node) => (
              <li key={node.job.jobId} className={`settings-async-job-item status-${node.job.status}`}>
                <div className="job-item-main">
                  <span className="job-item-label" title={node.job.label}>{node.job.label}</span>
                  <div className="job-item-tags">
                    <span className={`job-tag-status ${node.job.status}`}>{node.job.status}</span>
                    {node.children.length > 0 && (
                      <span className="job-tag-subjobs">{node.children.length} sub-job{node.children.length === 1 ? "" : "s"}</span>
                    )}
                    <span className="job-tag-time">
                      {new Date(node.job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
                {(node.job.status === "completed" || node.job.status === "failed") && (
                  <Button
                    type="button"
                    className="btn-async-view-result"
                    onClick={() => void openResult(node.job.jobId)}
                    title={node.job.status === "completed" ? "Inspect job payload result" : "Inspect failure reason"}
                  >
                    {node.job.status === "completed" ? "Result" : "Error"}
                  </Button>
                )}
                {node.job.status === "failed" && (
                  <Button
                    type="button"
                    className="btn-async-view-result"
                    onClick={() => void retryJob(node.job.jobId)}
                    title="Retry this job from its recorded payload — upstream stages are not re-run"
                  >
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <AsyncJobResultViewer jobId={selectedJob} variant="embedded" />
      </div>
    );
  }

  return (
    <details className="async-jobs-panel">
      <summary>
        Async tasks
        {activeCount > 0 && <span className="async-jobs-count">{activeCount}</span>}
      </summary>
      <div className="async-jobs-content">
        <div className="async-jobs-heading">
          <strong>Background work</strong>
          <Button type="button" onClick={() => void refresh()}>Refresh</Button>
        </div>
        <div role="status" className="async-jobs-live-status">
          {activeCount > 0 ? `${activeCount} task${activeCount === 1 ? "" : "s"} running` : "Idle / Queue clear"}
        </div>
        {error && <p className="async-jobs-error" role="alert">{error}</p>}
        {jobs.length === 0 ? (
          <p className="async-jobs-empty">Submitted work will appear here.</p>
        ) : (
          <ul className="async-jobs-list">
            {tree.map((node) => (
              <li key={node.job.jobId}>
                <span>
                  <strong>{node.job.label}</strong>
                  <small>
                    {node.job.status}
                    {node.job.stage ? ` · stage: ${node.job.stage}` : ""} · {new Date(node.job.createdAt).toLocaleString()}
                  </small>
                </span>
                {(node.job.status === "completed" || node.job.status === "failed") && (
                  <Button type="button" onClick={() => void openResult(node.job.jobId)}>
                    {node.job.status === "completed" ? "View result" : "View error"}
                  </Button>
                )}
                {node.job.status === "failed" && (
                  <Button type="button" onClick={() => void retryJob(node.job.jobId)}>
                    Retry
                  </Button>
                )}
                {node.children.length > 0 && (
                  <ul className="async-jobs-children">
                    {node.children.map((child) => (
                      <li key={child.jobId}>
                        <span>
                          <strong>{child.label}</strong>
                          <small>
                            {child.status} · {child.jobKind ?? "sub-job"}
                            {child.stage ? ` · stage: ${child.stage}` : ""}
                            {child.notBefore && child.status === "queued" ? ` · runs after ${new Date(child.notBefore).toLocaleString()}` : ""}
                            {child.channel ? ` · ${child.channel}` : ""} · {new Date(child.createdAt).toLocaleString()}
                          </small>
                        </span>
                        {(child.status === "completed" || child.status === "failed") && (
                          <Button type="button" onClick={() => void openResult(child.jobId)}>
                            {child.status === "completed" ? "View result" : "View error"}
                          </Button>
                        )}
                        {child.status === "failed" && (
                          <Button type="button" onClick={() => void retryJob(child.jobId)}>
                            Retry
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <AsyncJobResultViewer jobId={selectedJob} variant="standalone" />
      </div>
    </details>
  );
}
