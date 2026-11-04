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
          <strong>{stage.stage}</strong>
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
      header: "Consumes -> persists -> publishes",
      render: (stage) => (
        <span>
          {stage.consumes ?? "start of run"} -&gt; {stage.persists} -&gt; {stage.publishes}
        </span>
      ),
    },
    { key: "retry", header: "Retry bucket", render: (stage) => stage.retryBucket },
    {
      key: "checkpoint",
      header: "Checkpoint",
      render: (stage) => (stage.checkpointed ? "yes" : "no"),
    },
    { key: "lastRun", header: "Last run", render: (stage) => lastRunCell(stage, latest) },
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
          <strong>{workflow.labelKey}</strong>
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
          </Flex>
        </Flex>
        <span>
          <code>{workflow.id}</code> | family {workflow.family} | {workflow.stages.length} stages
        </span>
        {latest && (
          <span>
            Last run: <code>{latest.id}</code> | {latest.status} | {latest.trigger}
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
