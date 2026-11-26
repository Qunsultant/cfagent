// @vitest-environment node
/**
 * Issue #4774 — the chain short ids (user ruling, comment 6912854849,
 * 2026-11-16), under the ADOPTED uniform id convention (#5175,
 * user ruling 2026-11-17): every generated id is colon-separated
 * segments, the first segment is the type, no body ever contains `:`.
 * Fixed arity per type. The short id is the body; the system id is
 * `<type>:<body>`.
 *
 * Pins:
 *  - 4774-P01 the ruled short ids are wired in the workflow catalog
 *    (stockscr, optionsscr, goalscr, strategyscr, tradrun, payrun,
 *    sagarun) and `workflowByShortId` resolves each; an unknown short
 *    id is null. `resrch` is ruled but has no catalog family yet
 *    (#5118 owns the research catalog entry), so it resolves to null.
 *  - 4774-P02 the feed chain carries feedsrc everywhere it is named:
 *    `FEED_CHAIN_SHORT_ID` is "feedsrc", every
 *    `CHAIN_PIPELINE_CATALOG` entry carries it, and the entry labels
 *    start with it. Resolution by the shape id alone refuses
 *    (null) — it names no lineage.
 *  - 4774-P03 the screener spec carries stockscr.
 *  - 4774-P04 the options chain carries optionsscr, and the built
 *    chain definition is named under it.
 *  - 4774-P05 every catalog family now carries its ruled short id
 *    (trading-leg, payment-run, saga-run wired in this rework); the
 *    research family has no catalog entry yet, so `resrch` stays
 *    unwired until #5118 lands it.
 *  - 4774-P06 no ambiguous "the pipeline" remains in the renamed
 *    surfaces: the feed-chain labels/names, the MCP descriptions,
 *    the Data Providers labels, the bridge display name, and the
 *    options-chain name. (Scope: the renamed surfaces only — the
 *    word "pipeline" still legitimately names the pipeline HOST,
 *    the pipeline control plane, and the stage jobs elsewhere.)
 *  - 4774-P07 the execution-tree level taxonomy covers every level
 *    (chain, pipeline, workflow, job, stage, unit, task, run, txn)
 *    and the qualified-id formatter prefixes each instance with its
 *    level; the stage/step/event execution ids follow the uniform
 *    convention (`stage:` / `step:` / `event:`, run and stage bodies
 *    embedded, fixed arity) — and the event id shares the stage
 *    id's run-body/stage/unit segments (segment equality, not a
 *    string prefix).
 *  - 4774-P08 the OODA disambiguation: every candidate-level step is
 *    `ooda:*`; every run-level research-pipeline stage is a plain
 *    `stage:` execution id (`respipe:` retired by the uniform
 *    adoption — the hierarchy scopes the stages); the shared names
 *    observe/orient/decide resolve to different ids at the two
 *    levels; the trace recorders populate `shortId` on the OODA
 *    loop only.
 *  - 4774-P09 every run/transaction instance carries a unique id:
 *    the engine run-id generator mints `run:<time>-<counter>`
 *    through the one leaf minter (#5175 slice 3); the
 *    research generator still mints `rsr_<time>_<rand>` (legacy,
 *    pending #5175 migration); async jobs mint a UUID; ledger rows
 *    carry their `id` PK; the derived per-step instance id is
 *    `trace:<runBody>:<loop>:<step>:<index>` (distinct per run, per
 *    step, per index).
 *  - 5430-P10 the ruled family ids are wired, not just the short
 *    ids: every catalog id is `chain:<family>` (built by
 *    `chainId()`), every feed-chain job id is
 *    `pipe:<feed>-<dataset>` (built by `pipeId()`), every
 *    labelKey is `workflow:<shortId>` — and a scoped source scan
 *    proves no old hyphenated workflow id remains in the catalog
 *    or the chain files. (Nav/tab ids keep the old strings — a
 *    different namespace — so the scan is scoped, never global.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  chainId,
  oodaStepShortId,
  pipeId,
  qualifyExecutionId,
  runIdBody,
  stageActionEventId,
  stageExecutionId,
  stageIdBody,
  stepExecutionId,
  traceStepInstanceId,
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
      ["stockscr", "chain:stockscr"],
      ["optionsscr", "chain:optionsscr"],
      ["goalscr", "chain:goalscr"],
      ["strategyscr", "chain:strategyscr"],
      ["tradrun", "chain:tradrun"],
      ["payrun", "chain:payrun"],
      ["sagarun", "chain:sagarun"],
    ];
    for (const [shortId, id] of ruled) {
      expect(workflowById(id)?.shortId).toBe(shortId);
      expect(workflowByShortId(shortId)?.id).toBe(id);
    }
    expect(workflowByShortId("tradscr")).toBeNull();
    expect(workflowByShortId("nope")).toBeNull();
    // `resrch` is ruled but has no catalog family yet (#5118 owns the
    // research catalog entry), so it resolves to null for now.
    expect(workflowByShortId("resrch")).toBeNull();
    expect(new Set(WORKFLOW_CATALOG.map((w) => w.shortId).filter(Boolean)).size).toBe(7);
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

  it("P05: every catalog family carries its ruled short id; research has none yet", () => {
    for (const id of ["chain:tradrun", "chain:payrun", "chain:sagarun"]) {
      expect(workflowById(id)?.shortId).not.toBeUndefined();
    }
    const catalog = src("workflows/workflowCatalog.ts");
    expect(catalog).toContain('shortId: "tradrun"');
    expect(catalog).toContain('shortId: "payrun"');
    expect(catalog).toContain('shortId: "sagarun"');
    expect(catalog).not.toContain("tradscr");
    // The research family has no catalog entry yet (#5118 owns it),
    // so `resrch` is ruled but unwired.
    expect(workflowById("research")).toBeNull();
    expect(workflowByShortId("resrch")).toBeNull();
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
    for (const id of ["feedsrc", "stockscr", "optionsscr", "goalscr", "strategyscr", "tradrun", "payrun", "sagarun", "resrch"]) {
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
    expect(qualifyExecutionId("run", "m9x-1")).toBe("run:m9x-1");
    expect(qualifyExecutionId("job", "screener")).toBe("job:screener");
    // The same local string at two levels is two different ids.
    expect(qualifyExecutionId("stage", "feed")).not.toBe(qualifyExecutionId("unit", "feed"));
    // Bodies, not full ids, are embedded: the `run:` and `job:`
    // prefixes strip, and a bare name passes through unchanged.
    expect(runIdBody("run:m9x-1")).toBe("m9x-1");
    expect(runIdBody("run-1")).toBe("run-1");
    expect(stageIdBody("job:feed")).toBe("feed");
    expect(stageIdBody("feed")).toBe("feed");
    // The stage execution id: `stage:<runBody>:<stage>:<unit>`.
    expect(stageExecutionId("run:m9x-1", "job:feed")).toBe("stage:m9x-1:feed:-");
    expect(stageExecutionId("run:m9x-1", "job:feed", "AAPL")).toBe("stage:m9x-1:feed:AAPL");
    // The step execution id is the engine's journal id shape.
    expect(stepExecutionId("run:m9x-1", "job:feed", 0, "AAPL", 0)).toBe(
      "step:m9x-1:feed:0:AAPL:0",
    );
    const engine = src("services/jobPipelineEngine.ts");
    expect(engine).toContain("stepExecutionId(ctx.runId, path, stepIndex, eff.shardKey, itemIndex)");
    expect(engine).not.toContain("job-step:");
    // The stage-action event id shares the stage id's run-body /
    // stage / unit segments (segment equality, not a string prefix).
    const event = jobStageActionEvent({
      jobId: "chain:stockscr",
      runId: "run:m9x-1",
      stageId: "job:feed",
      unitId: "AAPL",
      action: "started",
      at: "2026-11-17T12:00:00.000Z",
    });
    const segments = event.id.split(":");
    expect(segments).toHaveLength(7);
    expect(segments[0]).toBe("event");
    expect(segments.slice(1, 4)).toEqual(["m9x-1", "feed", "AAPL"]);
    expect(segments[4]).toBe("started");
    expect(segments[5]).toBe(String(Date.parse("2026-11-17T12:00:00.000Z")));
    expect(segments[6].length).toBeGreaterThan(0);
    expect(event.id).not.toContain("job-stage:");
    expect(event.id).not.toContain("2026-11-17T12:00:00.000Z");
    const stageSegments = stageExecutionId("run:m9x-1", "job:feed", "AAPL").split(":");
    expect(segments.slice(1, 4)).toEqual(stageSegments.slice(1, 4));
    expect(stageActionEventId("run:m9x-1", "job:feed", "AAPL", "started", 1794916800000, "abc123")).toBe(
      "event:m9x-1:feed:AAPL:started:1794916800000:abc123",
    );
  });

  it("P08: the OODA steps and the run-level stages resolve distinctly", () => {
    expect(OODA_LOOP_SHORT_ID).toBe("ooda");
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
    // Run-level research stages are plain `stage:` execution ids —
    // `respipe:` was retired by the uniform-convention adoption.
    for (const stage of pipeStages) {
      expect(stageExecutionId("run:m9x-1", stage)).toBe(`stage:m9x-1:${stage}:-`);
    }
    // The shared names resolve to different ids at the two levels.
    for (const shared of ["observe", "orient", "decide"] as const) {
      expect(oodaStepShortId(shared)).not.toBe(stageExecutionId("run:m9x-1", shared));
    }
    // `respipe:` appears nowhere as a mechanism in the leaf or the
    // pipeline: the namespace is retired (its name survives only in
    // the retirement comments), and the stage trace carries no shortId.
    const leaf = src("services/executionTreeIds.ts");
    expect(leaf).not.toContain("RESEARCH_PIPELINE_SHORT_ID");
    expect(leaf).not.toContain("researchPipelineStageShortId");
    const pipeline = src("services/researchPipeline.ts");
    expect(pipeline).not.toContain("researchPipelineStageShortId");
    expect(pipeline).toContain("shortId: oodaStepShortId(stage)");
    expect(pipeline).not.toContain("shortId: researchPipelineStageShortId(s)");
  });

  it("P09: every run/transaction instance carries a unique id", () => {
    // Engine runs mint `run:<time>-<counter>` through the one leaf
    // minter (#5175 slice 3 — the inline closure moved into
    // `executionTreeIds.newRunId`, same format, module counter);
    // research runs ADOPT the id the engine minted and mint only for a
    // direct call with none — through that same leaf authority, never a
    // private `rsr_` template (#5911 retired the last one); async jobs
    // mint a UUID; ledger rows carry their `id` PK. No instance level is
    // id-less.
    const engine = src("services/jobPipelineEngine.ts");
    expect(engine).toContain('import { newRunId, runIdBody, stageIdBody, stepExecutionId } from "./executionTreeIds"');
    expect(engine).toContain("deps.newRunId ?? newRunId");
    expect(engine).not.toContain("`run:${this.now().getTime().toString(36)}-${(++counter).toString(36)}`");
    const research = src("services/researchPipeline.ts");
    expect(research).not.toContain("`rsr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`");
    expect(research).toContain("import { newRunId as mintRunId, oodaStepShortId } from \"./executionTreeIds\"");
    expect(research).toContain("const runId = opts.runId ?? newRunId()");
    const asyncJobs = src("agents/orchestrator/asyncJobs.ts");
    expect(asyncJobs).toContain("crypto.randomUUID()");
    const orm = src("data/doSqliteOrmAdapters.ts");
    expect(orm).toContain('"mas_transactions", "id"');
    // A trace step's instance id is derived: distinct per run, per
    // step, and per index within a run.
    const a = traceStepInstanceId("run:m9x-1", "ooda:observe", 0);
    expect(a).toBe("trace:m9x-1:ooda:observe:0");
    expect(traceStepInstanceId("run:m9x-1", "ooda:observe", 1)).not.toBe(a);
    expect(traceStepInstanceId("run:m9x-2", "ooda:observe", 0)).not.toBe(a);
    expect(traceStepInstanceId("run:m9x-1", "ooda:orient", 0)).not.toBe(a);
    expect(() => traceStepInstanceId("run:m9x-1", "observe", 0)).toThrow();
  });
});

describe("ruled family ids (#5430)", () => {
  it("P10: the catalog carries the ruled family ids and the feed chains carry the ruled pipe ids", () => {
    // #5430 — the workflow catalog key is the family id `chain:<family>`
    // (the job name lives in the job-definition catalog as `job:<spec>`),
    // and every feed-chain job id is `pipe:<feed>-<dataset>`. No old
    // hyphenated workflow id remains in the catalog or the chain files.
    const ruled = new Set([
      "chain:stockscr",
      "chain:optionsscr",
      "chain:goalscr",
      "chain:strategyscr",
      "chain:tradrun",
      "chain:payrun",
      "chain:sagarun",
    ]);
    for (const workflow of WORKFLOW_CATALOG) {
      expect(workflow.shortId).toBeDefined();
      expect(workflow.id).toBe(chainId(workflow.shortId!));
      expect(ruled.has(workflow.id)).toBe(true);
      expect(workflow.labelKey).toBe(`workflow.${workflow.shortId}`);
    }
    expect(WORKFLOW_CATALOG.length).toBe(7);
    for (const entry of CHAIN_PIPELINE_CATALOG) {
      const stem = entry.feedJobId.replace(new RegExp(`-${entry.dataset}$`), "");
      expect(entry.jobId).toBe(pipeId(stem, entry.dataset));
      expect(entry.jobId.startsWith("pipe:")).toBe(true);
    }
    // Scoped source scan (#5430 (c)): the old ids appear nowhere in
    // the files that carry the renamed ids — every file under
    // src/workflows/, the two chain-job files, and the catalog tests
    // themselves. The list is assembled from fragments so this file
    // carries no old-id literal of its own (it is one of the scanned
    // files). Nav/tab ids keep the old strings — a different
    // namespace — so this is scoped, never a global ban. The scan
    // matches the exact quoted literal: run ids (`goal-screen:<id>`),
    // step names (`execute-goal-screen`), route paths and prose
    // mentions are other namespaces and do not trip it.
    const oldIds = [
      ["stock", "screener"],
      ["options", "screener"],
      ["trading", "leg"],
      ["payment", "run"],
      ["saga", "run"],
      ["goal", "screen"],
      ["strategy", "discovery"],
    ].map((parts) => parts.join("-"));
    const quoted = (id: string) => `"${id}"`;
    const sourceFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(path));
        else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(path);
      }
      return out;
    };
    const scanned: string[] = [
      ...sourceFiles(join(here, "..", "src", "workflows")),
      join(here, "..", "src", "services", "chainPipelineJobs.ts"),
      join(here, "..", "src", "services", "feedPipelineJobs.ts"),
      ...[
        "chain_short_ids_4774.test.ts",
        "workflow_catalog_3071.test.ts",
        "workflow_catalog_runtime_parity_3166.test.ts",
        "options_trading_stage_ids_3191.test.ts",
      ].map((test) => join(here, test)),
    ];
    expect(scanned.length).toBeGreaterThan(0);
    for (const file of scanned) {
      const text = readFileSync(file, "utf8");
      for (const old of oldIds) {
        expect(text, `${file} still carries the old workflow id "${old}"`).not.toContain(
          quoted(old),
        );
      }
    }
    const chains = src("services/chainPipelineJobs.ts");
    expect(chains).not.toContain("}-pipeline");
    expect(chains).not.toContain('"-pipeline"');
    const registry = src("services/pipelineChains.ts");
    expect(registry).not.toContain("}-pipeline");
    expect(registry).not.toContain('"-pipeline"');
  });
});
