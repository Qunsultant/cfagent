// @vitest-environment node
/**
 * Issue #5175 slice 5 — the id resolver: API GET /api/ids/resolve +
 * MCP resolve_id. The last slice of the #5175 core build.
 *
 * Pins:
 *  - 5175-S5-P01 toIdResolution shapes the registry answer into the
 *    wire answer: canonical run / alias / derived / unknown (plus the
 *    parseId fail-closed rule for the `type` field).
 *  - 5175-S5-P02 the API route answers 200 with the shared shape for
 *    canonical, alias, derived, and unknown ids; a missing or empty
 *    `id` is a 400; a non-matching path/method returns null.
 *  - 5175-S5-P03 the MCP resolve_id command resolves through the same
 *    shape; an empty id fails zod validation; a context without
 *    storage fails closed.
 *  - 5175-S5-P04 the resolver never mints: the two new resolver
 *    modules and the ResolveIdCommand block contain no minter call
 *    and no entropy source; both endpoints read through slice 2's
 *    resolve port (one read path, no second one).
 *  - 5175-S5-P05 the pinned tool registries carry resolve_id: the
 *    factory, the mcp:read scope, the synchronous set, and the audit
 *    doc (the #4255 lesson — a tool missing from any fails CI).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { ResolveIdCommand } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";
import { createRunRegistryPorts } from "../src/data/createRunRegistryPorts";
import {
  newRunId,
  newPaymentDraftId,
  parseId,
  stageExecutionId,
  jobInstanceId,
} from "../src/services/executionTreeIds";
import { toIdResolution } from "../src/services/idResolution";
import { handleIdResolveRoutes } from "../src/agents/routes/idResolve";
import { MockSqlStorage } from "./mock-sql";

const NOW = "2026-11-19T10:00:00.000Z";
const LEGACY_ALIAS = "screener:1700000000000";

describe("5175-S5-P01 toIdResolution shapes", () => {
  let storage: MockSqlStorage;
  let runA: string;
  let runB: string;
  let stageId: string;
  let jobInstance: string;

  beforeEach(() => {
    storage = new MockSqlStorage();
    const ports = createRunRegistryPorts(storage as never);
    ports.record.ensureSchema();
    runA = newRunId();
    runB = newRunId();
    ports.record.recordRun({ runId: runA as never, family: "stockscr", jobKind: "screener", trigger: "manual", aliases: [LEGACY_ALIAS], nowIso: NOW });
    ports.record.recordRun({ runId: runB as never, family: "optionsscr", jobKind: "options-screen", trigger: "scheduled", nowIso: NOW });
    stageId = stageExecutionId(runA, "feed");
    jobInstance = jobInstanceId("screener", runA);
  });

  it("shapes a canonical run id", () => {
    const resolve = createRunRegistryPorts(storage as never).resolve;
    expect(toIdResolution(runA, resolve.resolveId(runA))).toEqual({
      found: true,
      kind: "run",
      id: runA,
      canonicalId: runA,
      runId: runA,
      level: "run",
      type: "run",
      family: "stockscr",
      jobKind: "screener",
      trigger: "manual",
      createdAt: NOW,
    });
  });

  it("shapes a legacy alias id (type null, alias echoed)", () => {
    const resolve = createRunRegistryPorts(storage as never).resolve;
    expect(toIdResolution(LEGACY_ALIAS, resolve.resolveId(LEGACY_ALIAS))).toEqual({
      found: true,
      kind: "alias",
      id: LEGACY_ALIAS,
      canonicalId: runA,
      runId: runA,
      level: "run",
      type: null,
      family: "stockscr",
      jobKind: "screener",
      trigger: "manual",
      createdAt: NOW,
      alias: LEGACY_ALIAS,
    });
  });

  it("shapes derived ids (stage and job-instance) to the same run", () => {
    const resolve = createRunRegistryPorts(storage as never).resolve;
    expect(toIdResolution(stageId, resolve.resolveId(stageId))).toEqual({
      found: true,
      kind: "derived",
      id: stageId,
      canonicalId: runA,
      runId: runA,
      level: "run",
      type: "stage",
      family: "stockscr",
      jobKind: "screener",
      trigger: "manual",
      createdAt: NOW,
    });
    const jobResolution = toIdResolution(jobInstance, resolve.resolveId(jobInstance));
    expect(jobResolution).toMatchObject({
      found: true,
      kind: "derived",
      id: jobInstance,
      canonicalId: runA,
      runId: runA,
      level: "run",
      type: "screener",
    });
  });

  it("shapes unknown ids as found:false (unrecorded run, legacy, other-kind, garbage)", () => {
    const resolve = createRunRegistryPorts(storage as never).resolve;
    const unrecordedRun = newRunId();
    expect(toIdResolution(unrecordedRun, resolve.resolveId(unrecordedRun))).toEqual({
      found: false,
      kind: "unknown",
      id: unrecordedRun,
    });
    const unrecordedLegacy = "screener:1999999999999";
    expect(toIdResolution(unrecordedLegacy, resolve.resolveId(unrecordedLegacy))).toEqual({
      found: false,
      kind: "unknown",
      id: unrecordedLegacy,
    });
    const paymentId = newPaymentDraftId();
    expect(toIdResolution(paymentId, resolve.resolveId(paymentId))).toEqual({
      found: false,
      kind: "unknown",
      id: paymentId,
    });
    const garbage = "not an id at all";
    expect(toIdResolution(garbage, resolve.resolveId(garbage))).toEqual({
      found: false,
      kind: "unknown",
      id: garbage,
    });
    expect(toIdResolution("", resolve.resolveId(""))).toEqual({ found: false, kind: "unknown", id: "" });
  });

  it("parseId stays fail-closed: a wrong-arity id is unknown, never a fabricated run", () => {
    const resolve = createRunRegistryPorts(storage as never).resolve;
    const wrongArity = `stage:${parseId(runA).runBody}:feed`;
    expect(() => parseId(wrongArity)).toThrow();
    expect(toIdResolution(wrongArity, resolve.resolveId(wrongArity))).toEqual({
      found: false,
      kind: "unknown",
      id: wrongArity,
    });
  });
});

describe("5175-S5-P02 API route GET /api/ids/resolve", () => {
  let storage: MockSqlStorage;
  let runA: string;
  let stageId: string;

  beforeEach(() => {
    storage = new MockSqlStorage();
    const ports = createRunRegistryPorts(storage as never);
    ports.record.ensureSchema();
    runA = newRunId();
    ports.record.recordRun({ runId: runA as never, family: "stockscr", jobKind: "screener", trigger: "manual", aliases: [LEGACY_ALIAS], nowIso: NOW });
    stageId = stageExecutionId(runA, "feed");
  });

  const callRoute = (id: string | null, method = "GET", path = "/api/ids/resolve") => {
    const suffix = id === null ? "" : `?id=${encodeURIComponent(id)}`;
    const request = new Request(`https://agent.internal${path}${suffix}`, { method });
    return handleIdResolveRoutes(request, new URL(request.url), path, "sess-1", {
      ensureTables: () => storage,
    });
  };

  it("resolves a canonical run id with the shared shape", async () => {
    const response = await callRoute(runA);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      found: true,
      kind: "run",
      id: runA,
      canonicalId: runA,
      runId: runA,
      level: "run",
      type: "run",
      family: "stockscr",
      jobKind: "screener",
      trigger: "manual",
      createdAt: NOW,
    });
  });

  it("resolves an alias and a derived id", async () => {
    const aliasResponse = await callRoute(LEGACY_ALIAS);
    expect(aliasResponse!.status).toBe(200);
    expect(await aliasResponse!.json()).toMatchObject({ found: true, kind: "alias", alias: LEGACY_ALIAS, runId: runA });
    const stageResponse = await callRoute(stageId);
    expect(stageResponse!.status).toBe(200);
    expect(await stageResponse!.json()).toMatchObject({ found: true, kind: "derived", type: "stage", runId: runA });
  });

  it("answers unknown with 200 found:false, never a 404", async () => {
    const response = await callRoute(newRunId());
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ found: false, kind: "unknown" });
  });

  it("rejects a missing or empty id with 400", async () => {
    const missing = await callRoute(null);
    expect(missing!.status).toBe(400);
    expect(await missing!.json()).toEqual({ error: "Missing required query parameter: id" });
    const empty = await callRoute("");
    expect(empty!.status).toBe(400);
    expect(await empty!.json()).toEqual({ error: "Missing required query parameter: id" });
    const blank = await callRoute("   ");
    expect(blank!.status).toBe(400);
  });

  it("returns null for a non-matching path or method", async () => {
    expect(await callRoute(runA, "GET", "/api/ids/resolve-other")).toBeNull();
    expect(await callRoute(runA, "POST")).toBeNull();
    expect(await callRoute(runA, "GET", "/api/ids")).toBeNull();
  });
});

describe("5175-S5-P03 MCP resolve_id", () => {
  let storage: MockSqlStorage;
  let runA: string;
  let stageId: string;

  beforeEach(() => {
    storage = new MockSqlStorage();
    const ports = createRunRegistryPorts(storage as never);
    ports.record.ensureSchema();
    runA = newRunId();
    ports.record.recordRun({ runId: runA as never, family: "stockscr", jobKind: "screener", trigger: "manual", aliases: [LEGACY_ALIAS], nowIso: NOW });
    stageId = stageExecutionId(runA, "feed");
  });

  const command = new ResolveIdCommand();

  it("resolves a canonical run, an alias, a derived id, and unknown through the command", async () => {
    const context = { storage: { sql: storage } } as never;
    expect(await command.execute({ id: runA }, context)).toMatchObject({ found: true, kind: "run", runId: runA });
    expect(await command.execute({ id: LEGACY_ALIAS }, context)).toMatchObject({ found: true, kind: "alias", alias: LEGACY_ALIAS, runId: runA });
    expect(await command.execute({ id: stageId }, context)).toMatchObject({ found: true, kind: "derived", type: "stage", runId: runA });
    expect(await command.execute({ id: newRunId() }, context)).toMatchObject({ found: false, kind: "unknown" });
  });

  it("fails closed when the MCP context carries no storage", async () => {
    await expect(command.execute({ id: runA }, {} as never)).rejects.toThrow(
      "Run registry is unavailable in this MCP context.",
    );
  });

  it("declares a plain-string id input and rejects an empty id at validation", () => {
    expect(command.name).toBe("resolve_id");
    expect(command.jsonSchema.required).toEqual(["id"]);
    expect(command.jsonSchema.properties.id.type).toBe("string");
    expect(command.zodSchema.parse({ id: runA })).toEqual({ id: runA });
    expect(() => command.zodSchema.parse({ id: "" })).toThrow();
    expect(() => command.zodSchema.parse({})).toThrow();
  });

  it("returns the same shape as the API route for the same id", async () => {
    const context = { storage: { sql: storage } } as never;
    const mcpAnswer = await command.execute({ id: stageId }, context);
    const request = new Request(`https://agent.internal/api/ids/resolve?id=${encodeURIComponent(stageId)}`);
    const apiResponse = await handleIdResolveRoutes(request, new URL(request.url), "/api/ids/resolve", "sess-1", {
      ensureTables: () => storage,
    });
    expect(mcpAnswer).toEqual(await apiResponse!.json());
  });
});

describe("5175-S5-P04 the resolver never mints", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");
  const MINTER_CALLS = /newRunId|newAsyncJobId|newPaymentDraftId|newTaskProposalId|newLocalOrderId|newDidProofId|newGoalRecordId|newScheduleId|newPlatformRowId|crypto\.randomUUID|Date\.now\(\)/;

  it("the two new resolver modules contain no minter call and no entropy source", () => {
    for (const file of ["src/services/idResolution.ts", "src/agents/routes/idResolve.ts"]) {
      const source = read(file);
      expect(source).not.toMatch(MINTER_CALLS);
      expect(source).not.toMatch(/newRunId|newAsyncJobId/);
    }
    // The leaf parser is the only leaf import in the shaping module
    // (the parser, not the minters); the route reads through the
    // shared shaping function and the resolve port instead.
    expect(read("src/services/idResolution.ts")).toMatch(/parseId/);
    expect(read("src/agents/routes/idResolve.ts")).toMatch(/toIdResolution/);
    expect(read("src/agents/routes/idResolve.ts")).toMatch(/createRunRegistryPorts/);
  });

  it("the ResolveIdCommand block contains no minter call and reads through the resolve port", () => {
    const source = read("src/mcps/openaimp/commands.ts");
    const start = source.indexOf("export class ResolveIdCommand");
    const end = source.indexOf("export class ListAsyncJobsCommand", start);
    const block = source.slice(start, end);
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(MINTER_CALLS);
    expect(block).toMatch(/createRunRegistryPorts/);
    expect(block).toMatch(/toIdResolution/);
  });

  it("both endpoints read through the same single resolve port", () => {
    expect(read("src/agents/routes/idResolve.ts")).toMatch(/createRunRegistryPorts\(ctx\.ensureTables\(\)\)\.resolve/);
    expect(read("src/mcps/openaimp/commands.ts")).toMatch(/createRunRegistryPorts\(sql as RunRegistrySqlExecutor\)\.resolve/);
  });
});

describe("5175-S5-P05 resolve_id is in every pinned tool registry", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");

  it("is factory-registered with the mcp:read scope and synchronous", () => {
    expect(McpToolFactory.getTool("resolve_id")).toBeDefined();
    expect(MCP_TOOL_SCOPES["resolve_id"]).toBe("mcp:read");
    expect(isSynchronousMcpTool("resolve_id")).toBe(true);
    const definitions = McpToolFactory.getToolDefinitions();
    expect(definitions.some((tool) => tool.name === "resolve_id")).toBe(true);
  });

  it("is named in the tool-attribution audit doc", () => {
    expect(read("docs/architecture/security/tool-attribution-audit-1763.md")).toContain("`resolve_id`");
  });
});
