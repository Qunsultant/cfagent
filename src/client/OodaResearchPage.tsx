/**
 * Issue #5116 (#5109 Sub-issue 7: UX-URL) & #5304 — OODA Research page,
 * built on `PageTemplate` and `src/client/components/ui/` primitives
 * (`tokens.css` + `primitives.css`).
 *
 * Issue #6034 — the pipeline tile and the stage badge name the stages the
 * run read actually answered (`GET /research/runs/:runId/stages`), never a
 * client-side list: until a read lands they say "read from the run".
 */
import React, { useState } from "react";
import { Badge, Flex, KpiRibbon, PageSection, PageTemplate } from "./components/ui";
import { ResearchRunsPanel } from "./options/ResearchRunsPanel";

export interface OodaResearchPageProps {
  activeEnv?: "PROD" | "TEST";
  userLogin?: string;
}

export function OodaResearchPage({ activeEnv = "PROD", userLogin }: OodaResearchPageProps) {
  // Issue #6034 — reported by the stage read, not asserted here.
  const [stageIds, setStageIds] = useState<string[]>([]);
  const stageValue = stageIds.length > 0 ? `${stageIds.length} stages` : "read from the run";
  const stageSub = stageIds.length > 0 ? stageIds.join(" → ") : "from the stage read";
  return (
    <PageTemplate
      title="OODA Nightly Research"
      scopeNote="Engine job research:<runId> · 21:00–21:30 UTC weekday guard · Reports tab remains the archive"
      kpiRibbon={
        <KpiRibbon
          items={[
            { label: "Engine Job", value: "research:<runId>", sub: "J-stack durable" },
            { label: "Guard Window", value: "21:00–21:30 UTC", sub: "Weekdays" },
            { label: "Pipeline", value: stageValue, sub: stageSub },
            { label: "Environment", value: activeEnv, sub: userLogin ? `Owner: ${userLogin}` : "Owner scoped" },
          ]}
        />
      }
    >
      <PageSection title="Nightly research & track record">
        <Flex gap="2" wrap={true}>
          <Badge tone="accent">OODA · AI</Badge>
          <Badge tone="info">
            {stageIds.length > 0 ? `Stages: ${stageIds.join(" → ")}` : "Stages: read from the run"}
          </Badge>
        </Flex>
        <ResearchRunsPanel activeEnv={activeEnv} userLogin={userLogin} onStages={setStageIds} />
      </PageSection>
    </PageTemplate>
  );
}
