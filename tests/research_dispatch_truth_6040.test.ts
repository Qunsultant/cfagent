// @vitest-environment node
/**
 * Issue #6040 — dispatch truth for the OODA research job.
 *
 * Two dispatch paths used to report a run that never happened: the
 * `run_research_job` MCP execute passed a literal `{dispatched: true}`
 * receipt into a real dispatch, and the Copilot research door shipped a
 * hollow `execute` with no production importer. This suite pins the one
 * dispatch contract that replaced them:
 *
 *   - `run_research_job` returns the real `{runId, jobId, stages}` receipt
 *     (`jobId` = `research:<runId>`), never a boolean success.
 *   - The MCP path and the manual route mint the same job-id shape for the
 *     same run.
 *   - A host that cannot execute refuses with `research_dispatch_unavailable`
 *     instead of answering success.
 *   - The retired Copilot door is deprecated in place (gitops §22), names its
 *     successor, and has no production importer.
 *   - A pin: no research dispatch in `src/` answers a success without a runId.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { RunResearchJobCommand } from "../src/mcps/openaimp/researchJobCommands";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";
import {
  dispatchResearchEngineRun,
  type ResearchDispatchTarget,
} from "../src/workflows/researchScreenEngine";
import { researchEngineJobId } from "../src/workflows/researchDataPorts";
import { RESEARCH_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";

const SRC = join(process.cwd(), "src");
const REPO = process.cwd();

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, predicate));
    else if (predicate(path)) out.push(path);
  }
  return out;
}

function sourceFiles(): string[] {
  return walk(SRC, (path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
}

/** A dispatch target that reports a real run, not a literal receipt. */
function dispatchTarget(): ResearchDispatchTarget {
  return {
    researchDeps: {
      runOodaAnalysis: async (ctx) =>
        ({ runId: ctx.runId, ideas: [{ symbol: "AAPL" }] }) as never,
    },
    execute: async (ctx) => ({
      success: true,
      runId: ctx?.runId ?? null,
      report: { runId: ctx?.runId, ideas: [] },
    }),
  };
}

function mcpContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: {},
    orm: undefined,
    sessionId: "s-6040",
    actingLogin: () => "trader@example.com",
    audit: () => {},
    researchDispatch: dispatchTarget(),
    ...overrides,
  };
}

describe("Issue #6040 — run_research_job reports the run it started", () => {
  it("returns {runId, jobId, stages} from a real dispatch, with jobId = research:<runId>", async () => {
    const command = new RunResearchJobCommand();
    // `op: "run"` names an existing run id to dispatch under; a bare runId
    // means the run-level status read (#6034).
    const receipt = (await command.execute(
      { trigger: "manual", runId: "r-6040-receipt", op: "run" },
      mcpContext() as never,
    )) as Record<string, unknown>;

    expect(receipt.runId).toBe("r-6040-receipt");
    expect(receipt.jobId).toBe("research:r-6040-receipt");
    expect(receipt.stages).toHaveLength(RESEARCH_PIPELINE_STAGES.length);
    // The old literal success receipt is gone.
    expect(receipt.dispatched).toBeUndefined();
    expect(receipt.trigger).toBeUndefined();
  });

  it("mints the run id when the caller names none, so the receipt always identifies a run", async () => {
    const command = new RunResearchJobCommand();
    const receipt = (await command.execute(
      { trigger: "manual" },
      mcpContext() as never,
    )) as Record<string, unknown>;

    expect(typeof receipt.runId).toBe("string");
    expect((receipt.runId as string).length).toBeGreaterThan(0);
    expect(receipt.jobId).toBe(researchEngineJobId(receipt.runId as string));
  });

  it("refuses with research_dispatch_unavailable when the host has no way to execute", async () => {
    const command = new RunResearchJobCommand();
    await expect(
      command.execute(
        { trigger: "manual" },
        mcpContext({ researchDispatch: undefined }) as never,
      ),
    ).rejects.toThrow(/research_dispatch_unavailable/);
  });

  it("keeps the owner gate: no acting identity never dispatches", async () => {
    const command = new RunResearchJobCommand();
    await expect(
      command.execute(
        { trigger: "manual" },
        mcpContext({ actingLogin: () => undefined }) as never,
      ),
    ).rejects.toThrow(/FAILURE_RESEARCH_OWNER_MISSING/);
  });
});

describe("Issue #6040 — the MCP path and the manual route agree on the job id", () => {
  it("both report research:<runId> and the same six-stage view for the same input", async () => {
    const command = new RunResearchJobCommand();
    const mcp = (await command.execute(
      { trigger: "manual", runId: "r-6040-parity", op: "run" },
      mcpContext() as never,
    )) as Record<string, unknown>;

    const runResearchAndPublish = vi.fn(async (_trigger: string, _login: string, selection: any) => ({
      success: true,
      report: { runId: selection?.runId, ideas: [] },
    }));
    const asOf = "2026-11-25T00:00:00.000Z";
    const researchAgent = {
      runFeedStage: vi.fn(async () => ({
        runId: "r-parity-route",
        asOf,
        quotes: [{ symbol: "AAPL" }],
        universeSize: 1,
        quotesRetrieved: 1,
      })),
      runEnrichStage: vi.fn(async (feed: unknown) => ({
        runId: "r-parity-route",
        asOf,
        feed,
        bySymbol: {},
      })),
      evaluateRun: vi.fn(async () => null),
    };
    const ctx = {
      getScreenerAgent: vi.fn(),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "trader@example.com" })),
      getResearchAgent: vi.fn(() => researchAgent),
      runResearchAndPublish,
      getOrm: vi.fn(() => undefined),
      env: {},
      readSettingRaw: vi.fn(() => null),
      writeSetting: vi.fn(),
    } as any;

    const response = await handleScreenerResearchRoutes(
      new Request("https://agent.internal/research/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "trader@example.com" },
        body: JSON.stringify({}),
      }),
      new URL("https://agent.internal/research/run"),
      "/research/run",
      "s-6040",
      ctx,
    );
    const route = (await (response as Response).json()) as Record<string, unknown>;

    expect(typeof route.runId).toBe("string");
    expect(route.engineJobId).toBe(researchEngineJobId(route.runId as string));
    expect(mcp.jobId).toBe(researchEngineJobId(mcp.runId as string));
    expect((mcp.stages as unknown[]).length).toBe((route.stages as unknown[]).length);
    // Both name the six OODA stages, in order.
    expect((mcp.stages as Array<{ stageId: string }>).map((s) => s.stageId)).toEqual([
      ...RESEARCH_PIPELINE_STAGES,
    ]);
    expect((route.stages as Array<{ stageId: string }>).map((s) => s.stageId)).toEqual([
      ...RESEARCH_PIPELINE_STAGES,
    ]);
  });
});

describe("Issue #6040 — the Copilot research door is retired, not left hollow", () => {
  const retired = join(SRC, "agents/orchestrator/meshResearchDoor.deprecated.ts");

  it("keeps the retired door as a .deprecated module that names its successor", () => {
    const source = readFileSync(retired, "utf8");
    expect(source).toMatch(/@deprecated/);
    expect(source).toContain("dispatchResearchEngineRun");
  });

  it("has no production importer left", () => {
    const importers = sourceFiles().filter((path) =>
      readFileSync(path, "utf8").includes("meshResearchDoor"),
    );
    expect(importers.map((path) => relative(REPO, path))).toEqual([]);
  });

  it("records the retirement in the single deprecation ledger", () => {
    const ledger = readFileSync(
      join(REPO, "docs/architecture/transition/deprecations.md"),
      "utf8",
    );
    expect(ledger).toContain("meshResearchDoor.deprecated.ts");
  });
});

describe("Issue #6040 — pins: no research dispatch succeeds without a run id", () => {
  it("no module in src/ hands dispatch a literal {dispatched: true} receipt", () => {
    const offenders = sourceFiles().filter((path) =>
      readFileSync(path, "utf8").includes("dispatched: true"),
    );
    expect(offenders.map((path) => relative(REPO, path))).toEqual([]);
  });

  it("the one dispatch service always returns the minted run id and its research: job id", async () => {
    const minted = await dispatchResearchEngineRun({
      userLogin: "trader@example.com",
      trigger: "manual",
      execute: async () => ({ ok: true }),
    });
    expect(typeof minted.runId).toBe("string");
    expect(minted.runId.length).toBeGreaterThan(0);
    expect(minted.engineJobId).toBe(researchEngineJobId(minted.runId));

    const named = await dispatchResearchEngineRun({
      runId: "r-6040-pin",
      userLogin: "trader@example.com",
      trigger: "manual",
      execute: async () => ({ ok: true }),
    });
    expect(named.runId).toBe("r-6040-pin");
    expect(named.engineJobId).toBe("research:r-6040-pin");
  });
});
