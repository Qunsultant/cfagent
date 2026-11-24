/**
 * Pin tests for #6438 — the UX client reads the server MCP catalogue.
 *
 * One server catalogue, consumed by every surface: the Tools tab, the
 * chat Endpoints tab (McpApiExplorer), and the IAAA admin MCP tab all
 * read the served catalogue (GET /api/mcp/catalog) instead of the
 * hand-maintained `src/client/mcpEndpointsData.ts`. The pins below are
 * the completeness contract for that move:
 *
 *  1. The served tools ARE the factory tools — no tool missing, no orphan.
 *  2. Every served tool carries its permission scope (the scope is the
 *     catalogue's grouping; the 14 hand-written client categories retire).
 *  3. Served resources/prompts/server-info ARE the server registries.
 *  4. No served description states a table count (the 10-vs-8
 *     contradiction: the ORM lists 11 tables by default — neither the
 *     resource's "10" nor the REST entry's "8" was true).
 *  5. The client mapping preserves name/description/schema and derives
 *     sample args from the schema (required props only, typed).
 *  6. The retired file has zero importers in src/client.
 *  7. The IAAA MCP gaps name no registered openaimp tool (the scanner
 *     tools stay — a separate server, #3748's scope).
 */
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INFO,
} from "../src/mcps/openaimp/index";
import { resolveToolScope } from "../src/mcps/openaimp/mcpPermissionPorts";
import {
  buildMcpCatalog,
  type ServedMcpCatalog,
} from "../src/mcps/openaimp/catalog";
import {
  fetchMcpCatalog,
  parseMcpCatalog,
  sampleArgsFromSchema,
  toClientCatalog,
  toClientTool,
} from "../src/client/mcpCatalog";
import { REST_APIS_CATALOG } from "../src/client/restEndpointsData";
import {
  buildMcpCorrelationRows,
  IAAA_CATALOG_GAPS,
  IAAA_CORRELATION_ROWS,
} from "../src/client/iaaaEndpointCatalog";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/client/apiFetch", () => ({ apiFetch: mockFetch }));

function sortedNames(names: string[]): string[] {
  return [...names].sort();
}

/** Minimal JSON-schema type check for generated sample args. */
function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function validCatalogPayload(): ServedMcpCatalog {
  return {
    server: {
      name: MCP_SERVER_INFO.name,
      title: MCP_SERVER_INFO.title,
      version: MCP_SERVER_INFO.version,
      protocolVersion: MCP_SERVER_INFO.protocolVersion,
    },
    tools: [
      {
        name: "knowledge_search",
        description: "Search the knowledge base.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The query." },
            limit: { type: "number", description: "Max results." },
          },
          required: ["query"],
        },
        scope: "mcp:read",
      },
    ],
    resources: [
      {
        uri: "sqlite://schema/tables",
        name: "Database Tables & Schema",
        description: "Schema definitions and row counts.",
        mimeType: "application/json",
      },
    ],
    prompts: [
      {
        name: "audit_security_review",
        description: "Security review.",
        arguments: [{ name: "draftId", description: "Draft id.", required: true }],
      },
    ],
  };
}

describe("mcp catalog 6438 — the served catalogue is the factory", () => {
  it("served tools are exactly the factory tools (names, descriptions, schemas)", () => {
    const catalog = buildMcpCatalog();
    const factory = McpToolFactory.getToolDefinitions();
    expect(sortedNames(catalog.tools.map((t) => t.name))).toEqual(
      sortedNames(factory.map((t) => t.name)),
    );
    const byName = new Map(factory.map((t) => [t.name, t]));
    for (const tool of catalog.tools) {
      const expected = byName.get(tool.name);
      expect(expected).toBeDefined();
      expect(tool.description).toBe(expected!.description);
      expect(tool.inputSchema).toEqual(expected!.inputSchema);
    }
  });

  it("every served tool carries its permission scope (the catalogue grouping)", () => {
    const catalog = buildMcpCatalog();
    const unscoped = catalog.tools
      .filter((t) => resolveToolScope(t.name) === null)
      .map((t) => t.name);
    expect(unscoped).toEqual([]);
    for (const tool of catalog.tools) {
      expect(tool.scope).toBe(resolveToolScope(tool.name));
    }
  });

  it("served resources, prompts, and server info are the server registries", () => {
    const catalog = buildMcpCatalog();
    expect(catalog.resources).toEqual(MCP_RESOURCES);
    expect(catalog.prompts).toEqual(MCP_PROMPTS);
    expect(catalog.server).toEqual({
      name: MCP_SERVER_INFO.name,
      title: MCP_SERVER_INFO.title,
      version: MCP_SERVER_INFO.version,
      protocolVersion: MCP_SERVER_INFO.protocolVersion,
    });
  });

  it("no served description states a table count (the 10-vs-8 contradiction is gone)", () => {
    const catalog = buildMcpCatalog();
    const countClaim = /\b\d+ relational tables\b/;
    for (const resource of catalog.resources) {
      expect(resource.description ?? "").not.toMatch(countClaim);
    }
    for (const tool of catalog.tools) {
      expect(tool.description).not.toMatch(countClaim);
    }
  });

  it("the client mapping preserves the served tool and derives typed sample args", () => {
    const catalog = buildMcpCatalog();
    const client = toClientCatalog(catalog);
    expect(sortedNames(client.tools.map((t) => t.name))).toEqual(
      sortedNames(catalog.tools.map((t) => t.name)),
    );
    for (const tool of client.tools) {
      const served = catalog.tools.find((t) => t.name === tool.name)!;
      expect(tool.description).toBe(served.description);
      expect(tool.schema).toEqual(served.inputSchema);
      expect(tool.category).toBe(served.scope);
      const required = served.inputSchema.required ?? [];
      for (const prop of required) {
        expect(tool.sampleArgs).toHaveProperty(prop);
        expect(
          typeMatches(
            tool.sampleArgs[prop],
            served.inputSchema.properties[prop]?.type ?? "string",
          ),
        ).toBe(true);
      }
      for (const prop of Object.keys(tool.sampleArgs)) {
        expect(required).toContain(prop);
      }
    }
  });

  it("toClientTool maps one served tool (scope becomes the category)", () => {
    const mapped = toClientTool({
      name: "knowledge_search",
      description: "Search.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      scope: "mcp:read",
    });
    expect(mapped.name).toBe("knowledge_search");
    expect(mapped.category).toBe("mcp:read");
    expect(mapped.sampleArgs).toEqual({ query: "" });
  });
});

describe("mcp catalog 6438 — sample args come from the schema", () => {
  it("required props only, typed placeholders", () => {
    expect(
      sampleArgsFromSchema({
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          exact: { type: "boolean" },
          tags: { type: "array" },
          filter: { type: "object" },
          count: { type: "integer" },
        },
        required: ["query", "limit", "exact", "tags", "filter", "count"],
      }),
    ).toEqual({ query: "", limit: 0, exact: false, tags: [], filter: {}, count: 0 });
  });

  it("optional props are omitted; empty schema yields no args", () => {
    expect(
      sampleArgsFromSchema({
        type: "object",
        properties: { query: { type: "string" } },
      }),
    ).toEqual({});
    expect(sampleArgsFromSchema({ type: "object", properties: {} })).toEqual({});
  });
});

describe("mcp catalog 6438 — fetch + parse fail closed", () => {
  it("parseMcpCatalog accepts a valid payload and rejects malformed ones", () => {
    expect(parseMcpCatalog(validCatalogPayload())).toEqual(validCatalogPayload());
    expect(() => parseMcpCatalog(null)).toThrow();
    expect(() => parseMcpCatalog({})).toThrow();
    expect(() => parseMcpCatalog({ ...validCatalogPayload(), tools: "nope" })).toThrow();
    expect(() =>
      parseMcpCatalog({
        ...validCatalogPayload(),
        tools: [{ name: "x" }],
      }),
    ).toThrow();
    expect(() =>
      parseMcpCatalog({
        ...validCatalogPayload(),
        resources: [{ uri: "sqlite://x" }],
      }),
    ).toThrow();
  });

  it("fetchMcpCatalog fetches the served catalogue once and maps it", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => validCatalogPayload(),
    });
    const catalog = await fetchMcpCatalog();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/mcp/catalog");
    expect(catalog.tools[0].name).toBe("knowledge_search");
    expect(catalog.tools[0].category).toBe("mcp:read");
  });

  it("fetchMcpCatalog throws on a non-OK response (never a silent stale catalogue)", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchMcpCatalog()).rejects.toThrow();
  });

  it("fetchMcpCatalog throws on a malformed payload", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tools: "nope" }),
    });
    await expect(fetchMcpCatalog()).rejects.toThrow();
  });
});

describe("mcp catalog 6438 — the retired file has zero importers", () => {
  function clientFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules") continue;
        out.push(...clientFiles(path));
      } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".deprecated.ts")) {
        out.push(path);
      }
    }
    return out;
  }

  it("no src/client file imports mcpEndpointsData (the deprecated file excluded)", () => {
    const importers = clientFiles(join(__dirname, "..", "src", "client"))
      .filter((file) => /from\s+["'].*mcpEndpointsData["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(join(__dirname, "..") + "/", ""));
    expect(importers).toEqual([]);
  });
});

describe("mcp catalog 6438 — REST stays static, without a count claim", () => {
  it("the REST catalogue keeps its 35 entries", () => {
    expect(REST_APIS_CATALOG.length).toBe(35);
  });

  it("the list-tables REST entry states no table count", () => {
    const entry = REST_APIS_CATALOG.find((e) => e.id === "api_schema_tables");
    expect(entry).toBeDefined();
    expect(entry!.description).not.toMatch(/\b\d+ relational tables\b/);
  });
});

describe("mcp catalog 6438 — IAAA gaps name no registered openaimp tool", () => {
  it("no MCP gap item is a registered tool (scanner tools excepted — a separate server)", () => {
    const registered = new Set(McpToolFactory.getToolDefinitions().map((t) => t.name));
    const scanner = new Set(["screen_options", "scanner_status", "get_scan_job", "list_scan_jobs"]);
    const stale = IAAA_CATALOG_GAPS.filter(
      (gap) => gap.area === "mcp" && !scanner.has(gap.item) && registered.has(gap.item),
    ).map((gap) => gap.item);
    expect(stale).toEqual([]);
  });

  it("the static correlation rows hold only the shares-source MCP row; per-tool rows are built", () => {
    const staticMcp = IAAA_CORRELATION_ROWS.filter((row) => row.kind === "endpoint-mcp");
    expect(staticMcp.map((row) => row.right)).toEqual(["get_audit_events"]);
    const built = buildMcpCorrelationRows(["alpha_tool", "beta_tool"]);
    expect(built).toHaveLength(4);
    expect(built.filter((row) => row.relation === "transport").map((row) => row.right)).toEqual([
      "alpha_tool",
      "beta_tool",
    ]);
    expect(built.filter((row) => row.relation === "unmapped").map((row) => row.right)).toEqual([
      "alpha_tool",
      "beta_tool",
    ]);
  });
});
