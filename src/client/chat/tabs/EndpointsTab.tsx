import React from "react";
import { McpApiExplorer } from "../../McpApiExplorer";
import { PageSection, PageShell } from "../../components/ui";

export interface EndpointsTabProps {
}

export function EndpointsTab({}: EndpointsTabProps) {
  return (
    <PageShell
      title="MCP Explorer"
      scopeNote="Interactive Model Context Protocol (MCP) tool and REST endpoint testing suite"
    >
      <PageSection>
        <McpApiExplorer />
      </PageSection>
    </PageShell>
  );
}
