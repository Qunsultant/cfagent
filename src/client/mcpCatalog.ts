/**
 * Client side of the served MCP catalogue (#6438, sub-issue of #6266).
 *
 * The Tools tab, the chat Endpoints tab, and the IAAA admin MCP tab all
 * read GET /api/mcp/catalog (built server-side from the live registries
 * by `buildMcpCatalog`) instead of the hand-maintained
 * `src/client/mcpEndpointsData.ts`. A newly registered tool appears in
 * every surface after deploy, with no client-file edit.
 *
 * The served tool carries no hand-written category and no hand-written
 * sample arguments — the catalogue's grouping is the tool's permission
 * scope (server-defined, complete), and sample arguments are derived
 * from the served input schema (required props only, typed
 * placeholders; an enum prop takes its first value). Nothing here is
 * a second list: the wire shape is validated, never trusted, and a
 * failed or malformed fetch throws — the surfaces render an error,
 * never a silent stale catalogue.
 */
import { apiFetch } from "./apiFetch";

export interface ServedMcpToolWire {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  scope: string | null;
}

export interface ServedMcpResourceWire {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ServedMcpPromptWire {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface ServedMcpCatalogWire {
  server: {
    name: string;
    title: string;
    version: string;
    protocolVersion: string;
  };
  tools: ServedMcpToolWire[];
  resources: ServedMcpResourceWire[];
  prompts: ServedMcpPromptWire[];
}

export interface ClientCatalogTool {
  name: string;
  /** The tool's permission scope, as served — the catalogue's grouping. */
  category: string;
  description: string;
  schema: ServedMcpToolWire["inputSchema"];
  sampleArgs: Record<string, unknown>;
}

export interface ClientCatalogResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ClientCatalogPrompt {
  name: string;
  description: string;
  args: Array<{ name: string; description: string; required: boolean }>;
}

export interface ClientMcpCatalog {
  server: ServedMcpCatalogWire["server"];
  tools: ClientCatalogTool[];
  resources: ClientCatalogResource[];
  prompts: ClientCatalogPrompt[];
}

/** The single route that serves the catalogue. */
export const MCP_CATALOG_URL = "/api/mcp/catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new Error(`mcp catalog: invalid catalogue payload (${detail})`);
}

/**
 * Validates the wire shape and returns it. Fail-closed: any missing
 * or mistyped field throws — the caller renders an error, never a
 * partial catalogue.
 */
export function parseMcpCatalog(data: unknown): ServedMcpCatalogWire {
  if (!isRecord(data)) invalid("not an object");
  const server = data.server;
  if (!isRecord(server)) invalid("server is not an object");
  for (const field of ["name", "title", "version", "protocolVersion"]) {
    if (typeof server[field] !== "string") invalid(`server.${field} is not a string`);
  }
  if (!Array.isArray(data.tools)) invalid("tools is not an array");
  for (const tool of data.tools) {
    if (!isRecord(tool)) invalid("tool is not an object");
    if (typeof tool.name !== "string") invalid("tool.name is not a string");
    if (typeof tool.description !== "string") invalid("tool.description is not a string");
    if (!isRecord(tool.inputSchema)) invalid(`tool ${tool.name}: inputSchema is not an object`);
    if (tool.inputSchema.type !== "object") invalid(`tool ${tool.name}: inputSchema.type is not "object"`);
    if (!isRecord(tool.inputSchema.properties)) invalid(`tool ${tool.name}: inputSchema.properties is not an object`);
    if (tool.inputSchema.required !== undefined && !Array.isArray(tool.inputSchema.required)) {
      invalid(`tool ${tool.name}: inputSchema.required is not an array`);
    }
    if (tool.scope !== null && typeof tool.scope !== "string") {
      invalid(`tool ${tool.name}: scope is neither a string nor null`);
    }
  }
  if (!Array.isArray(data.resources)) invalid("resources is not an array");
  for (const resource of data.resources) {
    if (!isRecord(resource)) invalid("resource is not an object");
    if (typeof resource.uri !== "string") invalid("resource.uri is not a string");
    if (typeof resource.name !== "string") invalid("resource.name is not a string");
  }
  if (!Array.isArray(data.prompts)) invalid("prompts is not an array");
  for (const prompt of data.prompts) {
    if (!isRecord(prompt)) invalid("prompt is not an object");
    if (typeof prompt.name !== "string") invalid("prompt.name is not a string");
    if (prompt.arguments !== undefined && !Array.isArray(prompt.arguments)) {
      invalid(`prompt ${prompt.name}: arguments is not an array`);
    }
  }
  return data as unknown as ServedMcpCatalogWire;
}

function placeholderForType(def: Record<string, unknown> | undefined): unknown {
  if (def && Array.isArray(def.enum) && def.enum.length > 0) return def.enum[0];
  switch (def?.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    case "string":
    default:
      return "";
  }
}

/**
 * Derives sample arguments from the served input schema: required
 * props only, one typed placeholder each. Optional props are omitted
 * — the runner starts from the minimum valid call.
 */
export function sampleArgsFromSchema(schema: ServedMcpToolWire["inputSchema"]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const prop of schema.required ?? []) {
    args[prop] = placeholderForType(
      (schema.properties[prop] as Record<string, unknown> | undefined) ?? undefined,
    );
  }
  return args;
}

/** Maps one served tool to the client shape (scope becomes the category). */
export function toClientTool(tool: ServedMcpToolWire): ClientCatalogTool {
  return {
    name: tool.name,
    category: tool.scope ?? "uncategorized",
    description: tool.description,
    schema: tool.inputSchema,
    sampleArgs: sampleArgsFromSchema(tool.inputSchema),
  };
}

/** Maps the served catalogue to the client shapes the surfaces render. */
export function toClientCatalog(catalog: ServedMcpCatalogWire): ClientMcpCatalog {
  return {
    server: { ...catalog.server },
    tools: catalog.tools.map(toClientTool),
    resources: catalog.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description ?? "",
      mimeType: resource.mimeType ?? "application/json",
    })),
    prompts: catalog.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description ?? "",
      args: (prompt.arguments ?? []).map((arg) => ({
        name: arg.name,
        description: arg.description ?? "",
        required: arg.required ?? false,
      })),
    })),
  };
}

/**
 * Fetches the served catalogue and maps it. Throws on a non-OK
 * response or a malformed payload — callers render the error, never
 * a silent stale catalogue.
 */
export async function fetchMcpCatalog(): Promise<ClientMcpCatalog> {
  const res = await apiFetch(MCP_CATALOG_URL, { method: "GET" });
  if (!res.ok) {
    throw new Error(`mcp catalog: catalogue request failed (${res.status})`);
  }
  return toClientCatalog(parseMcpCatalog(await res.json()));
}
