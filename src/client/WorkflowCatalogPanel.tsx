/**
 * Issue #3074 (#3069 S4) — the workflow catalog: every runnable workflow and
 * the full contract of each of its stages, read straight from
 * src/workflows/workflowCatalog.ts (one model, no second list).
 *
 * Read-only in this slice: the Run action lands with the submission-path
 * verification, and a workflow whose declaration says `runnable: false`
 * can never offer one. Compliance: ui/ primitives only (including the
 * #3048 layout primitives — no bespoke CSS), tokens only, no inline styles.
 */

import React from "react";
import { Badge, Card, Flex, Notice, Stack, Table } from "./components/ui";
import {
  listWorkflows,
  type StageDeclaration,
  type WorkflowDeclaration,
} from "../workflows/workflowCatalog";

const MODE_AXES: ReadonlyArray<{ key: keyof StageDeclaration["modes"]; label: string }> = [
  { key: "timing", label: "Timing" },
  { key: "concurrency", label: "Concurrency" },
  { key: "volume", label: "Volume" },
  { key: "partitioning", label: "Partitioning" },
];

const MODE_SEPARATOR = " / ";

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

function stageColumns(): Array<{
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
  ];
}

function WorkflowCard({ workflow }: { workflow: WorkflowDeclaration }) {
  return (
    <Card padding="md">
      <Stack gap="3">
        <Flex align="center" justify="between" gap="3">
          <strong>{workflow.labelKey}</strong>
          <Badge tone={workflow.runnable ? "success" : "neutral"} size="sm">
            {workflow.runnable ? "Runnable" : "Read-only"}
          </Badge>
        </Flex>
        <span>
          <code>{workflow.id}</code> | family {workflow.family} | {workflow.stages.length} stages
        </span>
        <Table
          columns={stageColumns()}
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

export function WorkflowCatalogPanel() {
  const workflows = listWorkflows();
  return (
    <Stack gap="4" aria-label="Workflow catalog">
      <Notice tone="info" density="compact" title="Stage contract, per workflow">
        Every stage persists before it announces, checkpoints, and supports all four mode axes.
        This page is read-only in this slice; the Run action lands with its submission path.
      </Notice>
      {workflows.map((workflow) => (
        <WorkflowCard key={workflow.id} workflow={workflow} />
      ))}
    </Stack>
  );
}
