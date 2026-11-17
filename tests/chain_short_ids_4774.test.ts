// @vitest-environment node
/**
 * Issue #4774 — the chain short ids (user ruling, comment 6912854849,
 * 2026-11-16): every chain shape is named by one short identifier, and
 * a bare "the pipeline" names no chain.
 *
 * Pins:
 *  - 4774-P01 the ruled short ids are wired in the workflow catalog
 *    (stockscr, optionsscr, goalscr, strategyscr) and
 *    `workflowByShortId` resolves each; an unknown short id is null.
 *  - 4774-P02 the feed chain carries feedsrc everywhere it is named:
 *    `FEED_CHAIN_SHORT_ID` is "feedsrc", every
 *    `CHAIN_PIPELINE_CATALOG` entry carries it, and the entry labels
 *    start with it. Resolution by the shape id alone refuses
 *    (null) — it names no lineage.
 *  - 4774-P03 the screener spec carries stockscr.
 *  - 4774-P04 the options chain carries optionsscr, and the built
 *    chain definition is named under it.
 *  - 4774-P05 no ruled short id is wired for trading-leg,
 *    payment-run, or saga-run — the proposed ids stay a proposal
 *    in the #4774 PR body, not code.
 *  - 4774-P06 no ambiguous "the pipeline" remains in the renamed
 *    surfaces: the feed-chain labels/names, the MCP descriptions,
 *    the Data Providers labels, the bridge display name, and the
 *    options-chain name. (Scope: the renamed surfaces only — the
 *    word "pipeline" still legitimately names the pipeline HOST,
 *    the pipeline control plane, and the stage jobs elsewhere.)
 *  - 4774-P07 the execution-tree level taxonomy covers every level
 *    (chain, pipeline, workflow, job, stage, unit, task, run, txn)
 *    and the qualified-id formatter prefixes each instance with its
 *    level; the stage/step execution ids reuse the engine's existing
 *    event/journal formats (the stage id is the prefix of the live
 *    `job-stage:` event id).
 *  - 4774-P08 the OODA disambiguation: every candidate-level step is
 *    `ooda:*`, every run-level research-pipeline stage is
 *    `respipe:*`, so the shared names observe/orient/decide resolve
 *    to different ids; the trace recorders populate `shortId`.
 *  - 4774-P09 every run/transaction instance carries a unique id:
 *    the engine and research run-id generators, the async-job UUID,
 *    the ledger `id` PK, and the derived per-step instance id
 *    (distinct per run, per step, per index).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  WORKFLOW_CATALOG,
  assertWorkflowCatalog,
  workflowById,
  workflowByShortId,
} from "../src/workflows/workflowCatalog";
import {
  jobDefinitionSpec,
  listJobDefinitionSpecs,
} from "../src/config/jobDefinitionCatalog";
import {
  CHAIN_PIPELINE_CATALOG,
  FEED_CHAIN_SHORT_ID,
  resolvePipelineChain,
} from "../src/services/chainPipelineJobs";
import {
  OPTIONS_CHAIN_SHORT_ID,
  buildOptionsChainJobDefinition,
} from "../src/services/optionsChainJobDefinition";
import {
  EXECUTION_TREE_LEVEL_SHORT_IDS,
  OODA_LOOP_SHORT_ID,
  RESEARCH_PIPELINE_SHORT_ID,
  oodaStepShortId,
  qualifyExecutionId,
  researchPipelineStageShortId,
  researchStepInstanceId,
  stageExecutionId,
  stepExecutionId,
} from "../src/services/executionTreeIds";
import { jobStageActionEvent } from "../src/services/jobPipelineEvents";
import type { ShardChainContext } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");
const doc = (rel: string) => readFileSync(join(here, "..", "docs", rel), "utf8");

describe("chain short ids (#4774)", () => {
  it("P01: the ruled short ids are wired in the workflow catalog", () => {
    assertWorkflowCatalog();
    const ruled: Array<[string, string]> = [
      ["stockscr", "stock-screener"],
      ["optionsscr", "options-screener"],
      ["goalscr", "goal-screen"],
      ["strategyscr", "strategy-discovery"],
    ];
    for (const [shortId, id] of ruled) {
      expect(workflowById(id)?.shortId).toBe(shortId);
      expect(workflowByShortId(shortId)?.id).toBe(id);
    }
    expect(workflowByShortId("tradscr")).toBeNull();
    expect(workflowByShortId("nope")).toBeNull();
    expect(new Set(WORKFLOW_CATALOG.map((w) => w.shortId).filter(Boolean)).size).toBe(4);
  });

  it("P02: the feed chain carries feedsrc everywhere it is named", () => {
    expect(FEED_CHAIN_SHORT_ID).toBe("feedsrc");
    expect(CHAIN_PIPELINE_CATALOG.length).toBeGreaterThan(0);
    for (const entry of CHAIN_PIPELINE_CATALOG) {
      expect(entry.shortId).toBe("feedsrc");
      expect(entry.label.startsWith("feedsrc — ")).toBe(true);
    }
    // The shape id names no lineage: resolution by it refuses.
    expect(resolvePipelineChain("feedsrc")).toBeNull();
    const jobs = src("services/chainPipelineJobs.ts");
    expect(jobs).toContain("label: `feedsrc — ${feed.label}`");
    expect(jobs).toContain("name: `feedsrc — ${chain.sourceId} ${chain.dataset} (${chain.universe})`");
    expect(jobs).not.toContain("Pipeline — ");
  });

  it("P03: the screener spec carries stockscr", () => {
    expect(jobDefinitionSpec("screener").shortId).toBe("stockscr");
    expect(listJobDefinitionSpecs().find((s) => s.id === "screener")?.shortId).toBe("stockscr");
    const catalog = src("config/jobDefinitionCatalog.ts");
    expect(catalog).toContain('shortId: "stockscr"');
  });

  it("P04: the options chain carries optionsscr", () => {
    expect(OPTIONS_CHAIN_SHORT_ID).toBe("optionsscr");
    const def = buildOptionsChainJobDefinition({
      chainId: "chain-4774",
      options: { symbols: ["AAPL"] },
    } as unknown as ShardChainContext) as { name: string; jobId: string };
    expect(def.jobId).toBe("options-chain:chain-4774");
    expect(def.name).toBe("optionsscr chain chain-4774");
    const leaf = src("services/optionsChainJobDefinition.ts");
    expect(leaf).not.toContain("Options sharded chain ${chain.chainId}");
  });

  it("P05: the unruled families carry no short id", () => {
    for (const id of ["trading-leg", "payment-run", "saga-run"]) {
      expect(workflowById(id)?.shortId).toBeUndefined();
    }
    // The proposal lives in the PR body, not in code: no proposed id
    // is wired anywhere in the catalog.
    const catalog = src("workflows/workflowCatalog.ts");
    expect(catalog).not.toContain("tradscr");
    expect(catalog).not.toContain("payrun");
    expect(catalog).not.toContain("sagarun");
  });

  it("P06: no ambiguous 'the pipeline' remains in the renamed surfaces", () => {
    const jobs = src("services/chainPipelineJobs.ts");
    expect(jobs).not.toContain("where is the pipeline?");
    expect(jobs).toContain("where is the feedsrc chain?");

    const commands = src("mcps/openaimp/chainJobCommands.ts");
    expect(commands).not.toContain("The pipeline chain's");
    expect(commands).not.toContain("Run a composed pipeline chain");
    expect(commands).not.toContain("Report one pipeline chain's");
    expect(commands).not.toContain("where is the pipeline?");
    expect(commands).not.toContain("List every composed pipeline chain");
    expect(commands).not.toContain("Apply one management operation to a pipeline chain");
    expect(commands).not.toContain('describe("Pipeline chain source or name")');
    expect(commands).toContain("feedsrc chain");

    const panel = src("client/DataProvidersPanel.tsx");
    expect(panel).not.toContain('header: "Pipeline"');
    expect(panel).not.toContain("No pipeline");
    expect(panel).not.toContain('Pipeline chain "${chain.jobId}"');
    expect(panel).toContain('header: "feedsrc — Feed chain"');
    expect(panel).toContain('feedsrc chain "${chain.jobId}"');

    const doors = src("agents/orchestrator/meshDoors.ts");
    expect(doors).toContain("displayName: entry.label,");
    expect(doors).not.toContain("Pipeline chain — ${entry.label}");

    const catalogPanel = src("client/WorkflowCatalogPanel.tsx");
    expect(catalogPanel).toContain("workflow.shortId");

    const modes = doc("operations/jobs-workflow-pipelines-stages-dispatch-modes.md");
    expect(modes).toContain("### Chain short ids (#4774)");
    for (const id of ["feedsrc", "stockscr", "optionsscr", "goalscr", "strategyscr"]) {
      expect(modes).toContain(`\`${id}\``);
    }
    const notes = doc("architecture/survey/4770-dispatch-modes-research-notes.md");
    expect(notes).toContain("Applied (#4774)");
  });

  it("P07: the level taxonomy covers every execution-tree level", () => {
    expect(Object.keys(EXECUTION_TREE_LEVEL_SHORT_IDS).sort()).toEqual([
      "chain",
      "job",
      "pipeline",
      "run",
      "stage",
      "task",
      "txn",
      "unit",
      "workflow",
    ]);
    expect(qualifyExecutionId("chain", "feedsrc")).toBe("chain:feedsrc");
    expect(qualifyExecutionId("run", "run-m9x-1")).toBe("run:run-m9x-1");
    expect(qualifyExecutionId("job", "stock-screener")).toBe("job:stock-screener");
    // The same local string at two levels is two different ids.
    expect(qualifyExecutionId("stage", "feed")).not.toBe(qualifyExecutionId("unit", "feed"));
    // The stage execution id is the prefix of the live stage-action
    // event id — the format is reused, not invented.
    const event = jobStageActionEvent({
      jobId: "stock-screener",
      runId: "run-m9x-1",
      stageId: "job:feed",
      unitId: "AAPL",
      action: "started",
      at: "2026-11-17T12:00:00.000Z",
    });
    expect(event.id.startsWith(`${stageExecutionId("run-m9x-1", "job:feed", "AAPL")}:`)).toBe(true);
    expect(stageExecutionId("run-m9x-1", "job:feed")).toBe("job-stage:run-m9x-1:job:feed:-");
    // The step execution id is the engine's journal id shape.
    expect(stepExecutionId("run-m9x-1", "job:feed", 0, "AAPL", 0)).toBe(
      "job-step:run-m9x-1:job:feed:0:AAPL:0",
    );
    const engine = src("services/jobPipelineEngine.ts");
    expect(engine).toContain("`job-step:${ctx.runId}:${path || \"root\"}:${stepIndex}:${eff.shardKey ?? \"-\"}:${itemIndex ?? \"-\"}`");
  });

  it("P08: the OODA steps and the run-level stages resolve distinctly", () => {
    expect(OODA_LOOP_SHORT_ID).toBe("ooda");
    expect(RESEARCH_PIPELINE_SHORT_ID).toBe("respipe");
    for (const stage of ["observe", "orient", "decide", "act"] as const) {
      expect(oodaStepShortId(stage)).toBe(`ooda:${stage}`);
    }
    const pipeStages = [
      "configure",
      "observe",
      "orient",
      "decide",
      "build-and-price",
      "challenge-and-gate",
      "rank-and-report",
      "evaluate-later",
    ] as const;
    for (const stage of pipeStages) {
      expect(researchPipelineStageShortId(stage)).toBe(`respipe:${stage}`);
    }
    // The shared names resolve to different ids at the two levels.
    for (const shared of ["observe", "orient", "decide"] as const) {
      expect(oodaStepShortId(shared)).not.toBe(researchPipelineStageShortId(shared));
    }
    // The trace entries carry the qualified id: the interfaces declare
    // it and the recorders populate it (runtime: research-pipeline.test.ts).
    const pipeline = src("services/researchPipeline.ts");
    expect(pipeline).toContain("shortId?: string;");
    expect(pipeline).toContain("shortId: oodaStepShortId(stage)");
    expect(pipeline).toContain("shortId: researchPipelineStageShortId(s)");
  });

  it("P09: every run/transaction instance carries a unique id", () => {
    // Engine runs mint `run-<time>-<counter>`; research runs mint
    // `rsr_<time>_<rand>`; async jobs mint a UUID; ledger rows carry
    // their `id` PK. No instance level is id-less.
    const engine = src("services/jobPipelineEngine.ts");
    expect(engine).toContain("`run-${this.now().getTime().toString(36)}-${(++counter).toString(36)}`");
    const research = src("services/researchPipeline.ts");
    expect(research).toContain("`rsr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`");
    const asyncJobs = src("agents/orchestrator/asyncJobs.ts");
    expect(asyncJobs).toContain("crypto.randomUUID()");
    const orm = src("data/doSqliteOrmAdapters.ts");
    expect(orm).toContain('"mas_transactions", "id"');
    // A trace step's instance id is derived: distinct per run, per
    // step, and per index within a run.
    const a = researchStepInstanceId("rsr_1", "ooda:observe", 0);
    expect(a).toBe("run:rsr_1/ooda:observe#0");
    expect(researchStepInstanceId("rsr_1", "ooda:observe", 1)).not.toBe(a);
    expect(researchStepInstanceId("rsr_2", "ooda:observe", 0)).not.toBe(a);
    expect(researchStepInstanceId("rsr_1", "respipe:observe", 0)).not.toBe(a);
  });
});
