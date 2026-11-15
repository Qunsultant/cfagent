/**
 * Issue #3086 (#3069 S4) — the Workflow Catalog page.
 *
 * Its own page under the Workflows menu: the catalog is the answer to
 * "what can I run, and what does each stage do", and it is the surface the
 * stage control plane (#3069) attaches to.
 *
 * Issue #4575 gave each section its own sub-tab: "Workflows and their
 * stages" and "Define and schedule" are two views on the shared `view`
 * param (`?tab=workflow-catalog&view=workflows|define`), following the
 * SchedulesHome / Autopilot precedent, so each is addressable, reloadable
 * and reversible. No content changed — the panel components are the same
 * two the page rendered as sections.
 */

import { useEffect, useState } from "react";
import { PageSection, PageTemplate, TabPanel, Tabs, type TabOption } from "./components/ui";
import { WorkflowCatalogPanel } from "./WorkflowCatalogPanel";
import { WorkflowDefinitionFlow } from "./WorkflowDefinitionFlow";
import { navigateToTab, parseViewFromSearch, subscribeToRouteChanges } from "./router";

/** The page's views, in display order. */
export const WORKFLOW_CATALOG_VIEWS = ["workflows", "define"] as const;
export type WorkflowCatalogView = (typeof WORKFLOW_CATALOG_VIEWS)[number];

export const WORKFLOW_CATALOG_VIEW_LABELS: Record<WorkflowCatalogView, string> = {
  workflows: "Workflows and their stages",
  define: "Define and schedule",
};

const WORKFLOW_CATALOG_TABS: TabOption<WorkflowCatalogView>[] = WORKFLOW_CATALOG_VIEWS.map((id) => ({
  id,
  label: WORKFLOW_CATALOG_VIEW_LABELS[id],
}));

/** Whether a value is one of this page's view ids. */
export function isWorkflowCatalogView(value: unknown): value is WorkflowCatalogView {
  return typeof value === "string" && (WORKFLOW_CATALOG_VIEWS as readonly string[]).includes(value);
}

function readViewFromUrl(): WorkflowCatalogView {
  if (typeof window === "undefined") return "workflows";
  return (parseViewFromSearch(window.location.search, isWorkflowCatalogView) as WorkflowCatalogView | null) ?? "workflows";
}

export function WorkflowCatalogPage() {
  const [view, setView] = useState<WorkflowCatalogView>(readViewFromUrl);

  useEffect(
    () =>
      subscribeToRouteChanges(() => {
        setView(readViewFromUrl());
      }),
    [],
  );

  return (
    <PageTemplate
      title="Workflow Catalog"
      scopeNote="Every workflow the platform can run, and the full contract of each of its stages: the four mode axes (sync/async, parallel/sequential, batch/online, sharded/monolithic), what the stage consumes, persists and publishes, its retry bucket, its checkpoint and whether it needs an approval. Read-only in this slice; the run action lands with each family's submission path."
    >
      <Tabs<WorkflowCatalogView>
        idBase="workflow-catalog"
        ariaLabel="Workflow Catalog views"
        tabs={WORKFLOW_CATALOG_TABS}
        value={view}
        onChange={(next) => navigateToTab("workflow-catalog", next)}
      />

      <TabPanel idBase="workflow-catalog" tabId="workflows" active={view === "workflows"}>
        <PageSection
          title="Workflows and their stages"
          description="Declared once in the workflow registry — this page and the control plane read the same declarations."
        >
          <WorkflowCatalogPanel />
        </PageSection>
      </TabPanel>

      <TabPanel idBase="workflow-catalog" tabId="define" active={view === "define"}>
        <PageSection
          title="Define and schedule"
          description="A definition is a validated spec: pick one, give it a job id, choose a cadence, and its runs land in Workflow Runs with per-stage status and times."
        >
          <WorkflowDefinitionFlow />
        </PageSection>
      </TabPanel>
    </PageTemplate>
  );
}
