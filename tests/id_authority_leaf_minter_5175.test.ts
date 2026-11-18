// @vitest-environment node
/**
 * Issue #5175 slice 1 — the one leaf minter (user ruling 2026-11-17,
 * comment 6962347431): `src/services/executionTreeIds.ts` is the
 * single minting authority. One function per id type, one format per
 * type declared as data (`ID_FORMAT_ARITY`), entropy from
 * `crypto.randomUUID()` inside the module only (the run id keeps its
 * adopted `time36-counter36` body). The uniform convention: every
 * generated id is colon-separated segments, the first segment is the
 * type, no body ever contains `:`; fixed arity per type.
 *
 * Pins:
 *  - 5175-S1-P01 every minter mints its canonical format, and minted
 *    ids are unique (100 draws, no collision).
 *  - 5175-S1-P02 the arity table is the grammar as data, and the
 *    parser accepts every canonical shape, round-trips every minted
 *    id, and rejects wrong-arity, unknown-type, retired-namespace,
 *    legacy, and malformed-body ids.
 *  - 5175-S1-P03 derived builders embed BODIES, never full ids, and
 *    the family/level builders accept exactly the ruled sets.
 *  - 5175-S1-P04 the colon-free guard throws on any `:` in a
 *    caller-supplied body part; `chainId` rejects unruled families.
 *  - 5175-S1-P05 the module stays a LEAF: no runtime imports — only
 *    `import type` — and `crypto` is used via the platform global,
 *    never imported.
 *  - 5175-S1-P06 external ids are DECLARED, never minted: the six
 *    recognized sources are listed, and no exported minter exists
 *    for any of them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as leaf from "../src/services/executionTreeIds";
import {
  EXTERNAL_ID_SOURCES,
  FAMILY_SHORT_IDS,
  ID_FORMAT_ARITY,
  assertIdBodyPart,
  chainId,
  deliveryId,
  generationId,
  jobDefinitionId,
  jobInstanceId,
  levelId,
  newAsyncJobId,
  newDidProofId,
  newGoalRecordId,
  newLocalOrderId,
  newPaymentDraftId,
  newPlatformRowId,
  newRunId,
  newScheduleId,
  newTaskProposalId,
  nodeId,
  parseId,
  pipeId,
} from "../src/services/executionTreeIds";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

describe("id authority leaf minter (#5175 slice 1)", () => {
  it("P01: every minter mints its canonical format, uniquely", () => {
    expect(newRunId()).toMatch(/^run:[0-9a-z]+-[0-9a-z]+$/);
    expect(newAsyncJobId()).toMatch(new RegExp(`^job:${UUID_RE}$`));
    expect(newPaymentDraftId()).toMatch(/^pay:[0-9a-f]{8}$/);
    expect(newTaskProposalId()).toMatch(/^task:[0-9a-f]{8}$/);
    expect(newLocalOrderId()).toMatch(/^ord:[0-9a-f]{8}$/);
    expect(newDidProofId()).toMatch(/^proof:[0-9a-f]{12}$/);
    expect(newGoalRecordId()).toMatch(/^goal:[0-9a-z]+-[0-9a-f]{6}$/);
    expect(newScheduleId()).toMatch(new RegExp(`^sched:${UUID_RE}$`));
    expect(newPlatformRowId("report")).toMatch(new RegExp(`^report:${UUID_RE}$`));
    expect(newPlatformRowId("outcome")).toMatch(new RegExp(`^outcome:${UUID_RE}$`));
    expect(newPlatformRowId("audit")).toMatch(new RegExp(`^audit:${UUID_RE}$`));
    // 100 draws from each entropy minter: no collision, including
    // runs minted in the same millisecond (the module counter).
    for (const mint of [
      newRunId,
      newAsyncJobId,
      newPaymentDraftId,
      newTaskProposalId,
      newLocalOrderId,
      newDidProofId,
      newGoalRecordId,
      newScheduleId,
    ]) {
      const drawn = new Set(Array.from({ length: 100 }, () => mint()));
      expect(drawn.size).toBe(100);
    }
  });

  it("P02: the arity table is the grammar, and the parser enforces it", () => {
    expect(ID_FORMAT_ARITY).toEqual({
      chain: 2,
      lvl: 2,
      ooda: 2,
      job: 2,
      pipe: 2,
      run: 2,
      pay: 2,
      task: 2,
      ord: 2,
      proof: 2,
      goal: 2,
      // Issue #5175 slice 3: `scen` / `outc` row ids mint through the
      // leaf (`newPlatformRowId`), and `shard-scan` is adopted into
      // the leaf as a derived builder (same format as before).
      scen: 2,
      outc: 2,
      sched: 2,
      "shard-scan": 3,
      gen: 2,
      report: 2,
      outcome: 2,
      audit: 2,
      node: 3,
      delivery: 3,
      stage: 4,
      trace: 5,
      step: 6,
      event: 7,
    });
    // Every canonical shape parses, with the run body where one is carried.
    const parsed = parseId("run:m9x-1");
    expect(parsed.type).toBe("run");
    expect(parsed.segments).toEqual(["run", "m9x-1"]);
    expect(parsed.runBody).toBe("m9x-1");
    expect(parseId("chain:stockscr").runBody).toBeNull();
    expect(parseId("lvl:run").segments).toEqual(["lvl", "run"]);
    expect(parseId("ooda:observe").segments).toEqual(["ooda", "observe"]);
    expect(parseId("job:screener").runBody).toBeNull();
    expect(parseId("job:550e8400-e29b-41d4-a716-446655440000").runBody).toBeNull();
    expect(parseId("pipe:example-feed-example-dataset").runBody).toBeNull();
    expect(parseId("node:screener:root").runBody).toBeNull();
    expect(parseId("pay:a1b2c3d4").runBody).toBeNull();
    expect(parseId("proof:a1b2c3d4e5f6").runBody).toBeNull();
    expect(parseId("goal:m9x2k-ab12cd").runBody).toBeNull();
    expect(parseId("scen:550e8400-e29b-41d4-a716-446655440000").segments).toEqual([
      "scen",
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
    expect(parseId("outc:550e8400-e29b-41d4-a716-446655440000").segments).toEqual([
      "outc",
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
    expect(parseId("shard-scan:chain-x:AAPL").segments).toEqual([
      "shard-scan",
      "chain-x",
      "AAPL",
    ]);
    expect(parseId("gen:m9x-1").runBody).toBe("m9x-1");
    expect(parseId("delivery:m9x-1:slack-C12345").runBody).toBe("m9x-1");
    expect(parseId("stage:m9x-1:feed:-").runBody).toBe("m9x-1");
    expect(parseId("trace:m9x-1:ooda:observe:2").runBody).toBe("m9x-1");
    expect(parseId("step:m9x-1:root:0:-:-").runBody).toBe("m9x-1");
    expect(parseId("event:m9x-1:feed:-:start:1763419200000:abc123").runBody).toBe("m9x-1");
    // A job-instance id is recognized by shape: <kind>:<runBody>.
    const job = parseId("research:m9x-1");
    expect(job.type).toBe("research");
    expect(job.runBody).toBe("m9x-1");
    expect(parseId("options-chain:m9x-1").runBody).toBe("m9x-1");
    // Every minted id round-trips through the parser.
    for (const id of [
      newRunId(),
      newAsyncJobId(),
      newPaymentDraftId(),
      newTaskProposalId(),
      newLocalOrderId(),
      newDidProofId(),
      newGoalRecordId(),
      newScheduleId(),
      newPlatformRowId("report"),
    ]) {
      expect(parseId(id).segments.join(":")).toBe(id);
    }
    // Rejections: wrong arity, unknown type, retired namespace,
    // legacy spellings, empty segments, malformed bodies.
    for (const bad of [
      "run:m9x-1:extra",
      "run:",
      "run:m9x-1:",
      "stage:m9x-1:feed",
      "step:m9x-1:root:0:-",
      "event:m9x-1:feed:-:start:1763419200000",
      "foo:bar",
      "respipe:observe",
      "rsr_m9x_ab12cd",
      "run-1",
      "screener:1234567890",
      "chain:nope",
      "chain:tradscr",
      "lvl:nope",
      "ooda:jump",
      "pay:xyz",
      "pay:a1b2c3d4e5f6",
      "proof:a1b2c3d4",
      "goal:m9x2k",
      "sched:not-a-uuid",
      "step:m9x-1:root:x:-:-",
      "step:m9x-1:root:0:-:x",
      "trace:m9x-1:ooda:observe:x",
      "event:m9x-1:feed:-:start:notmillis:abc123",
      "delivery:m9x-1",
      "node:screener",
    ]) {
      expect(() => parseId(bad)).toThrow();
    }
  });

  it("P03: derived builders embed bodies, never full ids", () => {
    expect(jobInstanceId("research", "run:m9x-1")).toBe("research:m9x-1");
    expect(jobInstanceId("options-chain", "run:m9x-1")).toBe("options-chain:m9x-1");
    expect(jobInstanceId("strategy-screen", "run:m9x-1")).toBe("strategy-screen:m9x-1");
    expect(jobInstanceId("screener", "run:m9x-1")).toBe("screener:m9x-1");
    expect(generationId("run:m9x-1")).toBe("gen:m9x-1");
    expect(deliveryId("run:m9x-1", "slack-C12345")).toBe("delivery:m9x-1:slack-C12345");
    expect(jobDefinitionId("screener")).toBe("job:screener");
    expect(nodeId("screener", "root")).toBe("node:screener:root");
    expect(pipeId("example-feed", "example-dataset")).toBe("pipe:example-feed-example-dataset");
    // A qualified id passed where a body belongs is refused, not embedded.
    expect(() => nodeId("screener", "job:root")).toThrow();
    expect(() => jobInstanceId("research", "run:m9x-1")).not.toThrow();
    // Families: exactly the nine ruled short ids.
    expect([...FAMILY_SHORT_IDS].sort()).toEqual([
      "feedsrc",
      "goalscr",
      "optionsscr",
      "payrun",
      "resrch",
      "sagarun",
      "stockscr",
      "strategyscr",
      "tradrun",
    ]);
    for (const family of FAMILY_SHORT_IDS) {
      expect(chainId(family)).toBe(`chain:${family}`);
    }
    // Levels: every execution-tree level qualifies as `lvl:<level>`.
    expect(levelId("chain")).toBe("lvl:chain");
    expect(levelId("pipeline")).toBe("lvl:pipe");
    expect(levelId("workflow")).toBe("lvl:wf");
    expect(levelId("job")).toBe("lvl:job");
    expect(levelId("stage")).toBe("lvl:stage");
    expect(levelId("unit")).toBe("lvl:unit");
    expect(levelId("task")).toBe("lvl:task");
    expect(levelId("run")).toBe("lvl:run");
    expect(levelId("txn")).toBe("lvl:txn");
  });

  it("P04: the colon-free guard throws; unruled families are refused", () => {
    expect(() => assertIdBodyPart("", "test")).toThrow();
    expect(() => assertIdBodyPart("a:b", "test")).toThrow();
    expect(() => assertIdBodyPart("fine", "test")).not.toThrow();
    expect(() => jobDefinitionId("a:b")).toThrow();
    expect(() => nodeId("a:b", "root")).toThrow();
    expect(() => nodeId("screener", "a:b")).toThrow();
    expect(() => pipeId("a:b", "dataset")).toThrow();
    expect(() => pipeId("feed", "a:b")).toThrow();
    expect(() => deliveryId("run:m9x-1", "a:b")).toThrow();
    expect(() => jobInstanceId("a:b", "run:m9x-1")).toThrow();
    expect(() => newPlatformRowId("a:b")).toThrow();
    expect(() => chainId("tradscr")).toThrow();
    expect(() => chainId("nope")).toThrow();
  });

  it("P05: the module stays a LEAF — no runtime imports", () => {
    const leafSrc = src("services/executionTreeIds.ts");
    // Every import is `import type` (erased at build); `crypto` is a
    // platform global, never imported.
    const importLines = leafSrc.split("\n").filter((line) => /^\s*import\s/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line.trim().startsWith("import type")).toBe(true);
    }
    expect(leafSrc).not.toContain('from "crypto"');
    expect(leafSrc).not.toContain("require(");
    expect(leafSrc).toContain("crypto.randomUUID()");
  });

  it("P06: external ids are declared, never minted", () => {
    expect(Object.keys(EXTERNAL_ID_SOURCES).sort()).toEqual([
      "gateway_ref",
      "instanceId",
      "order_ref",
      "session_id",
      "spanId",
      "traceId",
    ]);
    const exportedFunctions = Object.keys(leaf).filter(
      (key) => typeof (leaf as Record<string, unknown>)[key] === "function",
    );
    // No minter exists for any recognized external id (exact names —
    // a substring check would false-positive on `jobInstanceId`,
    // the legitimate engine-job builder).
    for (const forbidden of [
      "newGatewayRef",
      "newOrderRef",
      "newInstanceId",
      "newTraceId",
      "newSpanId",
      "newSessionId",
      "gateway_ref",
      "order_ref",
      "instanceId",
      "traceId",
      "spanId",
      "session_id",
    ]) {
      expect(exportedFunctions).not.toContain(forbidden);
    }
    expect(exportedFunctions).toContain("newRunId");
    expect(exportedFunctions).toContain("newAsyncJobId");
    expect(exportedFunctions).toContain("parseId");
  });
});
