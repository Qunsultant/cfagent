/**
 * The served MCP catalogue (#6438, sub-issue of #6266).
 *
 * One server catalogue, consumed by every surface: the Tools tab, the
 * chat Endpoints tab (McpApiExplorer), and the IAAA admin MCP tab all
 * read GET /api/mcp/catalog instead of the hand-maintained
 * `src/client/mcpEndpointsData.ts`. A newly registered tool appears in
 * every surface after deploy, with no client-file edit.
 *
 * The catalogue is built from the live registries — nothing here is a
 * second list:
 *  - tools: McpToolFactory.getToolDefinitions(), each with its
 *    permission scope (resolveToolScope). The scope is the catalogue's
 *    grouping: the server defines it, the client displays it.
 *  - resources: MCP_RESOURCES; prompts: MCP_PROMPTS (both already
 *    server-side arrays in ./index, served as-is).
 *  - server: MCP_SERVER_INFO (name, title, version, protocol version).
 *
 * No tool, resource, or prompt is added, renamed, or described here.
 * Per-tool sync/async decisions are NOT this module's business — that
 * is the #6266 parity fix, which reads this catalogue.
 */
import { McpToolFactory } from "./commands";
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INFO,
  type MCPPromptDefinition,
  type MCPResourceDefinition,
  type MCPToolDefinition,
} from "./index";
import { resolveToolScope, type McpScope } from "./mcpPermissionPorts";

export interface ServedMcpTool {
  name: string;
  description: string;
  inputSchema: MCPToolDefinition["inputSchema"];
  /** Permission scope; null only for a tool with no scope declaration. */
  scope: McpScope | null;
}

export interface ServedMcpCatalog {
  server: {
    name: string;
    title: string;
    version: string;
    protocolVersion: string;
  };
  tools: ServedMcpTool[];
  resources: MCPResourceDefinition[];
  prompts: MCPPromptDefinition[];
}

/**
 * Builds the catalogue from the live registries. Pure derivation —
 * the same factory/handler data the MCP transport serves.
 */
export function buildMcpCatalog(): ServedMcpCatalog {
  return {
    server: {
      name: MCP_SERVER_INFO.name,
      title: MCP_SERVER_INFO.title,
      version: MCP_SERVER_INFO.version,
      protocolVersion: MCP_SERVER_INFO.protocolVersion,
    },
    tools: McpToolFactory.getToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      scope: resolveToolScope(tool.name),
    })),
    resources: [...MCP_RESOURCES],
    prompts: [...MCP_PROMPTS],
  };
}
