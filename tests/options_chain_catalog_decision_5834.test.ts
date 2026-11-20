import { describe, it, expect } from "vitest";
import {
  WORKFLOW_CATALOG,
  workflowById,
  workflowByShortId,
} from "../src/workflows/workflowCatalog";
import {
  OPTIONS_CHAIN_SHORT_ID,
  OPTIONS_CHAIN_STAGE_KINDS,
} from "../src/services/optionsChainJobDefinition";

/**
 * Issue #5834 — pin the decided-not-to for adding `options-chain` as a
 * separate entry in `WORKFLOW_CATALOG`:
 * 1. `WORKFLOW_CATALOG` is the 7-family catalog; `options-chain` shares
 *    `OPTIONS_CHAIN_SHORT_ID` ("optionsscr") with `options-screener` (#4774).
 * 2. `options-chain` runs its 6 stages via `JobPipelineWorkflow` /
 *    `D1JobRunRecordStore`, not `stageRuntimeIds` topic pub/sub, and live
 *    runs already surface in Workflow Runs through `D1JobRunRecordStore`.
 */
describe("#5834 — options-chain workflowCatalog decided-not-to pin", () => {
  it("keeps WORKFLOW_CATALOG at the 7 ruled families with optionsscr owned by chain:optionsscr", () => {
    expect(WORKFLOW_CATALOG).toHaveLength(7);
    expect(workflowById("options-chain")).toBeNull();
    expect(workflowByShortId(OPTIONS_CHAIN_SHORT_ID)?.id).toBe("chain:optionsscr");
  });

  it("preserves the 6-stage options-chain definition outside WORKFLOW_CATALOG", () => {
    expect(OPTIONS_CHAIN_STAGE_KINDS).toEqual([
      "options-chain.feed",
      "options-chain.assemble",
      "options-chain.generate",
      "options-chain.store",
      "options-chain.serve",
      "options-chain.deliver",
    ]);
  });
});
