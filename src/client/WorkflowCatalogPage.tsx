/**
 * Issue #3086 (#3069 S4) — the Workflow Catalog page.
 *
 * Its own page under the Workflows menu (not a sub-tab): the catalog is the
 * answer to "what can I run, and what does each stage do", and it is the
 * surface the stage control plane (#3069) attaches to. The panel component
 * holds the rendering; this page supplies the shell, the scope note and the
 * section heading, exactly like the other standalone pages.
 */

import React from "react";
import { PageSection, PageShell } from "./components/ui";
import { WorkflowCatalogPanel } from "./WorkflowCatalogPanel";
import { WorkflowDefinitionFlow } from "./WorkflowDefinitionFlow";

export function WorkflowCatalogPage() {
  return (
    <PageShell
      title="Workflow Catalog"
      scopeNote="Every workflow the platform can run, and the full contract of each of its stages: the four mode axes (sync/async, parallel/sequential, batch/online, sharded/monolithic), what the stage consumes, persists and publishes, its retry bucket, its checkpoint and whether it needs an approval. Read-only in this slice; the run action lands with each family's submission path."
    >
      <PageSection
        title="Workflows and their stages"
        description="Declared once in the workflow registry — this page and the control plane read the same declarations."
      >
        <WorkflowCatalogPanel />
      </PageSection>
      <PageSection
        title="Define and schedule"
        description="A definition is a validated spec: pick one, give it a job id, choose a cadence, and its runs land in Workflow Runs with per-stage status and times."
      >
        <WorkflowDefinitionFlow />
      </PageSection>
    </PageShell>
  );
}
