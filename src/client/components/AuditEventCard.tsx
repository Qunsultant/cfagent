/**
 * Issue #2371 (AOP phase 2, program #1969; renders the #2381 outcome
 * catalog): one audit event card
 * for the records explorer. For a cataloged code the resolved business
 * message leads, the raw code is secondary, and category/retryability
 * are visible — never a raw-code-only rendering for a cataloged code.
 * The raw payload stays visible below, unchanged. Built only from
 * ui primitives (Card, Badge, Flex, Stack) with token utilities —
 * the explorer's old event-* classes are retired (issue #4825), so
 * the per-agent tag colors are gone: the agent renders as a neutral
 * Badge, the name as text.
 */
import React from "react";
import { Badge, Card, Flex, Stack } from "../components/ui";
import type { AuditLogEvent } from "../chat/types";

export function AuditEventCard({ event: e }: { event: AuditLogEvent }) {
  const resolved = e.resolvedAspects ?? null;
  return (
    <Card padding="sm">
      <Stack gap="2">
        <Flex justify="between" align="center" gap="2">
          <Badge size="xs" tone="neutral">{e.agent.toUpperCase()}</Badge>
          <span className="ui-meta-sm">{e.type}</span>
          <span className="ui-meta-sm">{new Date(e.created_at).toLocaleTimeString()}</span>
        </Flex>
      {resolved ? (
        <div>
          <div>
            <strong>{resolved.businessMessage}</strong>
          </div>
          <div>
            <span>{resolved.code}</span>{" "}
            <Badge size="xs" tone="info">
              {resolved.category}
            </Badge>{" "}
            <Badge size="xs" tone={resolved.retryable ? "success" : "neutral"}>
              {resolved.retryable ? "Retryable" : "Not retryable"}
            </Badge>
          </div>
        </div>
      ) : null}
      <pre className="ui-pre">{JSON.stringify(e.payload, null, 2)}</pre>
    </Stack>
  </Card>
  );
}
