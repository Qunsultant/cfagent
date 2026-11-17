/**
 * Issue #5116 (#5109 Sub-issue 7: UX-URL) — OODA Research page, spliced into
 * Intelligence next to goal-screen. Reuses `ResearchRunsPanel` and `src/client/components/ui/`
 * primitives to surface latest report, run history + per-stage detail, Run now,
 * schedule/guard status (21:00 UTC), and evaluations/track record.
 */
import React from "react";
import { Badge, Flex, PageSection, PageShell } from "./components/ui";
import { ResearchRunsPanel } from "./options/ResearchRunsPanel";

export interface OodaResearchPageProps {
  activeEnv?: "PROD" | "TEST";
  userLogin?: string;
}

export function OodaResearchPage({ activeEnv = "PROD", userLogin }: OodaResearchPageProps) {
  return (
    <PageShell
      title="OODA Nightly Research"
      scopeNote="Engine job research:<runId> · 21:00–21:30 UTC weekday guard · Reports tab remains the archive"
    >
      <PageSection title="Nightly research & track record">
        <Flex gap="2" wrap={true}>
          <Badge tone="accent">OODA · AI</Badge>
          <Badge tone="info">Stages: feed → enrich → analyze (OODA) → generate → deliver → evaluate</Badge>
        </Flex>
        <ResearchRunsPanel activeEnv={activeEnv} userLogin={userLogin} />
      </PageSection>
    </PageShell>
  );
}
