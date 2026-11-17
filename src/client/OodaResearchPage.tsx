/**
 * Issue #5116 (#5109 Sub-issue 7: UX-URL) — OODA Research page, spliced into
 * Intelligence next to goal-screen. Reuses `ResearchRunsPanel` and `src/client/components/ui/`
 * primitives to surface latest report, run history + per-stage detail, Run now,
 * schedule/guard status (21:00 UTC), and evaluations/track record.
 */
import React from "react";
import { Badge, Card, Flex, Stack } from "./components/ui";
import { ResearchRunsPanel } from "./options/ResearchRunsPanel";

export interface OodaResearchPageProps {
  userLogin?: string;
}

export function OodaResearchPage({ userLogin }: OodaResearchPageProps) {
  return (
    <Stack gap="4">
      <Card>
        <Stack gap="2">
          <Flex gap="2" align="center" justify="between" wrap={true}>
            <div>
              <h2>OODA Nightly Research</h2>
              <p>Engine job research:&lt;runId&gt; · 21:00–21:30 UTC weekday guard · Reports tab remains the archive</p>
            </div>
            <Badge tone="accent">OODA · AI</Badge>
          </Flex>
          <Flex gap="2" wrap={true}>
            <Badge tone="info">Stages: feed → enrich → analyze (OODA) → generate → deliver → evaluate</Badge>
          </Flex>
        </Stack>
      </Card>
      <ResearchRunsPanel userLogin={userLogin} />
    </Stack>
  );
}
