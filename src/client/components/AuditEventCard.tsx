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
import { formatRecordBindingLabel } from "../ActiveBindingBadge";
import type { AuditLogEvent } from "../chat/types";

export function AuditEventCard({ event: e }: { event: AuditLogEvent }) {
  const resolved = e.resolvedAspects ?? null;
  // Issue #5102 (F5 of #5094): a brokered event carries its binding in
  // the payload — show it as a compact masked cell (broker · mode ·
  // account-type · masked id), never the full id. An event whose
  // payload carries binding fields but no account id reads Unbound.
  // Events with no binding fields at all show no cell: most audit
  // events are not brokered, and an Unbound marker on every one
  // would be noise. The raw payload below is the pre-existing
  // full-payload detail view (§5 of the plan keeps it); the cell is
  // the masked surface.
  const payload = e.payload as Record<string, unknown>;
  const carriesBinding =
    typeof payload.bindingScope === "string" ||
    typeof payload.bindingSource === "string" ||
    typeof payload.accountType === "string" ||
    typeof payload.accountId === "string";
  const bindingLabel = carriesBinding
    ? formatRecordBindingLabel({
        accountType: typeof payload.accountType === "string" ? payload.accountType : null,
        accountId: typeof payload.accountId === "string" ? payload.accountId : null,
      })
    : null;
  return (
    <Card padding="sm">
      <Stack gap="2">
        <Flex justify="between" align="center" gap="2">
          <Badge size="xs" tone="neutral">{e.agent.toUpperCase()}</Badge>
          <span className="ui-meta-sm">{e.type}</span>
          <span className="ui-meta-sm">{new Date(e.created_at).toLocaleTimeString()}</span>
        </Flex>
        {bindingLabel !== null ? (
          <Flex gap="1" align="center" wrap>
            <span className="ui-meta-sm">Account:</span>
            <Badge size="xs" tone="info" title={`Binding scope: ${typeof payload.bindingScope === "string" ? payload.bindingScope : "—"}`}>
              {bindingLabel}
            </Badge>
          </Flex>
        ) : null}
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
