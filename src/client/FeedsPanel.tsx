/**
 * Issue issue 6048 — the DataHub feeds view.
 *
 * The stored-index feed family on one page: every registered feed job that
 * declares `family: "index100"` (the four quotes jobs, fundamentals,
 * technicals, sentiment and the stored-universe job), each with its stored
 * status, schedule and the controls the pipeline already exposes.
 *
 * Reuse, not a second implementation:
 * - the list is `GET /api/data-providers`'s `feedJobs` (the one read; the
 *   route falls back to the catalog when the pipeline door is unbound — #6046);
 * - the actions are the existing per-job routes (`postFeedJobAction`,
 *   `postFeedJobSchedule`);
 * - the row vocabulary is the existing `FeedJobView` shape.
 *
 * Output is the dataset status the same read carries (artifact, asOf, rows,
 * freshness, history). A richer preview/download panel is a later slice of
 * issue 6048; this page never fetches from a provider.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Flex, Notice, Stack, Table, type TableColumn } from "./components/ui";
import { navigateToTab } from "./router";
import type { BadgeTone } from "./components/ui/Badge";
import {
  fetchDataProviders,
  fmtDataProviderTime,
  postFeedJobAction,
  postFeedJobSchedule,
  type FeedJobActionName,
  type FeedJobView,
} from "./dataProvidersApi";

import { storedIndexFeedJobs } from "./feedsFamily";

function stateTone(state: string): BadgeTone {
  switch (state) {
    case "running":
    case "queued":
      return "info";
    case "paused":
      return "warning";
    case "failed":
      return "danger";
    case "completed":
      return "success";
    default:
      return "neutral";
  }
}

function ageLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 90) return `${seconds}s old`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m old`;
  return `${(seconds / 3600).toFixed(1)}h old`;
}

function jobState(job: FeedJobView): string {
  return job.pipeline?.state ?? job.feed?.state ?? "unknown";
}

function scheduleLabel(job: FeedJobView): string {
  const schedule = job.schedule ?? null;
  if (!schedule) return "unknown";
  if (!schedule.enabled) return "off";
  return schedule.cron ?? schedule.interval ?? "on";
}

export function FeedsPanel() {
  const [jobs, setJobs] = useState<FeedJobView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchDataProviders();
      setJobs(storedIndexFeedJobs(list));
      setLoadError(null);
    } catch (error) {
      setJobs([]);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (job: FeedJobView, action: FeedJobActionName) => {
      setBusy(job.jobId);
      setNotice(null);
      try {
        await postFeedJobAction(job.sourceId, job.jobId, action);
        setNotice(`${action} requested for ${job.jobId}.`);
        await load();
      } catch (error) {
        setNotice(
          `${action} refused for ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const toggleSchedule = useCallback(
    async (job: FeedJobView) => {
      setBusy(job.jobId);
      setNotice(null);
      try {
        const enabled = !(job.schedule?.enabled ?? false);
        await postFeedJobSchedule(job.sourceId, job.jobId, { enabled });
        setNotice(`${job.jobId} schedule ${enabled ? "enabled" : "disabled"}.`);
        await load();
      } catch (error) {
        setNotice(
          `Schedule refused for ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo<TableColumn<FeedJobView>[]>(() => {
    const jobActions = (job: FeedJobView) => {
      const state = jobState(job);
      const disabled = busy === job.jobId;
      return (
        <Flex gap="1" wrap>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void act(job, "run")}>
            Run
          </Button>
          {(state === "running" || state === "queued") && (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void act(job, "pause")}>
              Pause
            </Button>
          )}
          {state === "paused" && (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void act(job, "resume")}>
              Resume
            </Button>
          )}
          {(state === "running" || state === "queued" || state === "paused") && (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void act(job, "cancel")}>
              Cancel
            </Button>
          )}
          {(state === "completed" || state === "failed" || state === "cancelled") && (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void act(job, "retry")}>
              Retry
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void toggleSchedule(job)}>
            {job.schedule?.enabled ? "Disable schedule" : "Enable schedule"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              navigateToTab("workflow-catalog", "define");
            }}
          >
            Definition
          </Button>
        </Flex>
      );
    };

    return [
      {
        key: "job",
        header: "Job",
        render: (job) => (
          <Stack gap="0">
            <strong>{job.label}</strong>
            <span className="ui-meta-sm">{job.jobId}</span>
          </Stack>
        ),
      },
      { key: "source", header: "Source", render: (job) => job.sourceId },
      { key: "dataset", header: "Dataset", render: (job) => job.dataset },
      {
        key: "universe",
        header: "Universe",
        render: (job) => job.feed?.universeLabel ?? "—",
      },
      {
        key: "state",
        header: "State",
        render: (job) => <Badge tone={stateTone(jobState(job))} size="sm">{jobState(job)}</Badge>,
      },
      {
        key: "lastRun",
        header: "Last run",
        render: (job) => {
          const run = job.feed?.lastRun ?? null;
          if (!run) return "Never run";
          return (
            <Stack gap="0">
              <span>{`${run.status} · ${fmtDataProviderTime(run.finishedAt)}`}</span>
              <span className="ui-meta-sm">{`${run.received}/${run.requested} rows`}</span>
              {run.codedError && <span className="ui-danger">{run.codedError}</span>}
            </Stack>
          );
        },
      },
      {
        key: "rows",
        header: "Persisted",
        render: (job) => {
          const snapshot = job.feed?.snapshot ?? null;
          if (!snapshot) return "—";
          return (
            <Stack gap="0">
              <span>{`${snapshot.rowsPersisted} rows`}</span>
              <span className="ui-meta-sm">
                {`${ageLabel(snapshot.ageSeconds)}${snapshot.stale ? " · STALE" : ""}`}
              </span>
            </Stack>
          );
        },
      },
      {
        key: "schedule",
        header: "Schedule",
        render: (job) => (
          <Stack gap="0">
            <span>{scheduleLabel(job)}</span>
            {job.nextScheduledRun && (
              <span className="ui-meta-sm">{`Next ${fmtDataProviderTime(job.nextScheduledRun)}`}</span>
            )}
          </Stack>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        render: jobActions,
      },
    ];
  }, [act, busy, toggleSchedule]);

  if (jobs === null) {
    return <Notice tone="neutral" density="compact">Loading the stored-index feed family…</Notice>;
  }

  if (jobs.length === 0) {
    return (
      <Stack gap="2">
        <Notice tone="warning" density="compact" title="Feeds list unavailable">
          {loadError
            ? `The read failed: ${loadError}`
            : "The provider read returned no stored-index feed jobs. The endpoint is GET /api/data-providers (feedJobs), which falls back to the feed catalog when the pipeline host is unbound (issue 6046)."}
        </Notice>
        <Flex gap="2">
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </Flex>
      </Stack>
    );
  }

  return (
    <Stack gap="2">
      {notice && (
        <Notice tone="info" density="compact">
          {notice}
        </Notice>
      )}
      {loadError && (
        <Notice tone="warning" density="compact" title="Last refresh failed">
          {loadError}
        </Notice>
      )}
      <Flex gap="2" align="center" wrap>
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
        <span className="ui-meta-sm">
          {`${jobs.length} jobs · source: GET /api/data-providers`}
        </span>
      </Flex>
      <Table
        columns={columns}
        rows={jobs}
        rowKey={(job) => job.jobId}
        caption="stored-index feed jobs"
        stickyHeader
      />
      <Notice tone="neutral" density="compact" title="Output and replay">
        The output column reads the persisted feed-dataset status this page already has. A raw-row
        preview, a download, replay and the consumer map are the remaining slices of issue 6048; the job
        graph they read is issue 6049.
      </Notice>
    </Stack>
  );
}
