/**
 * #1644 (parent #1638, doc §8): the REST → IMcpToolCommand bridge.
 *
 * Reduced REST handlers execute through the command registry instead of
 * re-implementing the query: one execution path per command, with the
 * route keeping only transport concerns (body/query parsing, REST-contract
 * defaults, response shaping, error-status mapping) and its position in
 * routeRequest's sequential matching (auth/session unchanged).
 *
 * Two context shapes, one rule: a command reduced here MUST NOT read
 * context.env or context.facade (verified per command in the #1644 issue
 * map). Commands that need the facade (e.g. get_payment_gateways) go
 * through executeMCPTool from src/mcps/openaimp/index.ts, which builds a real
 * McpSystemFacade from the route's env — see payments.ts. This bridge is
 * for the env-free commands only, so route contexts that carry no env
 * (schema, ads/revenue, audit, memory) need no new required fields and
 * existing test literals keep typechecking.
 */
import { McpToolFactory } from "../../mcps/openaimp/commands";
import type { DatabaseORM } from "../../orm";
import type { McpToolContext } from "../../patterns/interfaces";

/** The pieces a reduced route already carries; env stays optional. */
export interface RestToolParts {
  orm: DatabaseORM;
  sessionId: string;
  audit: McpToolContext["audit"];
  env?: unknown;
  scopedModes?: McpToolContext["scopedModes"];
  /** #1722: NLQ_MODE session/user carriers, forwarded to the tool context. */
  scopedNlqModes?: McpToolContext["scopedNlqModes"];
  /** #1723: KNOWLEDGE_MODE / MEMORY_READ_MODE carriers, forwarded likewise. */
  scopedKnowledgeModes?: McpToolContext["scopedKnowledgeModes"];
  scopedMemoryModes?: McpToolContext["scopedMemoryModes"];
  /** #1728: agentic-payments carriers, forwarded likewise. */
  scopedPaymentsModes?: McpToolContext["scopedPaymentsModes"];
  /** #5041: internal schema admin routes may query unlisted tables. */
  allowUnlistedTables?: boolean;
}

/**
 * Build the tool context for a reduced route. The env cast is contained
 * here by design: env-free commands never read it, and any future
 * facade-reading reduction must use executeMCPTool instead of this bridge.
 */
export function restToolContext(parts: RestToolParts): McpToolContext {
  return {
    env: parts.env as McpToolContext["env"],
    orm: parts.orm,
    sessionId: parts.sessionId,
    audit: parts.audit,
    scopedModes: parts.scopedModes,
    scopedNlqModes: parts.scopedNlqModes,
    scopedKnowledgeModes: parts.scopedKnowledgeModes,
    scopedMemoryModes: parts.scopedMemoryModes,
    scopedPaymentsModes: parts.scopedPaymentsModes,
    ...(parts.allowUnlistedTables ? { allowUnlistedTables: true } : {}),
  } as McpToolContext;
}

/** Execute one registered command with a route-built context. */
export async function runRestTool(
  name: string,
  input: Record<string, unknown>,
  parts: RestToolParts
): Promise<unknown> {
  return McpToolFactory.executeTool(name, input, restToolContext(parts));
}
