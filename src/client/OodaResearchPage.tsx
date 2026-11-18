/**
 * Issue #5116 (#5109 Sub-issue 7: UX-URL) & #5304 — OODA Research page,
 * built on `PageTemplate` and `src/client/components/ui/` primitives
 * (`tokens.css` + `primitives.css`).
 */
import React from "react";
import { Badge, Flex, KpiRibbon, PageSection, PageTemplate } from "./components/ui";
import { ResearchRunsPanel } from "./options/ResearchRunsPanel";

export interface OodaResearchPageProps {
  activeEnv?: "PROD" | "TEST";
  userLogin?: string;
}

export function OodaResearchPage({ activeEnv = "PROD", userLogin }: OodaResearchPageProps) {
  return (
    <PageTemplate
      title="OODA Nightly Research"
      scopeNote="Engine job research:<runId> · 21:00–21:30 UTC weekday guard · Reports tab remains the archive"
      kpiRibbon={
        <KpiRibbon
          items={[
            { label: "Engine Job", value: "research:<runId>", sub: "J-stack durable" },
            { label: "Guard Window", value: "21:00–21:30 UTC", sub: "Weekdays" },
            { label: "Pipeline", value: "6 stages", sub: "feed → evaluate" },
            { label: "Environment", value: activeEnv, sub: userLogin ? `Owner: ${userLogin}` : "Owner scoped" },
          ]}
        />
      }
    >
      <PageSection title="Nightly research & track record">
        <Flex gap="2" wrap={true}>
          <Badge tone="accent">OODA · AI</Badge>
          <Badge tone="info">Stages: feed → enrich → analyze (OODA) → generate → deliver → evaluate</Badge>
        </Flex>
        <ResearchRunsPanel activeEnv={activeEnv} userLogin={userLogin} />
      </PageSection>
    </PageTemplate>
  );
}
