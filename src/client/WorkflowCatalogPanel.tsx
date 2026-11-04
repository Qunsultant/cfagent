/**
 * Issue #3074 (#3069 S4) - the workflow catalog: every runnable workflow and
 * the full contract of each of its stages, read straight from
 * src/workflows/workflowCatalog.ts (one model, no second list), joined to the
 * LAST RECORDED RUN of each family so a stage shows its most recent outcome
 * next to its declared contract (issue #3130).
 *
 * The run state is read-only and comes from the existing `GET
 * /api/workflow-runs`; a stage with no row in that run renders
 * "never attempted" rather than "missing". Compliance: ui/ primitives only
 * (including the #3048 layout primitives - no bespoke CSS), tokens only,
 * no inline styles.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Flex, Notice, Stack, Table } from "./components/ui";
import {
  listWorkflows,
  type StageDeclaration,
  type WorkflowDeclaration,
  type WorkflowFamily,
} from "../workflows/workflowCatalog";
import type { WorkflowRun, WorkflowRunStage } from "../services/workflowRuns";

const MODE_AXES: ReadonlyArray<{ key: keyof StageDeclaration["modes"]; label: string }> = [
  { key: "timing", label: "Timing" },
  { key: "concurrency", label: "Concurrency" },
  { key: "volume", label: "Volume" },
  { key: "partitioning", label: "Partitioning" },
];

const MODE_SEPARATOR = " / ";

/**
 * The run model records the chain verb (`generate`); the catalog uses the
 * stage-split name (`analysis`). One mapping, stated once (workflowPorts).
 */
const RUN_STAGE_FOR_CATALOG_STAGE: Record<string, string> = {
  feed: "feed",
  gather: "gather",
  analysis: "generate",
  store: "store",
  serve: "serve",
  deliver: "deliver",
};

function modesCell(stage: StageDeclaration): React.ReactNode {
  return (
    <ul>
      {MODE_AXES.map((axis) => (
        <li key={axis.key}>
          <strong>{axis.label}:</strong> {stage.modes[axis.key].join(MODE_SEPARATOR)}
        </li>
      ))}
    </ul>
  );
}

function lastRunStage(
  stage: StageDeclaration,
  latest: WorkflowRun | undefined,
): WorkflowRunStage | undefined {
  if (!latest) return undefined;
  const verb = RUN_STAGE_FOR_CATALOG_STAGE[stage.stage] ?? stage.stage;
  return latest.stages.find((row) => row.stage === verb);
}

function lastRunCell(stage: StageDeclaration, latest: WorkflowRun | undefined): React.ReactNode {
  if (!latest) return <span>no run recorded</span>;
  const row = lastRunStage(stage, latest);
  if (!row) return <span>never attempted</span>;
  return (
    <Flex align="center" gap="2">
      <Badge
        tone={
          row.status === "completed"
            ? "success"
            : row.status === "failed"
              ? "danger"
              : row.status === "running"
                ? "info"
                : "neutral"
        }
        size="xs"
      >
        {row.status}
      </Badge>
      {row.durationMs !== null && <span>{Math.round(row.durationMs / 1000)}s</span>}
    </Flex>
  );
}

function summariseOutput(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  try {
    const json = JSON.stringify(output);
    if (!json) return null;
    return json.length > 160 ? `${json.slice(0, 160)}...` : json;
  } catch {
    return null;
  }
}

/**
 * Issue #3074: what the LAST RUN actually recorded for this stage - the
 * stage's own detail line, why it stopped, its error, its window and a
 * capped view of its output (artifact keys included). Read-only; the run
 * itself stays the authority.
 */
function stageDetailCell(stage: StageDeclaration, latest: WorkflowRun | undefined): React.ReactNode {
  if (!latest) return <span>Run the workflow to see stage detail.</span>;
  const row = lastRunStage(stage, latest);
  if (!row) return <span>This stage has not run in the latest run.</span>;
  const output = summariseOutput(row.output);
  return (
    <Stack gap="1">
      <span>{row.detail ?? "No detail recorded for this stage."}</span>
      {row.reason && <span>Reason: {row.reason}</span>}
      {row.error && (
        <Notice tone="danger" density="compact">
          {row.error}
        </Notice>
      )}
      <span>
        {row.startedAt ?? "not started"} to {row.finishedAt ?? "not finished"}
        {row.capability ? ` via ${row.capability}` : ""}
      </span>
      {output && <code>{output}</code>}
    </Stack>
  );
}

function stageColumns(
  latest: WorkflowRun | undefined,
): Array<{
  key: string;
  header: string;
  render: (stage: StageDeclaration) => React.ReactNode;
}> {
  return [
    {
      key: "stage",
      header: "Stage",
      render: (stage) => (
        <>
          <strong>{stage.label}</strong>
          {stage.requiresApproval && (
            <>
              {" "}
              <Badge tone="warning" size="xs">
                Approval required
              </Badge>
            </>
          )}
        </>
      ),
    },
    { key: "modes", header: "Modes", render: modesCell },
    {
      key: "flow",
      header: "Consumes -> persists -> publishes (one message per step)",
      render: (stage) => (
        <Stack gap="1">
          <span>
            {stage.consumes ?? "start of run"} -&gt; {stage.persists} -&gt;{" "}
            {stage.publishes.length > 0 ? stage.publishes.join(", ") : "nothing published"}
          </span>
          {stage.runtimeStageIds && stage.runtimeStageIds.length > 0 ? (
            <code>{stage.runtimeStageIds.join(", ")}</code>
          ) : (
            <span>runtime mapping pending</span>
          )}
        </Stack>
      ),
    },
    { key: "retry", header: "Retry bucket", render: (stage) => stage.retryBucket },
    {
      key: "checkpoint",
      header: "Checkpoint",
      render: (stage) => (stage.checkpointed ? "yes" : "no"),
    },
    { key: "lastRun", header: "Last run", render: (stage) => lastRunCell(stage, latest) },
    {
      key: "detail",
      header: "Stage detail (last run)",
      render: (stage) => stageDetailCell(stage, latest),
    },
  ];
}

function WorkflowCard({
  workflow,
  latest,
}: {
  workflow: WorkflowDeclaration;
  latest: WorkflowRun | undefined;
}) {
  return (
    <Card padding="md">
      <Stack gap="3">
        <Flex align="center" justify="between" gap="3">
          <strong>{workflow.label}</strong>
          <Flex align="center" gap="2">
            <Badge tone={workflow.runnable ? "success" : "neutral"} size="sm">
              {workflow.runnable ? "Runnable" : "Read-only"}
            </Badge>
            {/* Issue #3074: Run links the family's EXISTING, gated submission
                surface - the catalog never invents a submission path and never
                bypasses that surface's flags or payment gates. */}
            {workflow.runnable && workflow.runPath ? (
              <Button href={workflow.runPath} variant="secondary" size="sm">
                Run
              </Button>
            ) : null}
            {/* Issue #3174: every workflow links to its own runs in the ledger. */}
            <Button
              href={`?tab=workflow-runs&q=${encodeURIComponent(workflow.family)}`}
              variant="secondary"
              size="sm"
            >
              All runs
            </Button>
          </Flex>
        </Flex>
        <span>
          <code>{workflow.id}</code> | family {workflow.family} | {workflow.stages.length} stages |{" "}
          {workflow.stageSeam ? "stage seam wired" : "stage seam not wired yet"}
        </span>
        {workflow.runtimeSteps.length > 0 && (
          <span>
            Runtime steps: <code>{workflow.runtimeSteps.join(", ")}</code>
          </span>
        )}
        {workflow.runtimeMappingGap && (
          <Notice tone="neutral" density="compact" title="Runtime mapping gap">
            {workflow.runtimeMappingGap}
          </Notice>
        )}
        {latest && (
          <span>
            Last run:{" "}
            {/* Issue #3163: the run id is the deep link into Workflow Runs,
                where the full record (inputs, outputs, artifacts) lives. */}
            <Button
              href={`?tab=workflow-runs&run=${encodeURIComponent(latest.id)}`}
              variant="secondary"
              size="sm"
            >
              {latest.id}
            </Button>{" "}
            | {latest.status} | {latest.trigger}
          </span>
        )}
        <Table
          columns={stageColumns(latest)}
          rows={[...workflow.stages]}
          rowKey={(stage) => stage.stage}
          caption={`${workflow.id} stage catalog`}
        />
        {!workflow.runnable && (
          <Notice tone="neutral" density="compact" title="No submission path yet">
            This workflow is declared so its stage contract is visible; it cannot be started from
            here until its runner is verified.
          </Notice>
        )}
      </Stack>
    </Card>
  );
}

interface RunsPayload {
  runs?: WorkflowRun[];
}

export function WorkflowCatalogPanel() {
  const workflows = listWorkflows();
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/workflow-runs?limit=50", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const payload = (await res.json()) as RunsPayload;
        if (!cancelled) setRuns(Array.isArray(payload.runs) ? payload.runs : []);
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
          setRuns([]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Newest run per family (the API returns newest first). */
  const latestByFamily = useMemo(() => {
    const map = new Map<WorkflowFamily, WorkflowRun>();
    for (const run of runs ?? []) {
      const family = run.family as WorkflowFamily;
      if (!map.has(family)) map.set(family, run);
    }
    return map;
  }, [runs]);

  return (
    <Stack gap="4" aria-label="Workflow catalog">
      <Notice tone="info" density="compact" title="Stage contract, per workflow">
        Every stage persists before it announces, checkpoints, and supports all four mode axes. The
        Last run column reads the family&apos;s most recent recorded run - a stage with no row there
        is &quot;never attempted&quot;, never missing.
      </Notice>
      {loadFailed && (
        <Notice tone="warning" density="compact" title="Run state unavailable">
          The last-run column could not be loaded; the stage contract above is unaffected.{" "}
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Notice>
      )}
      {workflows.map((workflow) => (
        <WorkflowCard
          key={workflow.id}
          workflow={workflow}
          latest={latestByFamily.get(workflow.family)}
        />
      ))}
    </Stack>
  );
}
