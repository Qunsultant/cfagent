/**
 * Issue #3186 step 2 - the options workflow's stage Blocks and its
 * composition. One Block per pipeline stage; the composer
 * (optionsScreenWorkflow.ts) is THIN - ordered Block refs, nothing
 * else. Stage logic lives behind the stage ports; production port
 * implementations land in step 3 (entry migration), one entry at a
 * time.
 *
 * Terminal semantics reuse the generic SCREEN_* outcome codes (the
 * catalog entries are real keys - see tests). Stage-specific codes
 * are a step 5 (AOP catalog) decision, not invented here. The risk
 * stage's violation terminal fails the run closed with reason
 * risk_violation (the #3000 shape); zero contracts is a legitimate
 * complete per #2038 (a leg fails by RESULT STATUS, and zero hits
 * is a legitimate complete).
 *
 * The Phase A options-leg proposal (sagaBlocks.ts) carried
 * stock-aligned stage names (fetchChains/applyFilters/rankAndGrade)
 * guessed before the options execution was mapped. The #3186
 * contract (step 1) pins the stages to real calls instead, and
 * this file is the composition that proposal becomes.
 */
import {
  defineBlock,
  type BlockComposition,
  type BlockDefinition,
} from "./blockContract";
import { OPTIONS_PIPELINE_STAGES } from "../stageRuntimeIds";

const PROMOTION = {
  candidate: "one options workflow (#3186)",
  evaluation: "options screen workflow tests",
  promotion: "one workflow for all four families",
};

const FAILED = "FAILURE_SCREEN_RUN_FAILED";
const COMPLETED = "SUCCESS_SCREEN_COMPLETED";
const PARTIAL = "SUCCESS_SCREEN_PARTIAL_RESULTS";

interface StageSpec {
  stageId: string;
  input: Array<{ name: string; type: string; required: boolean; description?: string }>;
  output: Array<{ name: string; type: string; required: boolean; description?: string }>;
  terminals: Record<string, string>;
}

const STAGE_SPECS: StageSpec[] = [
  {
    stageId: "plan",
    input: [
      { name: "runId", type: "string", required: true },
      { name: "request", type: "object", required: true, description: "options screen request or goal plan" },
    ],
    output: [
      { name: "plan", type: "object", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: { completed: COMPLETED, failed: FAILED },
  },
  {
    stageId: "chainFetch",
    input: [
      { name: "planArtifactKeys", type: "array", required: true },
      { name: "underlyings", type: "array", required: true },
    ],
    output: [
      { name: "chains", type: "array", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: { completed: COMPLETED, partial: PARTIAL, failed: FAILED },
  },
  {
    stageId: "enrich",
    input: [{ name: "chainArtifactKeys", type: "array", required: true }],
    output: [
      { name: "enriched", type: "array", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: { completed: COMPLETED, partial: PARTIAL, failed: FAILED },
  },
  {
    stageId: "screen",
    input: [{ name: "enrichedArtifactKeys", type: "array", required: true }],
    output: [
      { name: "contracts", type: "array", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: {
      completed: COMPLETED,
      partial: PARTIAL,
      no_contracts: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
      failed: FAILED,
    },
  },
  {
    stageId: "risk",
    input: [{ name: "candidateArtifactKeys", type: "array", required: true }],
    output: [
      { name: "riskReports", type: "array", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: {
      completed: COMPLETED,
      // The scanner leg ends here with no qualifying pick when no
      // symbol produced one: zero hits is a legitimate complete
      // (#2038), the same code as the screen stage's no_contracts.
      no_contracts: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
      violation: FAILED,
      failed: FAILED,
    },
  },
  {
    stageId: "persistCanonicalResults",
    input: [{ name: "screenedArtifactKeys", type: "array", required: true }],
    output: [
      { name: "runId", type: "string", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: { completed: COMPLETED, failed: FAILED },
  },
  {
    stageId: "shapeReport",
    input: [{ name: "canonicalArtifactKeys", type: "array", required: true }],
    output: [
      { name: "report", type: "object", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: {
      completed: COMPLETED,
      partial: PARTIAL,
      // Issue #4068 (fix): the shapeReport stage returns the screen
      // artifact's terminal, and a zero-hit screen is "no_contracts" —
      // a legitimate complete per #2038, as the screen and risk blocks
      // already declare. Without it the shared stage runner rejected
      // the shapeReport output of an empty screen ("unknown terminal").
      no_contracts: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
      failed: FAILED,
    },
  },
  {
    stageId: "deliver",
    input: [{ name: "reportArtifactKeys", type: "array", required: true }],
    output: [
      { name: "deliveryState", type: "string", required: true },
      { name: "artifactKeys", type: "array", required: true },
    ],
    terminals: { completed: COMPLETED, partial: PARTIAL, failed: FAILED },
  },
];

function blockFor(spec: StageSpec): BlockDefinition {
  return defineBlock({
    id: `options-${spec.stageId}`,
    kind: "leg",
    version: "1",
    port: { methods: ["execute", "persist"] },
    inputSchema: spec.input,
    outputSchema: spec.output,
    stageContract: {
      stageIds: [spec.stageId],
      terminalSemantics: { ...spec.terminals },
    },
    catalogEntries: [...new Set(Object.values(spec.terminals))],
    promotion: PROMOTION,
  });
}

/** One Block per options pipeline stage, in pipeline order. */
export const OPTIONS_BLOCKS: BlockDefinition[] = STAGE_SPECS.map(blockFor);

/** The options screen: ordered Block refs, nothing else. */
export const OPTIONS_SCREEN_COMPOSITION: BlockComposition = {
  id: "options-screen",
  refs: [...OPTIONS_PIPELINE_STAGES].map((stageId) => ({
    blockId: `options-${stageId}`,
    action: stageId,
  })),
  terminals: {
    completed: COMPLETED,
    partial: PARTIAL,
    no_contracts: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
    failed: FAILED,
  },
};
